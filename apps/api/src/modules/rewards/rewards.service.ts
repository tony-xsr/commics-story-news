import { Injectable, Logger } from '@nestjs/common';
import type {
  BadgeView,
  CheckinResult,
  CheckinState,
  LevelState,
  ReadingTimeRequest,
  ReadingTimeResult,
  RewardResult,
  TasksState,
} from '@storyzio/contracts';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { AuthContext } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { checkins, sessions, taskClaims, userBadges, userStats, users } from '../../db/schema';
import { CacheService } from '../../infra/cache/cache.service';
import { DbService, type Tx } from '../../infra/db/db.service';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { drainHash, requeueCounter } from '../../infra/redis/drain-hash';
import { RedisService } from '../../infra/redis/redis.service';
import { InboxService, langOf, localized } from '../inbox/inbox.service';
import { textsFor } from '../inbox/push-texts';
import { EntitlementsService } from '../premium/entitlements.service';
import { StoriesService } from '../stories/stories.service';
import { WalletService } from '../wallet/wallet.service';
import { BADGE_EVAL_QUEUE, enqueueBadgeEval } from './eval-queue';
import { RewardsConfigService } from './rewards-config.service';
import { addDays, isNight, localDay, nextStreak, weekdayIndex } from './user-day';

const XP_PENDING = 'xp:pending';
const readtimeKey = (userId: string, day: string) => `readtime:${userId}:${day}`;
const beatKey = (userId: string) => `readbeat:${userId}`;
const deviceKey = (deviceId: string, day: string) => `rewards:device:${deviceId}:${day}`;
const TZ_CHANGE_MS = 7 * 86_400_000;
const STREAK_MILESTONES = [7, 14, 30, 60, 100, 365];
/** Grace on top of wall-clock time between heartbeats (network jitter). */
const BEAT_SLACK_SEC = 5;
const FIRST_BEAT_MAX_SEC = 30;

type Profile = { timezone: string; locale: string; isGuest: boolean };

/**
 * Rewards: reading-time tasks, daily check-in, badges, levels. Days are the user's local days (stored zone, server
 * clock). Points go through WalletService with per-reward idempotency keys, so retries never pay twice.
 */
