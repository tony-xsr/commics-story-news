import type { Metadata } from 'next';
import Link from 'next/link';
import { Cover } from '@/components/cover';
import { languageAlternates, localePath, routeLocale, translator } from '@/i18n';
import { getRankings } from '@/lib/api';
import { ItemListLd } from '@/components/item-list-ld';
import { absolute } from '@/lib/seo';
import { storyPath } from '@/lib/site';
import { readingLanguage } from '@/lib/reading-language';

export const revalidate = 300;
type Props = { params: Promise<{ lang: string }>; searchParams: Promise<{ period?: string }> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const lang = routeLocale((await params).lang);
  const { period } = await searchParams;
  return {
    title: translator(lang)('rankings.title'),
    alternates: { canonical: localePath(lang, '/rankings'), languages: languageAlternates('/rankings') },
    ...(period ? { robots: { index: false, follow: true } } : {}),
  };
}

/** Most read stories today / this week (the app's ranking, same data). */
export default async function RankingsPage({ params, searchParams }: Props) {
  const lang = routeLocale((await params).lang);
  const t = translator(lang);
  const period = (await searchParams).period === 'week' ? 'week' : 'day';
  const list = await getRankings(period, lang, await readingLanguage());
  const items = list?.items ?? [];
  return (
    <div className="grid gap-4">
      <ItemListLd
        name={t('nav.rankings')}
        url={absolute(localePath(lang, '/rankings'))}
        items={items.map((s) => ({ name: s.title, url: absolute(localePath(lang, storyPath(s.slug))) }))}
      />
      <h1 className="text-2xl font-bold">{t('rankings.title')}</h1>
      <nav aria-label={t('rankings.title')} className="flex gap-2 text-sm">
        {(['day', 'week'] as const).map((p) => (
          <Link
            key={p}
            href={`${localePath(lang, '/rankings')}${p === 'day' ? '' : '?period=week'}`}
            aria-current={p === period ? 'page' : undefined}
            className={`rounded-full px-4 py-1.5 ${p === period ? 'bg-primary text-white' : 'bg-white text-text-secondary'}`}
          >
            {t(p === 'day' ? 'rankings.day' : 'rankings.week')}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? <p className="text-text-tertiary">{t('rankings.empty')}</p> : null}
      <ol className="grid gap-2 sm:grid-cols-2">
        {items.map((s, i) => (
          <li key={s.id}>
            <Link
              href={localePath(lang, storyPath(s.slug))}
              className="grid grid-cols-[2rem_56px_1fr] items-center gap-3 rounded-2xl bg-white p-2 hover:text-primary"
            >
              <span className={`text-center text-lg font-bold ${i < 3 ? 'text-primary' : 'text-text-tertiary'}`}>{i + 1}</span>
              <Cover src={s.coverUrl} alt={s.title} sizes="56px" />
              <span className="grid gap-0.5">
                <span className="line-clamp-2 font-semibold">{s.title}</span>
                <span className="text-sm text-text-tertiary">{s.genres[0]?.name ?? ''}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
