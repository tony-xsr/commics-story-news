import { Injectable, Logger } from '@nestjs/common';
import type { ReadingProgress, SaveProgressRequest } from '@storyzio/contracts';
import { BADGE_EVAL_QUEUE } from '../rewards/eval-queue';
import { AppError } from '../../common/errors/app-error';
import { drainHash, requeueLatest } from '../../infra/redis/drain-hash';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StoriesService } from '../stories/stories.service';
import { isForeignKeyViolation, LibraryRepo, type ProgressRow } from './library.repo';

/** Compact Redis value: chapter id, chapter number, position, time (epoch ms). */
type Entry = { c: string; n: number; p: number; t: number };

const PENDING = 'progress:pending'; // field `${userId}|${storyId}` → Entry, drained by the worker
const latestKey = (userId: string) => `progress:u:${userId}`; // field storyId → Entry, read-your-writes
const LATEST_TTL_SEC = 2 * 24 * 3600;

/**
 * Reading progress is the highest-frequency write in the app (every reader, every ~15 s). It never touches Postgres
 * on the request path: it lands in Redis (pending queue + the user's "latest" hash) and the worker upserts it in
 * batches. Reads merge the Redis "latest" with the DB row, so the user always sees their newest position — on any device.
 */
@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly repo: LibraryRepo,
    private readonly stories: StoriesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async save(userId: string, input: SaveProgressRequest, now = Date.now()): Promise<ReadingProgress> {
    await this.rateLimit.consume('progress', userId, 120, 60);
    const chapter = await this.stories.chapter(input.chapterId); // cached
    if (!chapter || chapter.storyId !== input.storyId) throw new AppError('NOT_FOUND', 'Chapter not found');

    const entry: Entry = { c: chapter.id, n: chapter.number, p: round(input.position), t: now };
    const value = JSON.stringify(entry);
    await this.redis.state
      .multi()
      .hset(latestKey(userId), input.storyId, value)
      .expire(latestKey(userId), LATEST_TTL_SEC)
      .hset(PENDING, `${userId}|${input.storyId}`, value)
      .sadd(BADGE_EVAL_QUEUE, userId) // stories read / completed / genres may have changed
      .exec();
    return toProgress(entry);
  }

  /** The user's newest progress per story still in Redis (written in the last 2 days). */
  async latest(userId: string): Promise<Map<string, ReadingProgress>> {
    const raw = await this.redis.state.hgetall(latestKey(userId));
    return new Map(Object.entries(raw).map(([storyId, v]) => [storyId, toProgress(JSON.parse(v) as Entry)]));
  }

  async latestFor(userId: string, storyId: string): Promise<ReadingProgress | null> {
    const raw = await this.redis.state.hget(latestKey(userId), storyId);
    return raw ? toProgress(JSON.parse(raw) as Entry) : null;
  }

  /** Called when stories are removed from history, so a not-yet-flushed entry doesn't bring them back. */
  async forget(userId: string, storyIds: string[] | 'all'): Promise<void> {
    if (storyIds === 'all') {
      const fields = Object.keys(await this.redis.state.hgetall(latestKey(userId)));
      await this.redis.state.del(latestKey(userId));
      storyIds = fields;
    } else if (storyIds.length) {
      await this.redis.state.hdel(latestKey(userId), ...storyIds);
    }
    if (storyIds.length) await this.redis.state.hdel(PENDING, ...storyIds.map((s) => `${userId}|${s}`));
  }

  /** Worker job: upsert every pending entry. Rows pointing at deleted users/stories are dropped, not retried forever. */
  async flush(): Promise<number> {
    try {
      return await drainHash(
        this.redis.state,
        PENDING,
        async (entries) => {
          const rows = entries.map(([field, value]) => toRow(field, JSON.parse(value) as Entry));
          for (let i = 0; i < rows.length; i += 500) await this.upsertChunk(rows.slice(i, i + 500));
        },
        requeueLatest(PENDING),
      );
    } catch (err) {
      this.logger.error(`progress flush failed, entries re-queued: ${String(err)}`);
      throw err;
    }
  }

  private async upsertChunk(rows: ProgressRow[]): Promise<void> {
    try {
      await this.repo.upsertProgress(rows);
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
      // One bad row (user/story deleted since) must not block the batch: retry row by row, skip the orphans.
      for (const row of rows) {
        try {
          await this.repo.upsertProgress([row]);
        } catch (rowErr) {
          if (!isForeignKeyViolation(rowErr)) throw rowErr;
          this.logger.warn(`dropping progress for missing user/story ${row.userId}/${row.storyId}`);
        }
      }
    }
  }
}

const round = (p: number) => Math.round(p * 10_000) / 10_000;

const toProgress = (e: Entry): ReadingProgress => ({
  chapterId: e.c,
  chapterNumber: e.n,
  position: e.p,
  updatedAt: new Date(e.t).toISOString(),
});

function toRow(field: string, e: Entry): ProgressRow {
  const [userId, storyId] = field.split('|') as [string, string];
  return { userId, storyId, chapterId: e.c, chapterNumber: e.n, position: e.p, updatedAt: new Date(e.t) };
}

export const rowToProgress = (r: ProgressRow): ReadingProgress => ({
  chapterId: r.chapterId,
  chapterNumber: r.chapterNumber,
  position: r.position,
  updatedAt: r.updatedAt.toISOString(),
});

/** Newer of two progress values (null-safe). */
export const newest = (a: ReadingProgress | null, b: ReadingProgress | null) =>
  !a ? b : !b ? a : a.updatedAt >= b.updatedAt ? a : b;
