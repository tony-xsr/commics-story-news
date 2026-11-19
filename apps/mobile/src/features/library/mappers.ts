import type { FavoriteItem as ApiFavorite, HistoryItem as ApiHistory, StoryCard } from '@storyzio/contracts';
import { FavoriteItem, HistoryGroup, HistoryItem, ReadingItem } from '../../data/mockLibrary';
import { currentLanguage, t } from '../../i18n';
import { formatCount, toStory } from '../stories/mappers';

/** Last chapter, scrolled to the end: the story leaves Reading / Continue (and shows a check in History). */
const FINISHED_RATIO = 0.9;

export const isFinished = ({ story, progress }: ApiHistory) =>
  progress.chapterNumber >= story.chapterCount && progress.position >= FINISHED_RATIO;

const base = (card: StoryCard) => {
  const story = toStory(card);
  return { id: card.id, storyId: card.id, title: story.title, genres: story.genres.replace(/ · /g, ' • '), cover: story.cover };
};

export function toReadingItem(h: ApiHistory): ReadingItem {
  const total = Math.max(h.story.chapterCount, 1);
  return {
    ...base(h.story),
    readChapters: Math.min(h.progress.chapterNumber, total),
    totalChapters: total,
    progress: Math.min((h.progress.chapterNumber - 1 + h.progress.position) / total, 1),
  };
}

export const toFavoriteItem = ({ story }: Pick<ApiFavorite, 'story'>): FavoriteItem => ({
  ...base(story),
  description: story.description,
  views: formatCount(story.views),
  chapters: story.chapterCount,
});

/** "2 hours ago" in the app's language. */
export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  if (minutes < 24 * 60) return t('time.hoursAgo', { count: Math.floor(minutes / 60) });
  return t('time.daysAgo', { count: Math.floor(minutes / 1440) });
}

export const toHistoryItem = (h: ApiHistory): HistoryItem => ({
  ...base(h.story),
  chapters: h.progress.chapterNumber,
  timeAgo: relativeTime(h.progress.updatedAt),
  finished: isFinished(h),
});

/** Today / Yesterday / "Oct 3, 2026" (app language), in the order given (most recent first). */
export function groupHistory(items: ApiHistory[], now = new Date()): HistoryGroup[] {
  const day = new Intl.DateTimeFormat(currentLanguage(), { month: 'short', day: 'numeric', year: 'numeric' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const groups: HistoryGroup[] = [];
  for (const h of items) {
    const at = new Date(h.progress.updatedAt);
    const diff = Math.round((today - startOfDay(at)) / 86_400_000);
    const label = diff <= 0 ? t('time.today') : diff === 1 ? t('time.yesterday') : day.format(at);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(toHistoryItem(h));
    else groups.push({ label, items: [toHistoryItem(h)] });
  }
  return groups;
}
