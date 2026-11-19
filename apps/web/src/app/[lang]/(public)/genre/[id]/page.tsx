import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StoryGrid } from '@/components/story-card';
import { languageAlternates, localePath, routeLocale, translator, type Locale, type StringKey } from '@/i18n';
import { JsonLd } from '@/components/json-ld';
import { ItemListLd } from '@/components/item-list-ld';
import { absolute } from '@/lib/seo';
import { storyPath } from '@/lib/site';
import { getGenres, getStories } from '@/lib/api';
import { readingLanguage } from '@/lib/reading-language';

export const revalidate = 300;
type Props = { params: Promise<{ lang: string; id: string }>; searchParams: Promise<{ sort?: string; cursor?: string }> };

const SORTS = ['popular', 'new', 'updated', 'rating'] as const;
type Sort = (typeof SORTS)[number];

const genre = async (lang: Locale, id: string) => (await getGenres(lang))?.items.find((g) => g.id === id) ?? null;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { lang: raw, id } = await params;
  const lang = routeLocale(raw);
  const g = await genre(lang, id);
  if (!g) return {};
  const t = translator(lang);
  const { sort, cursor } = await searchParams;
  return {
    title: t('genre.title', { genre: g.name }),
    description: t('genre.description', { genre: g.name }),
    alternates: { canonical: localePath(lang, `/genre/${g.id}`), languages: languageAlternates(`/genre/${g.id}`) },
    // Sorted / later pages are the same list again: keep them out of the index, follow their links.
    ...(sort || cursor ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function GenrePage({ params, searchParams }: Props) {
  const { lang: raw, id } = await params;
  const lang = routeLocale(raw);
  const t = translator(lang);
  const { sort: rawSort, cursor } = await searchParams;
  const g = await genre(lang, id);
  if (!g) notFound();
  const sort: Sort = SORTS.find((s) => s === rawSort) ?? 'popular';
  const page = await getStories({ genre: id, sort, cursor, limit: 30, lang, language: await readingLanguage() });
  const href = (q: { sort?: Sort; cursor?: string }) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return `${localePath(lang, `/genre/${id}`)}${p.size ? `?${p}` : ''}`;
  };
  // Editorial text only on the canonical first page (sorted / later pages are noindex anyway).
  const firstPage = !rawSort && !cursor;
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{g.name}</h1>
      {firstPage ? (
        <ItemListLd
          name={g.name}
          url={absolute(localePath(lang, `/genre/${id}`))}
          items={(page?.items ?? []).map((s) => ({ name: s.title, url: absolute(localePath(lang, storyPath(s.slug))) }))}
        />
      ) : null}
      {firstPage && g.intro ? <p className="max-w-3xl whitespace-pre-line text-text-secondary">{g.intro}</p> : null}
      <nav aria-label="Sort" className="flex flex-wrap gap-2 text-sm">
        {SORTS.map((value) => (
          <Link
            key={value}
            href={href({ sort: value === 'popular' ? undefined : value })}
            aria-current={value === sort ? 'page' : undefined}
            className={`rounded-full px-3 py-1 ${value === sort ? 'bg-primary text-white' : 'bg-white text-text-secondary'}`}
          >
            {t(`sort.${value}` as StringKey)}
          </Link>
        ))}
      </nav>
      {page?.items.length ? (
        <StoryGrid stories={page.items} priorityCount={cursor ? 0 : 6} lang={lang} />
      ) : (
        <p className="text-text-tertiary">{t('genre.empty')}</p>
      )}
      {page?.nextCursor ? (
        <Link
          href={href({ sort: sort === 'popular' ? undefined : sort, cursor: page.nextCursor })}
          className="justify-self-center rounded-full bg-white px-5 py-2 text-sm font-semibold text-primary"
        >
          {t('genre.next')}
        </Link>
      ) : null}
      {firstPage && g.faq.length ? (
        <section className="grid gap-3 rounded-2xl bg-white p-5">
          <h2 className="text-lg font-semibold">{t('genre.faq')}</h2>
          {g.faq.map((f) => (
            <details key={f.q} className="group">
              <summary className="cursor-pointer font-medium">{f.q}</summary>
              <p className="mt-1 whitespace-pre-line text-text-secondary">{f.a}</p>
            </details>
          ))}
          <JsonLd
            data={{
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: g.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
            }}
          />
        </section>
      ) : null}
    </div>
  );
}
