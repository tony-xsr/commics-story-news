'use client';

import type { StoryCard } from '@storyzio/contracts';
import { ApiError, useChapterContent, useGeo } from '@storyzio/api-client';
import { storyAvailable } from '@storyzio/shared';
import { useI18n } from '@/i18n/client';
import { ChapterBody } from './chapter-body';

type Regions = StoryCard['regions'];

/** Lists are cached for everyone: cards of stories this reader's country can't open disappear here (040). */
export function GeoHide({ regions, children }: { regions: Regions; children: React.ReactNode }) {
  const country = useGeo().data?.country ?? null;
  return storyAvailable(regions, country) ? children : null;
}

/** Story / chapter page of a geo-restricted story: a notice instead of the page body when blocked. */
export function GeoGate({ regions, children }: { regions: Regions; children: React.ReactNode }) {
  const { t } = useI18n();
  const country = useGeo().data?.country ?? null;
  if (storyAvailable(regions, country)) return children;
  return (
    <div className="grid justify-items-center gap-2 rounded-2xl bg-white px-6 py-12 text-center">
      <p className="text-4xl" aria-hidden>
        🌏
      </p>
      <p className="font-semibold">{t('err.geoBlocked')}</p>
    </div>
  );
}

/** Free chapter of a geo-restricted story: loaded in the browser (the API checks the reader's own country). */
export function ClientChapter({ chapterId }: { chapterId: string }) {
  const { t } = useI18n();
  const content = useChapterContent(chapterId);
  if (content.data) return <ChapterBody content={content.data} />;
  if (content.isPending) return <p className="py-10 text-center text-text-tertiary">{t('common.loading')}</p>;
  const blocked = content.error instanceof ApiError && content.error.code === 'GEO_BLOCKED';
  return (
    <p className="rounded-2xl bg-white px-6 py-10 text-center text-text-secondary">{t(blocked ? 'err.geoBlocked' : 'common.error')}</p>
  );
}
