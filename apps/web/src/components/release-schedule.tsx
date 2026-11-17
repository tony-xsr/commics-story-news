'use client';

import { releaseDayNames } from '@storyzio/shared';
import { useSyncExternalStore } from 'react';
import { useI18n } from '@/i18n/client';

const noSubscribe = () => () => {};

/**
 * “New chapters: Tue, Fri · Next chapter: 14 Nov, 20:00”. The days are the same for everyone (rendered on the server);
 * the next chapter's time is shown in the reader's own time zone, so it is added in the browser only.
 */
export function ReleaseSchedule({ days, nextChapterAt }: { days: number[]; nextChapterAt: string | null }) {
  const { lang, t } = useI18n();
  const next = useSyncExternalStore(
    noSubscribe,
    () =>
      nextChapterAt
        ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(
            new Date(nextChapterAt),
          )
        : null,
    () => null,
  );
  const names = releaseDayNames(days, lang);
  const parts = [
    names.length ? t('story.releaseDays', { days: names.join(', ') }) : null,
    next ? t('story.nextChapter', { date: next }) : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p data-testid="release-schedule" className="text-sm font-medium text-primary">
      {parts.join(' · ')}
    </p>
  );
}
