import { ApiError, qk, useApi } from '@storyzio/api-client';
import type { ChapterContent } from '@storyzio/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ComicPage } from '../data/mockComicPages';
import { Chapter } from '../data/mockStoryDetail';
import { loadOfflineChapter, saveOfflineChapter } from '../lib/offlineChapters';

/** A failed load keeps its error so the reader can say why (daily limit, restricted account, offline…). */
type Entry = ChapterContent | 'locked' | { error: unknown };

/**
 * Chapter bodies for the reader components, which read them synchronously (`getText(n)` / `getPages(n)`) while
 * rendering. Missing chapters are fetched in the background (deduped, cached by TanStack Query) and the screen
 * re-renders when they arrive; the current chapter and its neighbours are prefetched. Loaded chapters are kept on the
 * device (lib/offlineChapters) and served from there when the network is down.
 */
export function useChapterContents(chapters: Chapter[], current: number) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { user, isSignedIn } = useAuth();
  const owner = user?.id ?? null;
  const [entries, setEntries] = useState<Map<number, Entry>>(() => new Map());
  const inflight = useRef(new Set<number>());
  const byNumber = useRef(new Map<number, Chapter>());
  byNumber.current = new Map(chapters.map((c) => [c.number, c]));

  const ensure = useCallback(
    (number: number) => {
      const chapter = byNumber.current.get(number);
      if (!chapter?.id || inflight.current.has(number)) return;
      inflight.current.add(number);
      queryClient
        .fetchQuery({
          queryKey: qk.chapter(chapter.id),
          queryFn: () => api.stories.content(chapter.id!),
          staleTime: 10 * 60_000,
        })
        .then((content) => {
          if (owner) void saveOfflineChapter(owner, content);
          return content;
        })
        .catch(async (err) => {
          if (err instanceof ApiError && err.code === 'CHAPTER_LOCKED') return 'locked' as const;
          // Offline: the saved copy (account unknown when the app started without network → the saved owner).
          const saved =
            isSignedIn && err instanceof ApiError && err.code === 'NETWORK'
              ? await loadOfflineChapter(owner, chapter.id!)
              : null;
          return saved ?? { error: err };
        })
        .then((entry) => setEntries((m) => new Map(m).set(number, entry)))
        .finally(() => inflight.current.delete(number));
    },
    [api, queryClient, owner, isSignedIn],
  );

  useEffect(() => {
    for (const n of [current, current + 1, current - 1]) if (!entries.has(n)) ensure(n);
  }, [current, entries, ensure, chapters]);

  /** After an unlock: forget the cached "locked" answers so they are fetched again. */
  const refresh = useCallback(() => {
    setEntries((m) => new Map([...m].filter(([, e]) => isContent(e))));
  }, []);

  const content = (number: number): ChapterContent | null => {
    const entry = entries.get(number);
    if (entry === undefined) queueMicrotask(() => ensure(number));
    return entry !== undefined && isContent(entry) ? entry : null;
  };

  return {
    getText: (number: number) => content(number)?.body ?? '',
    getPages: (number: number): ComicPage[] =>
      (content(number)?.pages ?? []).map((p) => ({
        // Signed URLs change on every fetch: cache by the object path so pages are not downloaded again.
        source: { uri: p.url, cacheKey: p.url.split('?')[0] },
        width: p.width,
        height: p.height,
        watermark: content(number)?.watermark ?? undefined,
      })),
    isLoaded: (number: number) => entries.has(number),
    /** Why the chapter failed to load (null while loading, loaded, or locked). */
    errorFor: (number: number): unknown => {
      const entry = entries.get(number);
      return typeof entry === 'object' && 'error' in entry ? entry.error : null;
    },
    refresh,
  };
}

const isContent = (e: Entry): e is ChapterContent => typeof e === 'object' && !('error' in e);
