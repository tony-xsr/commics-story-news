/** One story as the search index stores it (public stories only). */
export type StoryDoc = {
  id: string;
  slug: string;
  title: string;
  altTitles: string[];
  author: string | null;
  type: 'novel' | 'comic';
  /** Genre ids (filters) and their names in every language (matching). */
  genres: string[];
  genreNames: string[];
  tags: string[];
  views: number;
  /** Story (reading) language — filter. */
  language: string;
};

export type SearchParams = {
  q: string;
  type?: 'novel' | 'comic';
  genre?: string;
  language?: string;
  offset: number;
  limit: number;
};

export type SuggestHit = { id: string; slug: string; title: string };

/** Meilisearch in every deployed environment; a Postgres match when it is not configured (CI, bare dev). */
export interface SearchEngine {
  /** Creates the index and applies its settings (idempotent). */
  setup(): Promise<void>;
  /** Number of documents, or null when the engine keeps no index. */
  count(): Promise<number | null>;
  upsert(docs: StoryDoc[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  /** Story ids, best match first (popularity breaks ties). */
  search(p: SearchParams): Promise<{ ids: string[]; hasMore: boolean }>;
  suggest(q: string, limit: number): Promise<SuggestHit[]>;
}

export const SEARCH_ENGINE = Symbol('SEARCH_ENGINE');
