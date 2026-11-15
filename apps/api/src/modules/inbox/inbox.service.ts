import { Injectable } from '@nestjs/common';
import type {
  BroadcastAudience,
  InboxAction,
  InboxItem,
  InboxPage,
  InboxQuery,
  InboxReadRequest,
  InboxTab,
  Lang,
  NotificationSettings,
  NotificationSettingsPatch,
  PushTokenRequest,
} from '@storyzio/contracts';
import { and, count, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, encodeCursor, splitPage } from '../../common/http/cursor';
import {
  broadcastReads,
  broadcasts,
  notifications,
  pushTokens,
  sessions,
  userInboxState,
  users,
} from '../../db/schema';
import { CacheService } from '../../infra/cache/cache.service';
import { DbService, type Tx } from '../../infra/db/db.service';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { EntitlementsService } from '../premium/entitlements.service';

const KeysetCursor = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);
export const LIVE_BROADCASTS_KEY = 'c:broadcasts:live';
const LIVE_TTL_SEC = 60;
/** Cached list also holds broadcasts starting within this window, so they appear on time. */
const LOOKAHEAD_MS = 2 * LIVE_TTL_SEC * 1000;
const unreadKey = (userId: string) => `c:unread:${userId}`;

type I18n = Partial<Record<Lang, string>>;
type LiveBroadcast = {
  id: string;
  tab: InboxTab;
  title: I18n;
  body: I18n;
  icon: string | null;
  action: InboxAction | null;
  audience: BroadcastAudience;
  publishAt: string;
  expiresAt: string | null;
};
type Viewer = { userId: string; lang: string; platform: string | null; premium: boolean; readAllBefore: Date };

/** Orders (ISO time, id) keys; ISO strings in UTC compare correctly as text. */
const compareKeys = (a: [string, string], b: [string, string]) =>
  a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;

/** `vi-VN` → `vi`; text falls back to English. */
export const langOf = (locale: string) => locale.split(/[-_]/)[0]!.toLowerCase();
export const localized = (text: I18n, lang: string) => text[lang as Lang] ?? text.en ?? Object.values(text)[0] ?? '';

/** Inbox audience rules (inactiveDays is for push only). */
export function matchesAudience(a: BroadcastAudience, v: Pick<Viewer, 'lang' | 'platform' | 'premium'>) {
  if (a.langs && !a.langs.includes(v.lang as Lang)) return false;
  if (a.platforms && (!v.platform || !a.platforms.includes(v.platform as never))) return false;
  if (a.premium === 'only' && !v.premium) return false;
  if (a.premium === 'exclude' && v.premium) return false;
  return true;
}

export type NewNotification = {
  tab: InboxTab;
  title: string;
  body: string;
  icon?: string | null;
  action?: InboxAction | null;
};