@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    private readonly config: RewardsConfigService,
    private readonly wallet: WalletService,
    private readonly entitlements: EntitlementsService,
    private readonly stories: StoriesService,
    private readonly inbox: InboxService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ---------- reading time (heartbeat from the reader, every ~30 s) ----------

  /**
   * Credits reading seconds, clamped to the real time since the previous heartbeat (a client can't send 2 hours at
   * once). Everything stays in Redis; the DB is touched at most once per user per day (streak / night counters).
   */
  async readingTime(userId: string, req: ReadingTimeRequest, now = new Date()): Promise<ReadingTimeResult> {
    await this.rateLimit.consume('reading-beat', userId, 6, 60);
    if (!(await this.stories.chapter(req.chapterId))) throw new AppError('NOT_FOUND', 'Chapter not found');
    const profile = await this.profile(userId);
    const day = localDay(profile.timezone, now);

    const last = await this.redis.state.getset(beatKey(userId), String(now.getTime()));
    await this.redis.state.expire(beatKey(userId), 600);
    const elapsed = last ? (now.getTime() - Number(last)) / 1000 + BEAT_SLACK_SEC : FIRST_BEAT_MAX_SEC;
    const credited = Math.max(0, Math.floor(Math.min(req.seconds, elapsed)));

    const total = await this.redis.state.incrby(readtimeKey(userId, day), credited);
    await this.redis.state.expire(readtimeKey(userId, day), 2 * 86_400);
    const before = Math.floor((total - credited) / 60);
    const after = Math.floor(total / 60);
    if (after > before) {
      const { config } = await this.config.get();
      await this.redis.state.hincrby(XP_PENDING, userId, (after - before) * config.xpPerReadingMinute);
    }
    // First reading of the day (and first at night): streak counters, once per day.
    if (credited > 0 && (await this.redis.state.set(`readday:${userId}:${day}`, '1', 'EX', 2 * 86_400, 'NX'))) {
      await this.recordReadDay(userId, day);
    }
    if (
      credited > 0 &&
      isNight(profile.timezone, now) &&
      (await this.redis.state.set(`readnight:${userId}:${day}`, '1', 'EX', 2 * 86_400, 'NX'))
    ) {
      await this.recordNightRead(userId, day);
    }
    return { day, minutesRead: after };
  }

  // ---------- tasks ----------

  async tasks(userId: string, now = new Date()): Promise<TasksState> {
    const [profile, { tasks }] = await Promise.all([this.profile(userId), this.config.get()]);
    const day = localDay(profile.timezone, now);
    const [seconds, claimed] = await Promise.all([
      this.redis.state.get(readtimeKey(userId, day)),
      this.db.read
        .select({ taskId: taskClaims.taskId })
        .from(taskClaims)
        .where(and(eq(taskClaims.userId, userId), eq(taskClaims.day, day))),
    ]);
    const minutesRead = Math.floor(Number(seconds ?? 0) / 60);
    const claimedIds = new Set(claimed.map((c) => c.taskId));
    return {
      day,
      minutesRead,
      tasks: tasks
        .filter((t) => t.active)
        .map((t) => ({
          id: t.id,
          minutes: t.minutes,
          points: t.points,
          completed: minutesRead >= t.minutes,
          claimed: claimedIds.has(t.id),
        })),
    };
  }

  async claimTask(auth: AuthContext, taskId: string, now = new Date()): Promise<RewardResult> {
    const profile = await this.assertCanCollect(auth, now);
    const day = localDay(profile.timezone, now);
    const { tasks, taskBonus } = await this.config.get();
    const task = tasks.find((t) => t.id === taskId && t.active);
    if (!task) throw new AppError('NOT_FOUND', 'Task not found');
    const minutes = Math.floor(Number((await this.redis.state.get(readtimeKey(auth.userId, day))) ?? 0) / 60);
    if (minutes < task.minutes) throw new AppError('VALIDATION', `Read ${task.minutes} minutes today first`);

    const premium = (await this.entitlements.get(auth.userId)).premium;
    const bonus = premium?.plan ? (taskBonus[premium.plan] ?? 0) : 0;
    const points = Math.floor((task.points * (100 + bonus)) / 100);
    await this.wallet.transaction(async (tx) => {
      const [row] = await tx
        .insert(taskClaims)
        .values({ userId: auth.userId, taskId, day, points })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new AppError('CONFLICT', 'Already claimed today');
      await this.creditPoints(tx, auth.userId, points, 'task', `task:${auth.userId}:${taskId}:${day}`);
    });
    return { points, balance: await this.pointsBalance(auth.userId) };
  }

  // ---------- check-in ----------

  async checkinState(userId: string, now = new Date()): Promise<CheckinState> {
    const [profile, { config }] = await Promise.all([this.profile(userId), this.config.get()]);
    const today = localDay(profile.timezone, now);
    const monday = addDays(today, -weekdayIndex(today));
    const [rows, [stats], [user]] = await Promise.all([
      this.db.read
        .select({ day: checkins.day })
        .from(checkins)
        .where(and(eq(checkins.userId, userId), gte(checkins.day, addDays(monday, -77)), lte(checkins.day, today))),
      this.db.read.select().from(userStats).where(eq(userStats.userId, userId)),
      this.db.read.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)),
    ]);
    const done = new Set(rows.map((r) => r.day));
    // A streak is "alive" if the last check-in was today or yesterday.
    const alive = stats?.lastCheckinDay === today || stats?.lastCheckinDay === addDays(today, -1);
    const streak = alive ? stats!.checkinStreak : 0;
    return {
      today,
      checkedIn: done.has(today),
      streak,
      week: Array.from({ length: 7 }, (_, i) => {
        const day = addDays(monday, i);
        return { day, points: config.checkinWeekPoints[i] ?? 0, checkedIn: done.has(day), isToday: day === today };
      }),
      nextMilestone: STREAK_MILESTONES.find((m) => m > streak) ?? null,
      checkedDays: [...done].sort(),
      since: user ? localDay(profile.timezone, user.createdAt) : today,
    };
  }

  async checkin(auth: AuthContext, now = new Date()): Promise<CheckinResult> {
    const profile = await this.assertCanCollect(auth, now);
    const day = localDay(profile.timezone, now);
    const { config } = await this.config.get();
    const points = config.checkinWeekPoints[weekdayIndex(day)] ?? 0;

    const unlocked = await this.wallet.transaction(async (tx) => {
      const [stats] = await tx
        .insert(userStats)
        .values({ userId: auth.userId })
        .onConflictDoUpdate({ target: userStats.userId, set: { updatedAt: new Date() } })
        .returning();
      const streak = nextStreak(stats!.lastCheckinDay, stats!.checkinStreak, day);
      const [row] = await tx
        .insert(checkins)
        .values({ userId: auth.userId, day, points, streak })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new AppError('CONFLICT', 'Already checked in today');
      await tx
        .update(userStats)
        .set({
          lastCheckinDay: day,
          checkinStreak: streak,
          longestCheckinStreak: Math.max(stats!.longestCheckinStreak, streak),
        })
        .where(eq(userStats.userId, auth.userId));
      if (points > 0) await this.creditPoints(tx, auth.userId, points, 'checkin', `checkin:${auth.userId}:${day}`);
      return this.evaluateInTx(tx, auth.userId, profile.locale);
    });
    if (config.xpPerCheckin) await this.redis.state.hincrby(XP_PENDING, auth.userId, config.xpPerCheckin);
    return {
      points,
      balance: await this.pointsBalance(auth.userId),
      state: await this.checkinState(auth.userId, now),
      unlocked,
    };
  }

  // ---------- badges ----------

  async badges(userId: string): Promise<{ items: BadgeView[]; metrics: Record<string, number> }> {
    const [profile, { badges }, metrics, owned] = await Promise.all([
      this.profile(userId),
      this.config.get(),
      this.metrics(this.db.read, userId),
      this.db.read.select().from(userBadges).where(eq(userBadges.userId, userId)),
    ]);
    const lang = langOf(profile.locale);
    const mine = new Map(owned.map((b) => [b.badgeId, b]));
    return {
      metrics,
      items: badges
        .filter((b) => b.active || mine.has(b.id))
        .map((b) => {
          const got = mine.get(b.id);
          return {
            id: b.id,
            title: localized(b.title, lang),
            description: localized(b.description, lang),
            points: b.points,
            imageUrl: b.imageUrl,
            imageDisabledUrl: b.imageDisabledUrl,
            unlocked: !!got,
            unlockedAt: got?.unlockedAt.toISOString() ?? null,
            seen: !!got?.seenAt,
            progress: { current: Math.min(metrics[b.metric] ?? 0, b.threshold), target: b.threshold },
          };
        }),
    };
  }

  async markBadgeSeen(userId: string, badgeId: string): Promise<void> {
    await this.db.write
      .update(userBadges)
      .set({ seenAt: new Date() })
      .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId)));
  }

  /** Worker job: evaluate users whose progress changed (reading, favorites…). */
  async evaluatePending(batch = 500): Promise<number> {
    const ids = (await this.redis.state.spop(BADGE_EVAL_QUEUE, batch)) as string[];
    for (const userId of ids) {
      try {
        const profile = await this.profile(userId);
        await this.db.write.transaction((tx) => this.evaluateInTx(tx, userId, profile.locale));
      } catch (err) {
        this.logger.warn(`badge evaluation for ${userId} failed: ${String(err)}`);
        await enqueueBadgeEval(this.redis.state, userId);
      }
    }
    return ids.length;
  }

  /** Grants every badge whose rule is met and the user doesn't have: points + inbox notice. Returns the new ones. */
  private async evaluateInTx(tx: Tx, userId: string, locale: string): Promise<BadgeView[]> {
    const { badges } = await this.config.get();
    const [metrics, owned] = await Promise.all([
      this.metrics(tx, userId),
      tx.select({ id: userBadges.badgeId }).from(userBadges).where(eq(userBadges.userId, userId)),
    ]);
    const have = new Set(owned.map((o) => o.id));
    const earned = badges.filter((b) => b.active && !have.has(b.id) && (metrics[b.metric] ?? 0) >= b.threshold);
    if (!earned.length) return [];
    const inserted = await tx
      .insert(userBadges)
      .values(earned.map((b) => ({ userId, badgeId: b.id })))
      .onConflictDoNothing()
      .returning({ id: userBadges.badgeId, unlockedAt: userBadges.unlockedAt });
    const lang = langOf(locale);
    const views: BadgeView[] = [];
    for (const row of inserted) {
      const b = earned.find((x) => x.id === row.id)!;
      if (b.points > 0) await this.creditPoints(tx, userId, b.points, 'badge', `badge:${userId}:${b.id}`);
      const title = localized(b.title, lang);
      await this.inbox.notify(
        userId,
        {
          tab: 'reward',
          title: lang === 'vi' ? `Huy hiệu mới: ${title}` : `New badge: ${title}`,
          body: localized(b.description, lang),
          icon: `badge:${b.id}`,
        },
        tx,
      );
      views.push({
        id: b.id,
        title,
        description: localized(b.description, lang),
        points: b.points,
        imageUrl: b.imageUrl,
        imageDisabledUrl: b.imageDisabledUrl,
        unlocked: true,
        unlockedAt: row.unlockedAt.toISOString(),
        seen: false,
        progress: { current: b.threshold, target: b.threshold },
      });
    }
    return views;
  }

  /** Badge metrics: counters from user_stats + counts over library tables (indexed by user). */
  private async metrics(db: DbService['read'] | Tx, userId: string): Promise<Record<string, number>> {
    const { rows } = await db.execute<Record<string, number>>(sql`
      select
        (select count(*)::int from reading_progress where user_id = ${userId}) as stories_read,
        (select count(*)::int from reading_progress rp join stories s on s.id = rp.story_id
          where rp.user_id = ${userId} and s.status = 'completed'
            and rp.chapter_number >= s.chapter_count and rp.position >= 0.9) as stories_completed,
        (select count(distinct sg.genre_id)::int from reading_progress rp
          join story_genres sg on sg.story_id = rp.story_id where rp.user_id = ${userId}) as genres_explored,
        (select count(*)::int from favorites where user_id = ${userId}) as favorites,
        coalesce((select night_read_days from user_stats where user_id = ${userId}), 0) as night_reads,
        coalesce((select longest_reading_streak from user_stats where user_id = ${userId}), 0) as reading_streak,
        coalesce((select longest_checkin_streak from user_stats where user_id = ${userId}), 0) as checkin_streak,
        (select count(*)::int from entitlements where user_id = ${userId} and key = 'premium' and expires_at > now())
          as premium`);
    return rows[0] ?? {};
  }

  // ---------- levels ----------

  async level(userId: string): Promise<LevelState> {
    const [[user], { levels }] = await Promise.all([
      this.db.read.select({ level: users.level, xp: users.xp }).from(users).where(eq(users.id, userId)),
      this.config.get(),
    ]);
    if (!user) throw new AppError('UNAUTHENTICATED');
    return { level: user.level, xp: user.xp, next: levels.find((l) => l.level === user.level + 1) ?? null, levels };
  }

  /** Worker job: apply pending XP; level-ups credit the level's points (once per level) and notify. */
  async flushXp(): Promise<number> {
    return drainHash(
      this.redis.state,
      XP_PENDING,
      async (entries) => {
        const { levels } = await this.config.get();
        for (const [userId, delta] of entries) {
          const n = Number(delta);
          if (!n) continue;
          await this.db.write.transaction(async (tx) => {
            const [u] = await tx
              .update(users)
              .set({ xp: sql`${users.xp} + ${n}` })
              .where(eq(users.id, userId))
              .returning({ xp: users.xp, level: users.level, locale: users.locale });
            if (!u) return;
            const reached = levels.filter((l) => l.level > u.level && u.xp >= l.xpNeeded);
            if (!reached.length) return;
            const top = reached.at(-1)!.level;
            await tx.update(users).set({ level: top }).where(eq(users.id, userId));
            for (const l of reached) {
              if (l.points > 0) await this.creditPoints(tx, userId, l.points, 'level', `level:${userId}:${l.level}`);
            }
            await this.inbox.notify(
              userId,
              {
                tab: 'reward',
                ...textsFor(langOf(u.locale)).levelUp(top),
                action: { type: 'screen', screen: 'rewards' },
              },
              tx,
            );
          });
        }
      },
      requeueCounter(XP_PENDING),
    );
  }

  // ---------- profile / guards ----------

  /** Time zone changes move day boundaries: at most once per 7 days (stops "double check-in" by hopping zones). */
  async setTimezone(userId: string, timezone: string): Promise<{ timezone: string }> {
    const [u] = await this.db.write
      .select({ timezone: users.timezone, changedAt: users.timezoneChangedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!u) throw new AppError('UNAUTHENTICATED');
    if (u.timezone === timezone) return { timezone };
    if (u.changedAt && Date.now() - u.changedAt.getTime() < TZ_CHANGE_MS) {
      throw new AppError('RATE_LIMITED', 'Time zone can change once every 7 days', {
        retryAfterSec: Math.ceil((u.changedAt.getTime() + TZ_CHANGE_MS - Date.now()) / 1000),
      });
    }
    await this.db.write.update(users).set({ timezone, timezoneChangedAt: new Date() }).where(eq(users.id, userId));
    await this.cache.del(profileKey(userId));
    return { timezone };
  }

  /** Accounts only; at most N accounts per device collect rewards per day (anti-farming). */
  private async assertCanCollect(auth: AuthContext, now: Date): Promise<Profile> {
    const profile = await this.profile(auth.userId);
    if (profile.isGuest) throw new AppError('FORBIDDEN', 'Create an account to collect rewards');
    await this.rateLimit.consume('rewards', auth.userId, 30, 60);
    const [session] = await this.db.read
      .select({ deviceId: sessions.deviceId })
      .from(sessions)
      .where(eq(sessions.id, auth.sessionId));
    if (session?.deviceId) {
      const { config } = await this.config.get();
      const key = deviceKey(session.deviceId, localDay('UTC', now));
      const [[, added], [, size]] = (await this.redis.state
        .multi()
        .sadd(key, auth.userId)
        .scard(key)
        .expire(key, 2 * 86_400)
        .exec()) as [[null, number], [null, number], unknown];
      if (added && size > config.maxAccountsPerDevice) {
        await this.redis.state.srem(key, auth.userId);
        throw new AppError('FORBIDDEN', 'Too many accounts collected rewards on this device today');
      }
    }
    return profile;
  }

  private profile(userId: string): Promise<Profile> {
    return this.cache.getOrSet(profileKey(userId), 3600, async () => {
      const [u] = await this.db.read
        .select({ timezone: users.timezone, locale: users.locale, isGuest: users.isGuest })
        .from(users)
        .where(eq(users.id, userId));
      if (!u) throw new AppError('UNAUTHENTICATED');
      return u;
    });
  }

  private async recordReadDay(userId: string, day: string) {
    await this.db.write.transaction(async (tx) => {
      const [s] = await tx
        .insert(userStats)
        .values({ userId })
        .onConflictDoUpdate({ target: userStats.userId, set: { updatedAt: new Date() } })
        .returning();
      const streak = nextStreak(s!.lastReadDay, s!.readingStreak, day);
      await tx
        .update(userStats)
        .set({
          lastReadDay: day,
          readingStreak: streak,
          longestReadingStreak: Math.max(s!.longestReadingStreak, streak),
        })
        .where(eq(userStats.userId, userId));
    });
    await enqueueBadgeEval(this.redis.state, userId);
  }

  private async recordNightRead(userId: string, day: string) {
    await this.db.write
      .insert(userStats)
      .values({ userId, lastNightReadDay: day, nightReadDays: 1 })
      .onConflictDoUpdate({
        target: userStats.userId,
        set: { lastNightReadDay: day, nightReadDays: sql`${userStats.nightReadDays} + 1` },
        setWhere: sql`${userStats.lastNightReadDay} is distinct from ${day}::date`,
      });
    await enqueueBadgeEval(this.redis.state, userId);
  }

  private creditPoints(
    tx: Tx,
    userId: string,
    points: number,
    reason: 'task' | 'checkin' | 'badge' | 'level',
    key: string,
  ) {
    return this.wallet.credit(tx, userId, {
      currency: 'points',
      amount: points * 100, // ledger points are hundredths
      kind: 'bonus',
      reason,
      idempotencyKey: key,
      sourceType: 'reward',
    });
  }

  private async pointsBalance(userId: string): Promise<number> {
    return (await this.wallet.spendable(userId, 'points')) / 100;
  }
}

/** Exported: the users module drops it when the locale changes (badge / task texts follow the account language). */
export const rewardsProfileKey = (userId: string) => `c:rewards:profile:${userId}`;
const profileKey = rewardsProfileKey;
