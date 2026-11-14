import type { Redis } from 'ioredis';

/** Stories whose index document may be stale; drained by the `search-sync` worker job. */
export const SEARCH_SYNC_QUEUE = 'search:dirty';

/** One SADD — called by StoriesService.invalidate after every story / chapter change. */
export const enqueueSearchSync = (redis: Redis, storyId: string) => redis.sadd(SEARCH_SYNC_QUEUE, storyId);
