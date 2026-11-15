import { Injectable, Logger } from '@nestjs/common';
import type { FavoritePage, HistoryPage, LibraryQuery, StoryState } from '@storyzio/contracts';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, encodeCursor, splitPage } from '../../common/http/cursor';
import { drainHash, requeueCounter } from '../../infra/redis/drain-hash';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { RedisService } from '../../infra/redis/redis.service';
import { enqueueBadgeEval } from '../rewards/eval-queue';
import { StoriesService } from '../stories/stories.service';
import { LibraryRepo } from './library.repo';
import { newest, ProgressService, rowToProgress } from './progress.service';

const LIKES_PENDING = 'likes:pending';
const KeysetCursor = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  constructor(
    private readonly repo: LibraryRepo,
    private readonly stories: StoriesService,
    private readonly progress: ProgressService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Everything personal about one story, in one call — the public detail stays CDN-cacheable. */
  async state(userId: string, storyId: string): Promise<StoryState> {
    if (!(await this.stories.record(storyId))) throw new AppError('NOT_FOUND', 'Story not found');
    const [liked, rating, dbProgress, cached, unlocked] = await Promise.all([
      this.repo.isFavorite(userId, storyId),
      this.repo.rating(userId, storyId),
      this.repo.findProgress(userId, storyId),
      this.progress.latestFor(userId, storyId),
      this.repo.unlockedNumbers(userId, storyId),
    ]);
    return {
      storyId,
      liked,
      rating,
      progress: newest(dbProgress ? rowToProgress(dbProgress) : null, cached),
      unlocked: toRanges(unlocked),
    };
  }

  // ---------- favorites ----------

  async addFavorite(userId: string, storyId: string): Promise<void> {
    await this.rateLimit.consume('favorites', userId, 60, 60);
    if (!(await this.stories.record(storyId))) throw new AppError('NOT_FOUND', 'Story not found');
    if (await this.repo.addFavorite(userId, storyId)) {
      await this.redis.state.hincrby(LIKES_PENDING, storyId, 1);
      await enqueueBadgeEval(this.redis.state, userId);
    }
  }

  async removeFavorite(userId: string, storyId: string): Promise<void> {
    await this.rateLimit.consume('favorites', userId, 60, 60);
    if (await this.repo.removeFavorite(userId, storyId)) await this.redis.state.hincrby(LIKES_PENDING, storyId, -1);
  }

  async favorites(userId: string, q: LibraryQuery): Promise<FavoritePage> {
    const after = q.cursor ? decodeCursor(q.cursor, KeysetCursor) : null;
    const { items, hasMore } = splitPage(await this.repo.listFavorites(userId, q.limit, after), q.limit);
    const cards = new Map(
      (
        await this.stories.cards(
          items.map((i) => i.storyId),
          q.lang,
        )
      ).map((c) => [c.id, c]),
    );
    const last = items.at(-1);
    return {
      // Stories that stopped being public are skipped (the favorite row stays, in case they come back).
      items: items.flatMap((i) => {
        const story = cards.get(i.storyId);
        return story ? [{ story, favoritedAt: i.createdAt.toISOString() }] : [];
      }),
      nextCursor: hasMore && last ? encodeCursor([last.createdAt.toISOString(), last.storyId]) : null,
    };
  }

  /** Worker job: apply pending like/unlike deltas to stories.like_count. */
  async flushLikes(): Promise<number> {
    try {
      return await drainHash(
        this.redis.state,
        LIKES_PENDING,
        (entries) =>
          this.repo.addLikes(entries.map(([id, n]) => [id, Number(n)] as [string, number]).filter(([, n]) => n !== 0)),
        requeueCounter(LIKES_PENDING),
      );
    } catch (err) {
      this.logger.error(`like flush failed, deltas re-queued: ${String(err)}`);
      throw err;
    }
  }

  // ---------- history ----------

  /**
   * Most recently read first. The first page also merges progress still waiting in Redis, so a chapter read seconds
   * ago is already on top. (A story can then reappear once on a later page — clients dedupe by story id.)
   */
  async history(userId: string, q: LibraryQuery): Promise<HistoryPage> {
    const after = q.cursor ? decodeCursor(q.cursor, KeysetCursor) : null;
    const { items: rows, hasMore } = splitPage(await this.repo.listHistory(userId, q.limit, after), q.limit);

    let entries = rows.map((r) => ({ storyId: r.storyId, progress: rowToProgress(r) }));
    if (!after) {
      const pending = await this.progress.latest(userId);
      const byStory = new Map(entries.map((e) => [e.storyId, e]));
      for (const [storyId, progress] of pending) {
        const current = byStory.get(storyId);
        if (!current || progress.updatedAt > current.progress.updatedAt) byStory.set(storyId, { storyId, progress });
      }
      entries = [...byStory.values()]
        .sort((a, b) => b.progress.updatedAt.localeCompare(a.progress.updatedAt))
        .slice(0, q.limit);
    }

    const cards = new Map(
      (
        await this.stories.cards(
          entries.map((e) => e.storyId),
          q.lang,
        )
      ).map((c) => [c.id, c]),
    );
    const lastRow = rows.at(-1);
    return {
      items: entries.flatMap((e) => {
        const story = cards.get(e.storyId);
        return story ? [{ story, progress: e.progress }] : [];
      }),
      nextCursor: hasMore && lastRow ? encodeCursor([lastRow.updatedAt.toISOString(), lastRow.storyId]) : null,
    };
  }

  async hideHistory(userId: string, storyIds: string[] | 'all'): Promise<void> {
    await this.progress.forget(userId, storyIds);
    await this.repo.hideHistory(userId, storyIds);
  }
}

/** [1,2,3,5,7,8] → [[1,3],[5,5],[7,8]] */
export function toRanges(sorted: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const n of sorted) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else if (!last || n > last[1]) ranges.push([n, n]);
  }
  return ranges;
}
