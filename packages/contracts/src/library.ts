import { z } from 'zod';
import { StoryCard } from './catalog';
import { Cursor, Lang, limit, page } from './common';

export const ReadingProgress = z.object({
  chapterId: z.uuid(),
  chapterNumber: z.number().int(),
  /** 0..1 position inside the chapter (scroll offset / page index ratio). */
  position: z.number().min(0).max(1),
  updatedAt: z.iso.datetime(),
});
export type ReadingProgress = z.infer<typeof ReadingProgress>;

/** Per-user state of one story — never cached by the CDN (GET /v1/me/stories/:id/state). */
export const StoryState = z.object({
  storyId: z.uuid(),
  liked: z.boolean(),
  /** The caller's own star rating (1–5), null = not rated. */
  rating: z.number().int().nullable(),
  progress: ReadingProgress.nullable(),
  /** Purchased chapters as inclusive number ranges, e.g. [[4, 40], [45, 45]] — compact even for 2,000 chapters. */
  unlocked: z.array(z.tuple([z.number().int(), z.number().int()])),
});
export type StoryState = z.infer<typeof StoryState>;

export const SaveProgressRequest = z
  .object({ storyId: z.uuid(), chapterId: z.uuid(), position: z.number().min(0).max(1) })
  .strict();
export type SaveProgressRequest = z.infer<typeof SaveProgressRequest>;

export const LibraryQuery = z
  .object({ cursor: Cursor.optional(), limit: limit(50, 20), lang: Lang.default('en') })
  .strict();
export type LibraryQuery = z.infer<typeof LibraryQuery>;

export const FavoriteItem = z.object({ story: StoryCard, favoritedAt: z.iso.datetime() });
export type FavoriteItem = z.infer<typeof FavoriteItem>;
export const FavoritePage = page(FavoriteItem);
export type FavoritePage = z.infer<typeof FavoritePage>;

/** History = stories with reading progress, most recent first (prototype: history, ContinueReadingBar). */
export const HistoryItem = z.object({ story: StoryCard, progress: ReadingProgress });
export type HistoryItem = z.infer<typeof HistoryItem>;
export const HistoryPage = page(HistoryItem);
export type HistoryPage = z.infer<typeof HistoryPage>;

/** Remove stories from the history screen (prototype: select + delete / select all). */
export const HideHistoryRequest = z.union([
  z.object({ storyIds: z.array(z.uuid()).min(1).max(200) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type HideHistoryRequest = z.infer<typeof HideHistoryRequest>;
