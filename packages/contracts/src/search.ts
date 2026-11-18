import { z } from 'zod';
import { StoryCard, StoryType } from './catalog';
import { Cursor, Lang, limit, page } from './common';

/** Full-text story search (title, alternative titles, author, genres, tags), typo tolerant, popular first. */
export const SearchQuery = z
  .object({
    q: z.string().trim().min(1).max(100),
    type: StoryType.optional(),
    genre: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .optional(),
    /** Reading language (story language); omitted = all. */
    language: Lang.optional(),
    cursor: Cursor.optional(),
    limit: limit(50, 20),
    lang: Lang.default('en'),
  })
  .strict();
export type SearchQuery = z.infer<typeof SearchQuery>;
export const SearchPage = page(StoryCard);
export type SearchPage = z.infer<typeof SearchPage>;

/** Autocomplete while typing (clients debounce ~250 ms). */
export const SuggestQuery = z
  .object({ q: z.string().trim().min(1).max(100), limit: limit(10, 8) })
  .strict();
export type SuggestQuery = z.infer<typeof SuggestQuery>;
export const SuggestItem = z.object({ id: z.uuid(), slug: z.string(), title: z.string() });
export type SuggestItem = z.infer<typeof SuggestItem>;
export const SuggestList = z.object({ items: z.array(SuggestItem) });
export type SuggestList = z.infer<typeof SuggestList>;
