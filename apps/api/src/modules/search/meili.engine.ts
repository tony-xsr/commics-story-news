import { Logger } from '@nestjs/common';
import type { SearchEngine, SearchParams, StoryDoc, SuggestHit } from './search.engine';

const SETTINGS = {
  searchableAttributes: ['title', 'altTitles', 'author', 'genreNames', 'tags'],
  filterableAttributes: ['type', 'genres', 'language'],
  displayedAttributes: ['id', 'slug', 'title'],
  // Default rules, then popularity for equally good matches.
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'views:desc'],
};
const TASK_TIMEOUT_MS = 30_000;

type Task = { taskUid: number };
type TaskStatus = {
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  error?: { message: string };
};
type SearchResponse = { hits: SuggestHit[]; estimatedTotalHits?: number };

/** Meilisearch over its REST API (no client library needed). Writes wait for their task so errors surface. */
export class MeiliEngine implements SearchEngine {
  private readonly logger = new Logger('Search');

  constructor(
    private readonly url: string,
    private readonly key: string | null,
    private readonly index: string,
  ) {}

  async setup(): Promise<void> {
    await this.wait(await this.call<Task>('PATCH', `/indexes/${this.index}/settings`, SETTINGS));
    this.logger.log(`index "${this.index}" ready`);
  }

  async count(): Promise<number | null> {
    const stats = await this.call<{ numberOfDocuments: number }>('GET', `/indexes/${this.index}/stats`);
    return stats.numberOfDocuments;
  }

  async upsert(docs: StoryDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.wait(await this.call<Task>('POST', `/indexes/${this.index}/documents?primaryKey=id`, docs));
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.wait(await this.call<Task>('POST', `/indexes/${this.index}/documents/delete-batch`, ids));
  }

  async search(p: SearchParams): Promise<{ ids: string[]; hasMore: boolean }> {
    const filter = [
      p.type && `type = "${p.type}"`,
      p.genre && `genres = "${p.genre}"`,
      p.language && `language = "${p.language}"`,
    ].filter(Boolean);
    const res = await this.call<SearchResponse>('POST', `/indexes/${this.index}/search`, {
      q: p.q,
      filter: filter.length ? filter.join(' AND ') : undefined,
      offset: p.offset,
      limit: p.limit + 1,
      attributesToRetrieve: ['id'],
    });
    return { ids: res.hits.slice(0, p.limit).map((h) => h.id), hasMore: res.hits.length > p.limit };
  }

  async suggest(q: string, limit: number): Promise<SuggestHit[]> {
    const res = await this.call<SearchResponse>('POST', `/indexes/${this.index}/search`, {
      q,
      limit,
      attributesToRetrieve: ['id', 'slug', 'title'],
    });
    return res.hits.map(({ id, slug, title }) => ({ id, slug, title }));
  }

  /** Test helper: drop the whole index. */
  async drop(): Promise<void> {
    await this.wait(await this.call<Task>('DELETE', `/indexes/${this.index}`)).catch(() => undefined);
  }

  private async wait(task: Task): Promise<void> {
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    for (let delay = 20; Date.now() < deadline; delay = Math.min(delay * 2, 500)) {
      const t = await this.call<TaskStatus>('GET', `/tasks/${task.taskUid}`);
      if (t.status === 'succeeded') return;
      if (t.status === 'failed' || t.status === 'canceled') {
        throw new Error(`Meilisearch task ${task.taskUid} ${t.status}: ${t.error?.message ?? ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error(`Meilisearch task ${task.taskUid} timed out`);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Meilisearch ${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}
