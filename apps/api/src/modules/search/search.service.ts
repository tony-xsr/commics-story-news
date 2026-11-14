import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SearchPage, SearchQuery, SuggestList, SuggestQuery } from '@storyzio/contracts';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../common/http/cursor';
import { CacheService } from '../../infra/cache/cache.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StoriesService } from '../stories/stories.service';
import { SEARCH_ENGINE, type SearchEngine } from './search.engine';
import { SearchRepo } from './search.repo';
import { SEARCH_SYNC_QUEUE } from './sync-queue';

/** Meilisearch returns at most 1000 hits per query anyway. */
const MAX_OFFSET = 1000;
const OffsetCursor = z.tuple([z.number().int().min(0).max(MAX_OFFSET)]);
const RESULT_TTL = 60;
const SYNC_BATCH = 500;
const REINDEX_PAGE = 1000;

@Injectable()
export class SearchService {
  private readonly logger = new Logger('Search');

  constructor(
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
    private readonly repo: SearchRepo,
    private readonly stories: StoriesService,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
  ) {}

  /** Ids come from the engine (cached briefly per query); cards from the per-story cache, like every list. */
  async search(q: SearchQuery): Promise<SearchPage> {
    const offset = q.cursor ? decodeCursor(q.cursor, OffsetCursor)[0] : 0;
    const term = normalize(q.q);
    const key = `search:${q.type ?? ''}:${q.genre ?? ''}:${q.language ?? ''}:${offset}:${q.limit}:${term}`;
    const page = await this.cache.getOrSet(key, RESULT_TTL, () =>
      this.engine.search({ q: term, type: q.type, genre: q.genre, language: q.language, offset, limit: q.limit }),
    );
    const next = offset + q.limit;
    return {
      items: await this.stories.cards(page.ids, q.lang),
      nextCursor: page.hasMore && next <= MAX_OFFSET ? encodeCursor([next]) : null,
    };
  }

  async suggest(q: SuggestQuery): Promise<SuggestList> {
    const term = normalize(q.q);
    const items = await this.cache.getOrSet(`search:suggest:${q.limit}:${term}`, RESULT_TTL, () =>
      this.engine.suggest(term, q.limit),
    );
    return { items };
  }

  /** Worker: index settings, and a full build when the index is empty (new deployment / lost volume). */
  async setup(): Promise<void> {
    await this.engine.setup();
    if ((await this.engine.count()) === 0) await this.reindexAll();
  }

  /** Worker (`search-sync`): re-reads the stories changed since the last run; non-public ones leave the index. */
  async syncPending(): Promise<number> {
    const ids = await this.redis.state.spop(SEARCH_SYNC_QUEUE, SYNC_BATCH);
    if (ids.length === 0) return 0;
    try {
      const docs = await this.repo.docs(ids);
      const kept = new Set(docs.map((d) => d.id));
      await this.engine.upsert(docs);
      await this.engine.remove(ids.filter((id) => !kept.has(id)));
    } catch (err) {
      await this.redis.state.sadd(SEARCH_SYNC_QUEUE, ...ids); // retried next run
      throw err;
    }
    return ids.length;
  }

  /** Worker (`search-reindex`, daily): refreshes popularity and anything edited outside StoriesService. */
  async reindexAll(): Promise<number> {
    let after: string | null = null;
    let total = 0;
    for (;;) {
      const docs = await this.repo.docsAfter(after, REINDEX_PAGE);
      if (docs.length === 0) break;
      await this.engine.upsert(docs);
      total += docs.length;
      after = docs.at(-1)!.id;
    }
    this.logger.log(`reindexed ${total} stories`);
    return total;
  }
}

const normalize = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ');
