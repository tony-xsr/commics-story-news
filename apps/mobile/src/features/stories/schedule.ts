import { releaseDayNames } from '@storyzio/shared';
import type { TKey } from '../../i18n';

type T = (key: TKey, params?: Record<string, string | number>) => string;

/** “New chapters: Tue, Fri · Next chapter: Nov 14, 8:00 PM” in the UI language — null when nothing is known. */
export function scheduleText(
  t: T,
  language: string,
  releaseDays: number[],
  nextChapterAt: string | null,
): string | null {
  const parts: string[] = [];
  const days = releaseDayNames(releaseDays, language);
  if (days.length) parts.push(t('story.releaseDays', { days: days.join(', ') }));
  if (nextChapterAt) {
    const when = new Intl.DateTimeFormat(language, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(nextChapterAt));
    parts.push(t('story.nextChapter', { date: when }));
  }
  return parts.length ? parts.join(' · ') : null;
}
