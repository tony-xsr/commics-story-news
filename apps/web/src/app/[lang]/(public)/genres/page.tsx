import type { Metadata } from 'next';
import Link from 'next/link';
import { languageAlternates, localePath, routeLocale, translator } from '@/i18n';
import { getGenres } from '@/lib/api';

export const revalidate = 300;
type Props = { params: Promise<{ lang: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const lang = routeLocale((await params).lang);
  return {
    title: translator(lang)('nav.genres'),
    alternates: { canonical: localePath(lang, '/genres'), languages: languageAlternates('/genres') },
  };
}

export default async function GenresPage({ params }: Props) {
  const lang = routeLocale((await params).lang);
  const genres = await getGenres(lang);
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{translator(lang)('nav.genres')}</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {(genres?.items ?? []).map((g) => (
          // `color` is the title color designed for the genre's artwork (white on a dark image): only used on top of it
          <Link
            key={g.id}
            href={localePath(lang, `/genre/${g.id}`)}
            className="relative block aspect-[118/146] overflow-hidden rounded-2xl bg-white px-3 pt-4 text-center text-lg font-bold transition hover:opacity-90"
            style={
              g.imageUrl
                ? { backgroundImage: `url(${g.imageUrl})`, backgroundSize: 'cover', color: g.color ?? undefined }
                : undefined
            }
          >
            {g.name}
          </Link>
        ))}
      </div>
    </div>
  );
}
