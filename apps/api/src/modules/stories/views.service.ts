import { Injectable, Logger } from '@nestjs/common';
import { drainHash, requeueCounter } from '../../infra/redis/drain-hash';
import { RedisService } from '../../infra/redis/redis.service';
import { StoriesRepo } from './stories.repo';

const PENDING = 'views:pending';
const DEDUPE_SEC = 30 * 60;
const DAY_RANK_TTL_SEC = 9 * 24 * 3600;

/** `rank:views:d:20261023` — daily view leaderboard (sorted set storyId → views). */
export const dayRankKey = (date: Date) => `rank:views:d:${date.toISOString().slice(0, 10).replace(/-/g, '')}`;

/**
 * Story views never UPDATE Postgres per request (a hot story would lock its row thousands of times per second).
 * Each view: dedupe per viewer (30 min) → HINCRBY a pending hash + the daily ranking. The worker calls `flush()`
 * every few seconds to apply all pending counts in one statement.
 */
@Injectable()
export class ViewsService {
  private readonly logger = new Logger(ViewsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly repo: StoriesRepo,
  ) {}

  /** Returns true when the view was counted (false = same viewer within 30 minutes). */
  async record(storyId: string, viewer: string, now = new Date()): Promise<boolean> {
    const fresh = await this.redis.state.set(`viewed:${storyId}:${viewer}`, '1', 'EX', DEDUPE_SEC, 'NX');
    if (fresh !== 'OK') return false;
    const rank = dayRankKey(now);
    await this.redis.state
      .multi()
      .hincrby(PENDING, storyId, 1)
      .zincrby(rank, 1, storyId)
      .expire(rank, DAY_RANK_TTL_SEC)
      .exec();
    return true;
  }

  /** Applies pending counts to Postgres; on failure they are re-queued (no view lost or double-counted). */
  async flush(): Promise<number> {
    try {
      return await drainHash(
        this.redis.state,
        PENDING,
        async (entries) => {
          const counts = entries.map(([id, n]) => [id, Number(n)] as [string, number]);
          for (let i = 0; i < counts.length; i += 1000) await this.repo.addViews(counts.slice(i, i + 1000));
        },
        requeueCounter(PENDING),
      );
    } catch (err) {
      this.logger.error(`view flush failed, counts re-queued: ${String(err)}`);
      throw err;
    }
  }
}