/**
 * One inbox per user = personal notifications ∪ broadcasts, merged by time at read time. Broadcasts are stored once,
 * so announcing to millions of users is one row, not millions.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly entitlements: EntitlementsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** For other modules (rewards, wallet expiry, …). Pass `tx` to commit it with the change it describes. */
  async notify(userId: string, n: NewNotification, tx?: Tx): Promise<void> {
    await (tx ?? this.db.write).insert(notifications).values({ userId, ...n });
    await this.cache.del(unreadKey(userId));
  }

  async list(auth: AuthContext, q: InboxQuery): Promise<InboxPage> {
    const after = q.cursor ? (decodeCursor(q.cursor, KeysetCursor) as [string, string]) : null;
    const viewer = await this.viewer(auth);
    const personal = await this.db.read
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, auth.userId),
          q.tab ? eq(notifications.tab, q.tab) : undefined,
          after
            ? sql`(${notifications.createdAt}, ${notifications.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(q.limit + 1);

    const candidates = (await this.visibleFor(viewer))
      .filter((b) => !q.tab || b.tab === q.tab)
      .filter((b) => !after || compareKeys([b.publishAt, b.id], [new Date(after[0]).toISOString(), after[1]]) < 0);
    const opened = await this.openedIds(
      auth.userId,
      candidates.slice(0, q.limit + 1).map((b) => b.id),
    );

    const merged: (InboxItem & { sortKey: [string, string] })[] = [
      ...personal.map((n) => ({
        id: n.id,
        source: 'personal' as const,
        tab: n.tab,
        title: n.title,
        body: n.body,
        icon: n.icon,
        action: n.action,
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
        sortKey: [n.createdAt.toISOString(), n.id] as [string, string],
      })),
      ...candidates.slice(0, q.limit + 1).map((b) => ({
        id: b.id,
        source: 'broadcast' as const,
        tab: b.tab,
        title: localized(b.title, viewer.lang),
        body: localized(b.body, viewer.lang),
        icon: b.icon,
        action: b.action,
        read: new Date(b.publishAt) <= viewer.readAllBefore || opened.has(b.id),
        createdAt: b.publishAt,
        sortKey: [b.publishAt, b.id] as [string, string],
      })),
    ].sort((x, y) => compareKeys(y.sortKey, x.sortKey)); // newest first

    const { items, hasMore } = splitPage(merged, q.limit);
    const last = items.at(-1);
    return {
      items: items.map(({ sortKey: _k, ...item }) => item),
      nextCursor: hasMore && last ? encodeCursor(last.sortKey) : null,
    };
  }

  async markRead(userId: string, req: InboxReadRequest): Promise<void> {
    if ('all' in req) {
      const now = new Date();
      await this.db.write.transaction(async (tx) => {
        await tx
          .update(notifications)
          .set({ readAt: now })
          .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
        await tx
          .insert(userInboxState)
          .values({ userId, readAllBefore: now })
          .onConflictDoUpdate({ target: userInboxState.userId, set: { readAllBefore: now } });
      });
    } else {
      const personal = req.items.filter((i) => i.source === 'personal').map((i) => i.id);
      const opened = req.items.filter((i) => i.source === 'broadcast').map((i) => i.id);
      if (personal.length) {
        await this.db.write
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(eq(notifications.userId, userId), inArray(notifications.id, personal), isNull(notifications.readAt)),
          );
      }
      if (opened.length) {
        // Only broadcasts that exist (ids come from the client).
        const existing = await this.db.read
          .select({ id: broadcasts.id })
          .from(broadcasts)
          .where(inArray(broadcasts.id, opened));
        if (existing.length) {
          await this.db.write
            .insert(broadcastReads)
            .values(existing.map((b) => ({ broadcastId: b.id, userId })))
            .onConflictDoNothing();
        }
      }
    }
    await this.cache.del(unreadKey(userId));
  }

  /** Badge count (cached 60 s; dropped on read / new personal item). */
  async unreadCount(auth: AuthContext): Promise<{ count: number }> {
    return this.cache.getOrSet(unreadKey(auth.userId), LIVE_TTL_SEC, async () => {
      const viewer = await this.viewer(auth);
      const [[personal], live] = await Promise.all([
        this.db.read
          .select({ n: count() })
          .from(notifications)
          .where(and(eq(notifications.userId, auth.userId), isNull(notifications.readAt))),
        this.visibleFor(viewer),
      ]);
      const unseen = live.filter((b) => new Date(b.publishAt) > viewer.readAllBefore);
      const opened = await this.openedIds(
        auth.userId,
        unseen.map((b) => b.id),
      );
      return { count: personal!.n + unseen.filter((b) => !opened.has(b.id)).length };
    });
  }

  // ---------- push tokens & settings ----------

  /** The token moves to the signed-in user (same device, new account). */
  async registerToken(userId: string, req: PushTokenRequest): Promise<void> {
    await this.rateLimit.consume('push-token', userId, 20, 3600);
    await this.db.write
      .insert(pushTokens)
      .values({ userId, token: req.token, platform: req.platform })
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: { userId, platform: req.platform, updatedAt: new Date() },
      });
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await this.db.write.delete(pushTokens).where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));
  }

  async settings(userId: string): Promise<NotificationSettings> {
    const [row] = await this.db.read
      .select({ marketing: users.pushMarketing, updates: users.pushUpdates })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) throw new AppError('UNAUTHENTICATED');
    return row;
  }

  async updateSettings(userId: string, patch: NotificationSettingsPatch): Promise<NotificationSettings> {
    const set = {
      ...(patch.marketing !== undefined ? { pushMarketing: patch.marketing } : {}),
      ...(patch.updates !== undefined ? { pushUpdates: patch.updates } : {}),
    };
    if (Object.keys(set).length) await this.db.write.update(users).set(set).where(eq(users.id, userId));
    return this.settings(userId);
  }

  // ---------- internals ----------

  /** Published, not canceled, not expired broadcasts (plus those starting in the next minutes), newest first. */
  private liveBroadcasts(): Promise<LiveBroadcast[]> {
    return this.cache.getOrSet(LIVE_BROADCASTS_KEY, LIVE_TTL_SEC, async () => {
      const now = new Date();
      const rows = await this.db.read
        .select()
        .from(broadcasts)
        .where(
          and(
            isNull(broadcasts.canceledAt),
            lte(broadcasts.publishAt, new Date(now.getTime() + LOOKAHEAD_MS)),
            or(isNull(broadcasts.expiresAt), gt(broadcasts.expiresAt, now)),
          ),
        )
        .orderBy(desc(broadcasts.publishAt), desc(broadcasts.id))
        .limit(200);
      return rows.map((b) => ({
        id: b.id,
        tab: b.tab,
        title: b.title,
        body: b.body,
        icon: b.icon,
        action: b.action,
        audience: b.audience,
        publishAt: b.publishAt!.toISOString(),
        expiresAt: b.expiresAt?.toISOString() ?? null,
      }));
    });
  }

  private async visibleFor(viewer: Viewer): Promise<LiveBroadcast[]> {
    const now = new Date().toISOString();
    return (await this.liveBroadcasts()).filter(
      (b) => b.publishAt <= now && (!b.expiresAt || b.expiresAt > now) && matchesAudience(b.audience, viewer),
    );
  }

  private async viewer(auth: AuthContext): Promise<Viewer> {
    const [[user], [session], [state], premium] = await Promise.all([
      this.db.read
        .select({ locale: users.locale, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.id, auth.userId)),
      this.db.read.select({ platform: sessions.platform }).from(sessions).where(eq(sessions.id, auth.sessionId)),
      this.db.read
        .select({ readAllBefore: userInboxState.readAllBefore })
        .from(userInboxState)
        .where(eq(userInboxState.userId, auth.userId)),
      this.entitlements.hasPremium(auth.userId),
    ]);
    if (!user) throw new AppError('UNAUTHENTICATED');
    return {
      userId: auth.userId,
      lang: langOf(user.locale),
      platform: session?.platform ?? null,
      premium,
      // Broadcasts from before the account existed show as already read.
      readAllBefore: state?.readAllBefore ?? user.createdAt,
    };
  }

  private async openedIds(userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db.read
      .select({ id: broadcastReads.broadcastId })
      .from(broadcastReads)
      .where(and(eq(broadcastReads.userId, userId), inArray(broadcastReads.broadcastId, ids)));
    return new Set(rows.map((r) => r.id));
  }
}
