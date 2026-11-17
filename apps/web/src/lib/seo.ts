import type { StoryDetail } from '@storyzio/contracts';
import { DEFAULT_LOCALE, isLocale, localePath, type Locale, type T } from '@/i18n';
import { SITE_URL } from './site';

/**
 * Story titles / descriptions exist in ONE language (the story's own). Serving the same text under 7 locale URLs is
 * duplicate content, so story and chapter pages are canonical in their content language only (the other locale
 * versions stay readable and point their canonical there).
 */
export const contentLocale = (story: { language: string }): Locale =>
  isLocale(story.language) ? story.language : DEFAULT_LOCALE;

/** canonical + hreflang for a story / chapter path: only the content-language URL (+ x-default). */
export function contentAlternates(story: { language: string }, path: `/${string}`) {
  const lang = contentLocale(story);
  const url = localePath(lang, path);
  return { canonical: url, languages: { [lang]: url, 'x-default': url } };
}

export const absolute = (path: string) => (path.startsWith('http') ? path : `${SITE_URL}${path}`);

/** Open Graph locale codes (Facebook / Zalo previews). */
const OG_LOCALE: Record<Locale, string> = {
  en: 'en_US',
  vi: 'vi_VN',
  ja: 'ja_JP',
  ko: 'ko_KR',
  zh: 'zh_CN',
  es: 'es_ES',
  fr: 'fr_FR',
};
export const ogLocale = (lang: Locale) => OG_LOCALE[lang];

/** Plain text, collapsed whitespace, cut at a word boundary with “…” (Google shows ~155–160 characters). */
export function snippet(text: string, max = 158): string {
  const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/** Admin override → type-aware template (“X - Đọc Truyện Tranh Online”); long titles stay bare (≤ 60 chars shown). */
export function storyTitle(t: T, story: Pick<StoryDetail, 'title' | 'type' | 'seo'>): string {
  if (story.seo?.title) return story.seo.title;
  const full = t(story.type === 'comic' ? 'seo.storyTitleComic' : 'seo.storyTitleNovel', { title: story.title });
  return full.length <= 60 ? full : story.title;
}

/** Admin override → the story's own description when long enough → a generated sentence (never empty / thin). */
export function storyDescription(t: T, story: StoryDetail): string {
  if (story.seo?.description) return snippet(story.seo.description);
  if (story.description.trim().length >= 80) return snippet(story.description);
  const generated = t('seo.storyDescription', {
    title: story.title,
    author: story.author ? t('seo.by', { author: story.author }) : '',
    type: t(story.type === 'comic' ? 'seo.typeComic' : 'seo.typeNovel'),
    genres: story.genres.map((g) => g.name).join(', ') || '—',
    status: t(story.status === 'completed' ? 'story.completed' : 'story.ongoing'),
    n: story.chapterCount,
  });
  return snippet(story.description.trim() ? `${story.description.trim()} ${generated}` : generated);
}

/** Staging / preview deployments: whole site noindex + robots.txt Disallow: / (set NEXT_PUBLIC_NOINDEX_SITE=true). */
export const SITE_NOINDEX = process.env.NEXT_PUBLIC_NOINDEX_SITE === 'true';
