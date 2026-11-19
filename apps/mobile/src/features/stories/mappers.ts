import type {
  ChapterItem,
  Comment as ApiComment,
  GenreItem,
  StoryCard,
  StoryDetail as ApiStoryDetail,
} from '@storyzio/contracts';
import { covers } from '../../data/covers';
import { Genre, GenreId, getGenre } from '../../data/genres';
import { isAdult } from '@storyzio/shared';
import { Story, StoryListEntry } from '../../data/mockStories';
import { Chapter, Comment, StoryDetail } from '../../data/mockStoryDetail';
import { currentLanguage, t } from '../../i18n';

const NEW_DAYS = 3;
/** Stories without a cover yet still get artwork. */
const FALLBACK_COVER = Object.values(covers)[0];

/** 1234 → "1.2K", 1_500_000 → "1.5M" (prototype style). */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}
const trim = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ''));

/** "Oct 3, 2026" in the app's language. */
const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(currentLanguage(), { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));

/** "now", "5m", "3h", "2d", then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / 1440)}d`;
  return formatDate(iso);
}

const cover = (url: string | null) => (url ? { uri: url } : FALLBACK_COVER);

const isNew = (card: StoryCard) =>
  !!card.lastChapterAt && Date.now() - new Date(card.lastChapterAt).getTime() < NEW_DAYS * 86_400_000;

export function toStory(card: StoryCard, badge?: 'new' | 'hot'): Story {
  return {
    id: card.id,
    title: card.title,
    genres: card.genres.map((g) => g.name).join(' · '),
    genreIds: card.genres.map((g) => g.id) as GenreId[],
    cover: cover(card.coverUrl),
    author: card.author ?? undefined,
    badge: badge ?? (isNew(card) ? 'new' : undefined),
    adult: isAdult(card),
  };
}

export function toListEntry(card: StoryCard, badge?: 'new' | 'hot'): StoryListEntry {
  const { genres: _g, ...story } = toStory(card, badge);
  return {
    ...story,
    tags: card.genres.length ? card.genres.map((g) => g.name) : card.tags,
    description: card.description,
    views: formatCount(card.views),
    chapters: card.chapterCount,
  };
}

export const toChapter = (item: ChapterItem): Chapter => ({
  id: item.id,
  number: item.number,
  title: item.title,
  date: formatDate(item.publishedAt),
});

export const toComment = (c: ApiComment): Comment => ({
  id: c.id,
  authorId: c.author.id,
  name: c.author.displayName,
  level: c.author.level,
  avatar: c.author.avatarUrl ? { uri: c.author.avatarUrl } : undefined,
  text: c.body,
  createdAt: timeAgo(c.createdAt),
  likes: c.likeCount,
});

export function toDetail(d: ApiStoryDetail, chapters: ChapterItem[], comments: ApiComment[]): StoryDetail {
  return {
    id: d.id,
    title: d.title,
    author: d.authorInfo?.name ?? d.author ?? '',
    authorId: d.authorInfo?.id ?? null,
    releaseDays: d.releaseDays ?? [],
    nextChapterAt: d.nextChapterAt ?? null,
    language: d.language,
    translations: (d.translations ?? []).map((v) => ({ storyId: v.storyId, language: v.language, title: v.title })),
    authorAvatar: d.authorInfo?.avatarUrl ? { uri: d.authorInfo.avatarUrl } : undefined,
    cover: cover(d.coverUrl),
    rating: d.rating.toFixed(1),
    views: formatCount(d.views),
    about: d.description,
    tags: [...d.genres.map((g) => g.name), ...d.tags],
    chapters: chapters.map(toChapter),
    topComments: comments.map(toComment),
  };
}

/** Designed artwork for the known genres; genres added in the admin use their uploaded image / color. */
export function toGenre(item: GenreItem): Genre {
  const local = getGenre(item.id);
  return {
    id: item.id as GenreId,
    name: item.name,
    color: item.color ?? local?.color ?? '#FFFFFF',
    image: item.imageUrl ? { uri: item.imageUrl } : (local?.image ?? FALLBACK_COVER),
  };
}
