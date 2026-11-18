import { z } from 'zod';
import { Reason } from './admin';
import { Lang } from './common';

// Rewards (app): reading tasks, daily check-in, levels, badges. Points are whole points here.

const Day = z.iso.date();

export const ReadingTimeRequest = z
  .object({
    /** Seconds actually spent reading since the previous heartbeat (the server clamps it to wall-clock time). */
    seconds: z.number().int().min(1).max(120),
    chapterId: z.uuid(),
  })
  .strict();
export type ReadingTimeRequest = z.infer<typeof ReadingTimeRequest>;
export const ReadingTimeResult = z.object({ day: Day, minutesRead: z.number().int() });
export type ReadingTimeResult = z.infer<typeof ReadingTimeResult>;

export const TaskView = z.object({
  id: z.string(),
  minutes: z.number().int(),
  points: z.number().int(),
  completed: z.boolean(),
  claimed: z.boolean(),
});
export const TasksState = z.object({ day: Day, minutesRead: z.number().int(), tasks: z.array(TaskView) });
export type TasksState = z.infer<typeof TasksState>;

export const RewardResult = z.object({
  points: z.number().int(),
  /** Points balance after the reward. */
  balance: z.number(),
});
export type RewardResult = z.infer<typeof RewardResult>;

export const BadgeView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  points: z.number().int(),
  imageUrl: z.string().nullable(),
  imageDisabledUrl: z.string().nullable(),
  unlocked: z.boolean(),
  unlockedAt: z.iso.datetime().nullable(),
  seen: z.boolean(),
  progress: z.object({ current: z.number().int(), target: z.number().int() }),
});
export type BadgeView = z.infer<typeof BadgeView>;
export const BadgesState = z.object({
  items: z.array(BadgeView),
  /** Uncapped counters behind the badges (profile stats: stories read, longest streaks…). */
  metrics: z.record(z.string(), z.number().int()),
});
export type BadgesState = z.infer<typeof BadgesState>;

export const CheckinDay = z.object({
  day: Day,
  points: z.number().int(),
  checkedIn: z.boolean(),
  isToday: z.boolean(),
});
export const CheckinState = z.object({
  today: Day,
  checkedIn: z.boolean(),
  streak: z.number().int(),
  /** Monday … Sunday of the current week (user's time zone). */
  week: z.array(CheckinDay),
  nextMilestone: z.number().int().nullable(),
  /** Days checked in during the last 12 weeks (for the week strip history). */
  checkedDays: z.array(Day),
  /** First day tracked (account creation, user's zone): earlier days are not "missed". */
  since: Day,
});
export type CheckinState = z.infer<typeof CheckinState>;
export const CheckinResult = z.object({
  points: z.number().int(),
  balance: z.number(),
  state: CheckinState,
  /** Badges unlocked by this check-in (for BadgeUnlockedModal). */
  unlocked: z.array(BadgeView),
});
export type CheckinResult = z.infer<typeof CheckinResult>;

export const LevelInfo = z.object({
  level: z.number().int(),
  xpNeeded: z.number().int(),
  points: z.number().int(),
  benefits: z.array(z.string()),
});
export type LevelInfo = z.infer<typeof LevelInfo>;
export const LevelState = z.object({
  level: z.number().int(),
  xp: z.number().int(),
  next: LevelInfo.nullable(),
  levels: z.array(LevelInfo),
});
export type LevelState = z.infer<typeof LevelState>;

export const TimezoneRequest = z
  .object({
    timezone: z
      .string()
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown IANA time zone'),
  })
  .strict();
export type TimezoneRequest = z.infer<typeof TimezoneRequest>;

// ---- admin ----

export const RewardTaskInput = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/),
    minutes: z.number().int().min(1).max(1440),
    points: z.number().int().min(0).max(100_000),
    sort: z.number().int().min(0).max(1000).default(0),
    active: z.boolean().default(true),
  })
  .strict();
export type RewardTaskInput = z.infer<typeof RewardTaskInput>;

export const RewardConfigValue = z
  .object({
    checkinWeekPoints: z.array(z.number().int().min(0).max(100_000)).length(7),
    xpPerReadingMinute: z.number().int().min(0).max(1000),
    xpPerCheckin: z.number().int().min(0).max(10_000),
    maxAccountsPerDevice: z.number().int().min(1).max(20),
    adUnlocksPerDay: z.number().int().min(0).max(50),
    interstitialEveryChapters: z.number().int().min(0).max(100),
  })
  .strict();
export type RewardConfigValue = z.infer<typeof RewardConfigValue>;

export const LevelsInput = z
  .object({
    levels: z
      .array(LevelInfo.extend({ benefits: z.array(z.string().max(30)).max(10) }))
      .min(1)
      .max(100),
    reason: Reason,
  })
  .strict()
  .refine((v) => v.levels.every((l, i) => l.level === i + 1), {
    message: 'Levels must be 1, 2, 3 … in order',
  })
  .refine((v) => v.levels[0]!.xpNeeded === 0, { message: 'Level 1 needs 0 XP' })
  .refine((v) => v.levels.every((l, i) => i === 0 || l.xpNeeded > v.levels[i - 1]!.xpNeeded), {
    message: 'XP needed must increase with each level',
  });
export type LevelsInput = z.infer<typeof LevelsInput>;

export const BadgeMetric = z.enum([
  'stories_read',
  'stories_completed',
  'genres_explored',
  'night_reads',
  'favorites',
  'reading_streak',
  'checkin_streak',
  'premium',
]);
export type BadgeMetric = z.infer<typeof BadgeMetric>;

const I18n = (max: number) =>
  z.partialRecord(Lang, z.string().trim().min(1).max(max)).refine((t) => !!t.en, 'English (en) is required');

export const BadgeInput = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/),
    title: I18n(40),
    description: I18n(120),
    metric: BadgeMetric,
    threshold: z.number().int().min(1).max(100_000),
    points: z.number().int().min(0).max(100_000),
    imageUrl: z.url().nullable().default(null),
    imageDisabledUrl: z.url().nullable().default(null),
    sort: z.number().int().min(0).max(1000).default(0),
    active: z.boolean().default(true),
  })
  .strict();
export type BadgeInput = z.infer<typeof BadgeInput>;

export const AdminBadge = BadgeInput.extend({
  title: z.partialRecord(Lang, z.string()),
  description: z.partialRecord(Lang, z.string()),
  /** Users who have it. */
  owners: z.number().int(),
});
export type AdminBadge = z.infer<typeof AdminBadge>;

export const RewardsAdminState = z.object({
  tasks: z.array(RewardTaskInput),
  config: RewardConfigValue,
  levels: z.array(LevelInfo),
  badges: z.array(AdminBadge),
  today: z.object({ checkins: z.number().int(), taskClaims: z.number().int() }),
});
export type RewardsAdminState = z.infer<typeof RewardsAdminState>;

// Admin write bodies (every write carries a reason for the audit log).
export const RewardTaskRequest = RewardTaskInput.extend({ reason: Reason });
export type RewardTaskRequest = z.infer<typeof RewardTaskRequest>;
export const RewardConfigRequest = z.object({ value: RewardConfigValue, reason: Reason }).strict();
export type RewardConfigRequest = z.infer<typeof RewardConfigRequest>;
export const BadgeRequest = BadgeInput.extend({ reason: Reason });
export type BadgeRequest = z.infer<typeof BadgeRequest>;
