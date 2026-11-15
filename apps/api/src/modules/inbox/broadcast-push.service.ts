import { Injectable, Logger } from '@nestjs/common';
import type { BroadcastAudience, PushResult } from '@storyzio/contracts';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { broadcasts, entitlements, pushTokens, sessions, users } from '../../db/schema';
import { DbService } from '../../infra/db/db.service';
import { PUSH_BATCH } from '../../infra/push/push';
import { langOf, localized } from './inbox.service';
import { PushDispatchService } from './push-dispatch.service';

type BroadcastRow = typeof broadcasts.$inferSelect;
/** A "sending" broadcast untouched this long is assumed crashed and resumed from its cursor. */
const STALE_SEND = sql`interval '5 minutes'`;

/**
 * Push fan-out for broadcasts (worker job). Tokens are walked in id order in batches of 100; progress (cursor +
 * counters) is saved after every batch, so a crash resumes instead of re-sending. Cancel stops it between batches.
 */
@Injectable()
export class BroadcastPushService {
  private readonly logger = new Logger(BroadcastPushService.name);

  constructor(
    private readonly db: DbService,
    private readonly dispatch: PushDispatchService,
  ) {}

  /** Sends every due broadcast push. Returns how many broadcasts were completed. */
  async runDue(): Promise<number> {
    let done = 0;
    for (let b = await this.claim(); b; b = await this.claim()) {
      await this.send(b);
      done++;
    }
    return done;
  }

  /** How many push tokens the audience reaches right now (admin preview). */
  async estimate(audience: BroadcastAudience, kind: BroadcastRow['kind']): Promise<number> {
    const [row] = await this.db.read
      .select({ n: sql<number>`count(*)::int` })
      .from(pushTokens)
      .innerJoin(users, eq(users.id, pushTokens.userId))
      .where(audienceWhere(audience, kind));
    return row?.n ?? 0;
  }

  /** Admin "send test": this broadcast to one user's devices only (ignores audience and opt-out). */
  async sendTest(b: BroadcastRow, userId: string): Promise<PushResult> {
    const rows = await this.db.read
      .select({ id: pushTokens.id, token: pushTokens.token, locale: users.locale })
      .from(pushTokens)
      .innerJoin(users, eq(users.id, pushTokens.userId))
      .where(eq(pushTokens.userId, userId))
      .limit(PUSH_BATCH);
    return this.deliver(b, rows);
  }

  private async claim(): Promise<BroadcastRow | undefined> {
    const { rows } = await this.db.write.execute<{ id: string }>(sql`
      update ${broadcasts} set push_status = 'sending', updated_at = now()
      where id = (
        select id from ${broadcasts}
        where push and canceled_at is null and publish_at <= now()
          and (push_status = 'pending' or (push_status = 'sending' and updated_at < now() - ${STALE_SEND}))
        order by publish_at
        limit 1
        for update skip locked
      )
      returning id`);
    if (!rows[0]) return undefined;
    const [b] = await this.db.write.select().from(broadcasts).where(eq(broadcasts.id, rows[0].id));
    return b;
  }

  private async send(b: BroadcastRow): Promise<void> {
    let cursor = b.pushCursor;
    const expired = b.expiresAt !== null && b.expiresAt <= new Date();
    while (!expired) {
      const [current] = await this.db.write
        .select({ canceledAt: broadcasts.canceledAt })
        .from(broadcasts)
        .where(eq(broadcasts.id, b.id));
      if (!current || current.canceledAt) break;

      const batch = await this.db.read
        .select({ id: pushTokens.id, token: pushTokens.token, locale: users.locale })
        .from(pushTokens)
        .innerJoin(users, eq(users.id, pushTokens.userId))
        .where(and(audienceWhere(b.audience, b.kind), cursor ? gt(pushTokens.id, cursor) : undefined))
        .orderBy(asc(pushTokens.id))
        .limit(PUSH_BATCH);
      if (!batch.length) break;

      const result = await this.deliver(b, batch);
      cursor = batch.at(-1)!.id;
      await this.db.write
        .update(broadcasts)
        .set({
          pushCursor: cursor,
          pushSent: sql`${broadcasts.pushSent} + ${result.sent}`,
          pushFailed: sql`${broadcasts.pushFailed} + ${result.failed}`,
        })
        .where(eq(broadcasts.id, b.id));
      if (batch.length < PUSH_BATCH) break;
    }
    await this.db.write.update(broadcasts).set({ pushStatus: 'sent' }).where(eq(broadcasts.id, b.id));
    this.logger.log(`broadcast ${b.id} push finished`);
  }

  private deliver(b: BroadcastRow, rows: { id: string; token: string; locale: string }[]): Promise<PushResult> {
    return this.dispatch.send(rows, (r) => ({
      title: localized(b.title, langOf(r.locale)),
      body: localized(b.body, langOf(r.locale)),
      data: { broadcastId: b.id, action: b.action },
    }));
  }
}

/** Push audience as SQL over push_tokens ⋈ users. */
function audienceWhere(a: BroadcastAudience, kind: BroadcastRow['kind']): SQL | undefined {
  return and(
    eq(users.status, 'active'),
    kind === 'marketing' ? eq(users.pushMarketing, true) : undefined,
    a.langs ? inArray(sql`split_part(replace(lower(${users.locale}), '_', '-'), '-', 1)`, a.langs) : undefined,
    a.platforms ? inArray(pushTokens.platform, a.platforms) : undefined,
    a.premium
      ? sql`${a.premium === 'only' ? sql`exists` : sql`not exists`} (select 1 from ${entitlements} e
          where e.user_id = ${users.id} and e.key = 'premium' and e.expires_at > now())`
      : undefined,
    a.inactiveDays
      ? sql`not exists (select 1 from ${sessions} s where s.user_id = ${users.id}
          and s.last_seen_at > now() - make_interval(days => ${a.inactiveDays}))`
      : undefined,
  );
}
