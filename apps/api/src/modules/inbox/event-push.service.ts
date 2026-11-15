import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { chapterPushQueue, chapters, stories, users } from '../../db/schema';
import { DbService } from '../../infra/db/db.service';
import { RedisService } from '../../infra/redis/redis.service';
import { WalletService } from '../wallet/wallet.service';
import { InboxService, langOf } from './inbox.service';
import { PushDispatchService } from './push-dispatch.service';
import { isQuietHour, localDate, textsFor } from './push-texts';

/** Chapters published after this instant have been fanned out to followers (Redis state, noeviction). */
const CHAPTER_WATERMARK = 'push:chapters:watermark';
const CHAPTERS_PER_RUN = 500;
const USERS_PER_BATCH = 500;
const EXPIRY_NOTICE_MS = 3 * 86_400_000;
const LOTS_PER_BATCH = 1000;

type UserInfo = { id: string; locale: string; timezone: string; pushUpdates: boolean };

/**
 * Event-driven pushes (worker jobs):
 * - new chapters of favorited stories → ONE digest per user ("3 stories you follow have new chapters"),
 *   sent outside the user's quiet hours (22:00–08:00 local);
 * - coins expiring within 3 days → inbox notice + push, once per lot, outside quiet hours.
 */
@Injectable()
export class EventPushService {
  private readonly logger = new Logger(EventPushService.name);

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly dispatch: PushDispatchService,
    private readonly inbox: InboxService,
    private readonly wallet: WalletService,
  ) {}

  /** Worker job: queue new chapters, then deliver what can be delivered now. */
  async chapterUpdates(now = new Date()): Promise<{ queued: number; pushed: number }> {
    const queued = await this.queueNewChapters(now);
    const pushed = await this.deliverChapterDigests(now);
    return { queued, pushed };
  }

  /** Every chapter published since the watermark → one queue row per follower (INSERT … SELECT, no app-side loop). */
  async queueNewChapters(now = new Date()): Promise<number> {
    const mark = await this.redis.state.get(CHAPTER_WATERMARK);
    if (!mark) {
      // First run: start from now — never push the whole back catalogue.
      await this.redis.state.set(CHAPTER_WATERMARK, now.toISOString());
      return 0;
    }
    const fresh = await this.db.read
      .select({ storyId: chapters.storyId, number: chapters.number, publishedAt: chapters.publishedAt })
      .from(chapters)
      .innerJoin(stories, eq(stories.id, chapters.storyId))
      .where(
        and(
          eq(chapters.status, 'published'),
          // ms precision on both sides (the watermark is a JS date) so the last chapter is never queued twice
          sql`date_trunc('milliseconds', ${chapters.publishedAt}) > ${mark}::timestamptz`,
          lte(chapters.publishedAt, now),
          inArray(stories.status, ['ongoing', 'completed']),
        ),
      )
      .orderBy(asc(chapters.publishedAt))
      .limit(CHAPTERS_PER_RUN);
    for (const c of fresh) {
      await this.db.write.execute(sql`
        insert into ${chapterPushQueue} (user_id, story_id, chapter_number)
        select f.user_id, ${c.storyId}::uuid, ${c.number}::int from favorites f where f.story_id = ${c.storyId}::uuid
        on conflict (user_id, story_id) do update
          set chapter_number = greatest(${chapterPushQueue.chapterNumber}, excluded.chapter_number)`);
    }
    if (fresh.length) await this.redis.state.set(CHAPTER_WATERMARK, fresh.at(-1)!.publishedAt!.toISOString());
    return fresh.length;
  }

  /** Users with queued chapters: digest push (or drop when they opted out / have no device); quiet hours wait. */
  async deliverChapterDigests(now = new Date()): Promise<number> {
    let pushed = 0;
    let after: string | null = null;
    for (;;) {
      const ids = await this.db.read
        .selectDistinct({ userId: chapterPushQueue.userId })
        .from(chapterPushQueue)
        .where(after ? gt(chapterPushQueue.userId, after) : undefined)
        .orderBy(asc(chapterPushQueue.userId))
        .limit(USERS_PER_BATCH);
      if (!ids.length) return pushed;
      after = ids.at(-1)!.userId;
      const userIds = ids.map((r) => r.userId);

      const [rows, people, tokens] = await Promise.all([
        this.db.read
          .select({
            userId: chapterPushQueue.userId,
            storyId: chapterPushQueue.storyId,
            number: chapterPushQueue.chapterNumber,
            title: stories.title,
          })
          .from(chapterPushQueue)
          .innerJoin(stories, eq(stories.id, chapterPushQueue.storyId))
          .where(inArray(chapterPushQueue.userId, userIds))
          .orderBy(asc(chapterPushQueue.queuedAt)),
        this.users(userIds),
        this.dispatch.tokensOf(userIds),
      ]);

      const done: string[] = [];
      const send: { id: string; token: string; userId: string }[] = [];
      for (const userId of userIds) {
        const user = people.get(userId);
        const hasDevice = tokens.some((t) => t.userId === userId);
        if (!user || !user.pushUpdates || !hasDevice)
          done.push(userId); // nothing to send: drop the queue rows
        else if (!isQuietHour(user.timezone, now)) {
          done.push(userId);
          send.push(...tokens.filter((t) => t.userId === userId));
        }
      }
      if (send.length) {
        const result = await this.dispatch.send(send, (t) => {
          const user = people.get(t.userId)!;
          const mine = rows.filter((r) => r.userId === t.userId);
          const texts = textsFor(langOf(user.locale));
          const message =
            mine.length === 1
              ? texts.newChapter(mine[0]!.title, mine[0]!.number)
              : texts.newChapters(
                  mine.length,
                  mine.map((r) => r.title),
                );
          return {
            ...message,
            data:
              mine.length === 1 ? { type: 'story', storyId: mine[0]!.storyId } : { type: 'screen', screen: 'library' },
          };
        });
        pushed += result.sent;
      }
      if (done.length) await this.db.write.delete(chapterPushQueue).where(inArray(chapterPushQueue.userId, done));
    }
  }

  /** Worker job: "N coins expire on <date>" — inbox + push, once per lot, outside quiet hours. */
  async coinExpiryNotices(now = new Date()): Promise<number> {
    const until = new Date(now.getTime() + EXPIRY_NOTICE_MS);
    let notified = 0;
    let after: string | null = null;
    for (;;) {
      const lots = await this.wallet.expiryWarningsDue(now, until, after, LOTS_PER_BATCH);
      if (!lots.length) return notified;
      after = lots.at(-1)!.id;

      const byUser = new Map<string, { lotIds: string[]; amount: number; expiresAt: Date }>();
      for (const lot of lots) {
        const acc = byUser.get(lot.userId) ?? { lotIds: [], amount: 0, expiresAt: lot.expiresAt! };
        acc.lotIds.push(lot.id);
        acc.amount += lot.amount;
        if (lot.expiresAt! < acc.expiresAt) acc.expiresAt = lot.expiresAt!;
        byUser.set(lot.userId, acc);
      }
      const people = await this.users([...byUser.keys()]);
      const ready = [...byUser].filter(([userId]) => {
        const u = people.get(userId);
        return u && !isQuietHour(u.timezone, now); // quiet hours: stays unannounced, next run picks it up
      });
      for (const [userId, info] of ready) {
        const user = people.get(userId)!;
        const lang = langOf(user.locale);
        const text = textsFor(lang).coinsExpiring(info.amount, localDate(info.expiresAt, lang, user.timezone));
        await this.inbox.notify(userId, {
          tab: 'reward',
          title: text.title,
          body: text.body,
          action: { type: 'screen', screen: 'wallet' },
        });
      }
      const readyIds = ready.map(([userId]) => userId);
      const tokens = await this.dispatch.tokensOf(readyIds);
      if (tokens.length) {
        await this.dispatch.send(tokens, (t) => {
          const info = byUser.get(t.userId)!;
          const user = people.get(t.userId)!;
          const lang = langOf(user.locale);
          return {
            ...textsFor(lang).coinsExpiring(info.amount, localDate(info.expiresAt, lang, user.timezone)),
            data: { type: 'screen', screen: 'wallet' },
          };
        });
      }
      // Suspended / deleted accounts: mark too (no notice), or they would be re-checked on every run.
      const gone = [...byUser].filter(([userId]) => !people.has(userId));
      await this.wallet.markExpiryWarned(
        [...ready, ...gone].flatMap(([, info]) => info.lotIds),
        now,
      );
      notified += ready.length;
      this.logger.debug(`coin expiry notices: ${ready.length} users`);
    }
  }

  private async users(ids: string[]): Promise<Map<string, UserInfo>> {
    if (!ids.length) return new Map();
    const rows = await this.db.read
      .select({ id: users.id, locale: users.locale, timezone: users.timezone, pushUpdates: users.pushUpdates })
      .from(users)
      .where(and(inArray(users.id, ids), eq(users.status, 'active')));
    return new Map(rows.map((r) => [r.id, r]));
  }
}
