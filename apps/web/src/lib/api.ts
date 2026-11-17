import type {
  AuthorProfile,
  AppConfig,
  AppDocument,
  ChapterContent,
  ChapterItem,
  ChapterPage,
  DocumentSlug,
  GenreList,
  HomePage,
  Lang,
  RankingList,
  SeoRedirectTarget,
  SeoSettings,
  SitemapStats,
  SitemapStory,
  StoreCatalog,
  StoryCard,
  StoryDetail,
  StoryListQuery,
  StoryPage,
} from '@storyzio/contracts';

/** Public API (no user data here: these pages are the same for everyone and cached). */
const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * How long Next keeps each kind of response before asking the API again (the API's CDN sits in front too).
 * Tagged fetches are also dropped at once when the API reports an admin edit (`/api/revalidate`).
 */
export const REVALIDATE = { home: 60, list: 300, story: 300, content: 3600, docs: 3600 } as const;

async function get<T>(path: string, revalidate: number, tags: string[] = []): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, { next: { revalidate, tags } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // API down: the page shows its fallback instead of failing the build / request
  }
}

const qs = (q: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))).toString();

export const getDocument = (slug: DocumentSlug, lang: Lang = 'en') =>
  get<AppDocument>(`/v1/documents/${slug}?lang=${lang}`, REVALIDATE.docs);

/** Support email etc. (platform does not matter for these fields). */
export const getAppConfig = () => get<AppConfig>('/v1/app-config?platform=web', REVALIDATE.docs);

/** `language` = reading language (stories written in it); `lang` = site language (genre names…). */
export const getHome = (lang: Lang = 'en', language?: Lang) =>
  get<HomePage>(`/v1/home?${qs({ lang, language })}`, REVALIDATE.home, ['home', 'lists']);

export const getGenres = (lang: Lang = 'en') => get<GenreList>(`/v1/genres?lang=${lang}`, REVALIDATE.list, ['catalog']);

export const getStories = (q: Partial<StoryListQuery>) =>
  get<StoryPage>(`/v1/stories?${qs({ lang: 'en', ...q })}`, REVALIDATE.list, ['lists', 'catalog']);

/** “You may also like” (refreshed with the story's tag). */
export const getSimilar = (storyId: string, lang: Lang = 'en') =>
  get<{ items: StoryCard[] }>(`/v1/stories/${storyId}/similar?lang=${lang}`, REVALIDATE.list, [
    `story:${storyId}`,
    'lists',
  ]);

/** Author page header (their stories: getStories({ author })). */
export const getAuthor = (id: string) =>
  get<AuthorProfile>(`/v1/authors/${encodeURIComponent(id)}`, REVALIDATE.story, [`author:${id}`]);

export const getStory = (slug: string, lang: Lang = 'en') =>
  get<StoryDetail>(`/v1/stories/${encodeURIComponent(slug)}?lang=${lang}`, REVALIDATE.story, [`story-slug:${slug}`]);

/** Every chapter of a story, in order (pages of 200; long series take a few requests, all cached). */
export async function getAllChapters(storyId: string, max = 5000): Promise<ChapterItem[]> {
  const items: ChapterItem[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await get<ChapterPage>(
      `/v1/stories/${storyId}/chapters?${qs({ limit: 200, cursor: cursor ?? undefined })}`,
      REVALIDATE.story,
      [`story:${storyId}`],
    );
    if (!page) break;
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < max);
  return items;
}

/** Free chapters only: locked ones answer 402 and are never rendered into HTML (null). */
export const getFreeChapterContent = (storyId: string, chapterId: string) =>
  get<ChapterContent>(`/v1/chapters/${chapterId}/content`, REVALIDATE.content, [`story:${storyId}`]);

export const searchStories = (q: string, lang: Lang, cursor?: string, language?: Lang) =>
  get<StoryPage>(`/v1/search?${qs({ q, lang, language, cursor, limit: 30 })}`, 60);

export const getRankings = (period: 'day' | 'week', lang: Lang, language?: Lang) =>
  get<RankingList>(`/v1/rankings?${qs({ period, lang, language, limit: 50 })}`, 300, ['lists']);

/** Coin packs sold on the web (empty when Stripe is not configured on the API). */
export const getWebCatalog = () => get<StoreCatalog>('/v1/store/catalog?platform=web', REVALIDATE.list);

// ---- SEO (038) ----

/** Verification tokens, organization, home texts, robots extras (admin “SEO” page; dropped at once via tag `seo`). */
export const getSeoSettings = () => get<SeoSettings>('/v1/seo/settings', 3600, ['seo']);

/** Old URL → new URL. Only asked for paths that would 404 (the catch-all route). */
export const getRedirect = (path: string) =>
  get<SeoRedirectTarget>(`/v1/seo/redirect?${qs({ path })}`, 300, ['seo-redirects']);

export const getSitemapStats = () => get<SitemapStats>('/v1/seo/sitemap', 600, ['lists']);

export const getSitemapChunk = (chunk: number) =>
  get<{ items: SitemapStory[] }>(`/v1/seo/sitemap/stories?chunk=${chunk}`, 1800, ['lists']);
