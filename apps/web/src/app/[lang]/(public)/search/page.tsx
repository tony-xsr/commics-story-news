import type { Metadata } from 'next';
import Link from 'next/link';
import { StoryGrid } from '@/components/story-card';
import { localePath, routeLocale, translator } from '@/i18n';
import { searchStories } from '@/lib/api';
import { readingLanguage } from '@/lib/reading-language';

type Props = { params: Promise<{ lang: string }>; searchParams: Promise<{ q?: string; cursor?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // Result pages are endless variations of the catalog: keep them out of the index.
  return { title: translator(routeLocale((await params).lang))('nav.search'), robots: { index: false, follow: true } };
}

export default async function SearchPage({ params, searchParams }: Props) {
  const lang = routeLocale((await params).lang);
  const t = translator(lang);
  const { q: raw, cursor } = await searchParams;
  const q = (raw ?? '').trim().slice(0, 100);
  const page = q ? await searchStories(q, lang, cursor, await readingLanguage()) : null;
  return (
    <div className="grid gap-5">
      <form action={localePath(lang, '/search')} role="search" className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder={t('search.placeholder')}
          aria-label={t('nav.search')}
          className="w-full rounded-full border border-container bg-white px-5 py-2.5 outline-none focus:border-primary"
        />
        <button type="submit" className="rounded-full bg-primary px-5 font-semibold text-white">
          {t('nav.search')}
        </button>
      </form>
      {!q ? <p className="text-sm text-text-tertiary">{t('search.hint')}</p> : null}
      {q ? <h1 className="text-xl font-bold">{t('search.results', { q })}</h1> : null}
      {page && page.items.length === 0 ? <p className="text-text-tertiary">{t('search.empty', { q })}</p> : null}
      {page?.items.length ? <StoryGrid stories={page.items} lang={lang} priorityCount={6} /> : null}
      {page?.nextCursor ? (
        <Link
          href={`${localePath(lang, '/search')}?${new URLSearchParams({ q, cursor: page.nextCursor })}`}
          className="justify-self-center rounded-full bg-white px-5 py-2 text-sm font-semibold text-primary"
        >
          {t('genre.next')}
        </Link>
      ) : null}
    </div>
  );
}
