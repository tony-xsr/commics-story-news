'use client';

import { useFavorites, useHistory } from '@storyzio/api-client';
import type { StoryCard } from '@storyzio/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { chapterPath, storyPath } from '@/lib/site';
import { useI18n } from '@/i18n/client';
import { useSignedIn } from '@/lib/session';
import { Cover } from './cover';

export function Library() {
  const { t, href } = useI18n();
  const signedIn = useSignedIn();
  const [tab, setTab] = useState<'reading' | 'favorites'>('reading');
  if (!signedIn) {
    return (
      <div className="grid justify-items-center gap-3 py-12 text-center">
        <h1 className="text-2xl font-bold">{t('library.title')}</h1>
        <p className="text-text-secondary">{t('library.signInHint')}</p>
        <Link href={`${href('/login')}?next=${encodeURIComponent(href('/library'))}`} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white">
          {t('nav.signIn')}
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{t('library.title')}</h1>
      <div role="tablist" className="flex gap-2 text-sm">
        {(['reading', 'favorites'] as const).map((option) => (
          <button
            key={option}
            role="tab"
            type="button"
            aria-selected={tab === option}
            onClick={() => setTab(option)}
            className={`rounded-full px-4 py-1.5 ${tab === option ? 'bg-primary text-white' : 'bg-white text-text-secondary'}`}
          >
            {t(option === 'reading' ? 'library.reading' : 'library.favorites')}
          </button>
        ))}
      </div>
      {tab === 'reading' ? <Reading /> : <Favorites />}
    </div>
  );
}

function Reading() {
  const { t, href } = useI18n();
  const history = useHistory(50);
  if (history.isPending) return <p className="text-text-tertiary">{t('common.loading')}</p>;
  const items = history.data?.items ?? [];
  if (items.length === 0) return <p className="text-text-tertiary">{t('library.emptyReading')}</p>;
  return (
    <List
      rows={items.map((h) => ({
        story: h.story,
        href: href(chapterPath(h.story.slug, h.progress.chapterNumber)),
        note: t('library.continue', { n: h.progress.chapterNumber, total: h.story.chapterCount }),
      }))}
    />
  );
}

function Favorites() {
  const { t, href } = useI18n();
  const favorites = useFavorites();
  if (favorites.isPending) return <p className="text-text-tertiary">{t('common.loading')}</p>;
  const items = favorites.data?.items ?? [];
  if (items.length === 0) return <p className="text-text-tertiary">{t('library.emptyFavorites')}</p>;
  return (
    <List rows={items.map((f) => ({ story: f.story, href: href(storyPath(f.story.slug)), note: t('story.chapters', { n: f.story.chapterCount }) }))} />
  );
}

function List({ rows }: { rows: { story: StoryCard; href: string; note: string }[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {rows.map(({ story, href, note }) => (
        <li key={story.id}>
          <Link href={href} className="grid grid-cols-[64px_1fr] items-center gap-3 rounded-2xl bg-white p-2 hover:text-primary">
            <Cover src={story.coverUrl} alt={story.title} sizes="64px" />
            <span className="grid gap-0.5">
              <span className="line-clamp-2 font-semibold">{story.title}</span>
              <span className="text-sm text-text-tertiary">{note}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
