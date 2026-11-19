import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ItemListLd } from '@/components/item-list-ld';
import { StoryGrid } from '@/components/story-card';
import { languageAlternates, localePath, routeLocale, translator } from '@/i18n';
import { getAuthor, getStories } from '@/lib/api';
import { absolute } from '@/lib/seo';
import { storyPath } from '@/lib/site';
import { readingLanguage } from '@/lib/reading-language';

export const revalidate = 300;
type Props = { params: Promise<{ lang: string; id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: raw, id } = await params;
  const lang = routeLocale(raw);
  const author = UUID.test(id) ? await getAuthor(id) : null;
  if (!author) return {};
  const t = translator(lang);
  return {
    title: t('author.title', { name: author.name }),
    description: author.bio || t('author.description', { name: author.name }),
    alternates: { canonical: localePath(lang, `/author/${id}`), languages: languageAlternates(`/author/${id}`) },
  };
}

/** Author page (story page → author): who they are and their stories, newest first. */
export default async function AuthorPage({ params }: Props) {
  const { lang: raw, id } = await params;
  const lang = routeLocale(raw);
  const t = translator(lang);
  const author = UUID.test(id) ? await getAuthor(id) : null;
  if (!author) notFound();
  const page = await getStories({ author: id, sort: 'new', limit: 50, lang, language: await readingLanguage() });
  const stories = page?.items ?? [];
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-4">
        {author.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- small avatar from our CDN
          <img src={author.avatarUrl} alt="" className="size-16 rounded-full object-cover" />
        ) : (
          <div className="grid size-16 place-items-center rounded-full bg-container text-2xl font-bold text-primary">
            {author.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="grid gap-1">
          <h1 className="text-2xl font-bold">{author.name}</h1>
          <p className="text-sm text-text-tertiary">{t('author.storyCount', { count: author.storyCount })}</p>
        </div>
      </div>
      {author.bio ? <p className="text-text-secondary">{author.bio}</p> : null}
      <ItemListLd
        name={author.name}
        url={absolute(localePath(lang, `/author/${id}`))}
        items={stories.map((s) => ({ name: s.title, url: absolute(localePath(lang, storyPath(s.slug))) }))}
      />
      <StoryGrid stories={stories} lang={lang} />
    </div>
  );
}
