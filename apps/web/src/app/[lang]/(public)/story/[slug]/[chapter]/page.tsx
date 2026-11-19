import type { ChapterItem, StoryDetail } from '@storyzio/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { AppBanner } from '@/components/app-banner';
import { AgeGate } from '@/components/age-gate';
import { isAdult } from '@storyzio/shared';
import { ChapterBody } from '@/components/chapter-body';
import { ClientChapter, GeoGate } from '@/components/geo';
import { JsonLd } from '@/components/json-ld';
import { PaidChapter, ReadingProgress } from '@/components/paid-chapter';
import { StoryVersions } from '@/components/story-versions';
import { localePath, routeLocale, translator, type Locale, type T } from '@/i18n';
import { absolute, contentAlternates, contentLocale, ogLocale, snippet } from '@/lib/seo';
import { getAllChapters, getFreeChapterContent, getStory } from '@/lib/api';
import { appLink, chapterPath, isIndexable, NOINDEX, SITE_NAME, SITE_URL, storyPath } from '@/lib/site';

export const revalidate = 3600;
/** ISR: no page is built ahead of time; each is rendered on its first visit, then cached (CDN-friendly). */
export const generateStaticParams = async () => [];
type Props = { params: Promise<{ lang: string; slug: string; chapter: string }> };

async function load(lang: Locale, slug: string, chapterParam: string) {
  const number = Number(chapterParam);
  if (!Number.isInteger(number) || number < 1) return null;
  const story = await getStory(slug, lang);
  if (!story) return null;
  const chapters = await getAllChapters(story.id);
  const index = chapters.findIndex((c) => c.number === number);
  if (index < 0) return null;
  return { story, chapters, index, chapter: chapters[index]! };
}

/** “Chapter 3: The Gate”, or just “Chapter 3” when the title is only the number again. */
const chapterLabel = (t: T, c: ChapterItem) =>
  c.title.trim().toLowerCase() === `chapter ${c.number}`
    ? t('chapter.label', { n: c.number })
    : t('chapter.labelTitle', { n: c.number, title: c.title });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: raw, slug, chapter } = await params;
  const lang = routeLocale(raw);
  const data = await load(lang, slug, chapter);
  if (!data) return {};
  const t = translator(lang);
  const { story, chapter: c } = data;
  const alternates = contentAlternates(story, chapterPath(story.slug, c.number));
  const named = c.title.trim() && c.title.trim().toLowerCase() !== `chapter ${c.number}` ? `: ${c.title.trim()}` : '';
  // Same cached fetch as the page: the first lines of a free novel chapter make a unique description.
  const content = c.isFree ? await getFreeChapterContent(story.id, c.id) : null;
  const vars = {
    story: story.title,
    n: c.number,
    title: named,
    excerpt: content?.body ? snippet(content.body, 90) : '',
  };
  const description = snippet(t(c.isFree ? 'seo.chapterDescription' : 'seo.lockedChapterDescription', vars));
  const title = t('seo.chapterTitle', { story: story.title, n: c.number });
  return {
    // “Tên truyện Chap 12: Tên chương” when it fits in what Google shows, else without the chapter name.
    title: { absolute: `${title}${named}`.length <= 65 ? `${title}${named}` : title },
    description,
    alternates,
    openGraph: {
      type: 'article',
      title,
      description,
      url: alternates.canonical,
      locale: ogLocale(contentLocale(story)),
    },
    // Locked chapters have no readable text in the page: keep them out of the index (thin content).
    ...(!isIndexable(story) ? { robots: NOINDEX } : c.isFree ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function ChapterPage({ params }: Props) {
  const { lang: raw, slug, chapter } = await params;
  const lang = routeLocale(raw);
  const t = translator(lang);
  const data = await load(lang, slug, chapter);
  if (!data) notFound();
  const { story, chapters, index, chapter: c } = data;
  if (story.slug !== slug) permanentRedirect(localePath(lang, chapterPath(story.slug, c.number)));
  // Only free chapters are fetched on the server; paid text never goes into cached HTML. Geo-restricted stories are
  // loaded in the browser instead (the API must see the reader's country, not this server's).
  const content = c.isFree && !story.regions ? await getFreeChapterContent(story.id, c.id) : null;
  const prev = chapters[index - 1];
  const next = chapters[index + 1];
  const nav = <ChapterNav lang={lang} t={t} slug={story.slug} prev={prev} next={next} />;

  return (
    <article className="mx-auto grid max-w-2xl gap-6">
      {isAdult(story) ? <AgeGate homeHref={localePath(lang, '/')} /> : null}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': story.type === 'comic' ? 'ComicIssue' : 'Chapter',
              name: chapterLabel(t, c),
              url: absolute(contentAlternates(story, chapterPath(story.slug, c.number)).canonical),
              position: c.number,
              ...(story.type === 'comic' ? { issueNumber: c.number } : {}),
              datePublished: c.publishedAt ?? undefined,
              inLanguage: story.language,
              isAccessibleForFree: c.isFree,
              isPartOf: {
                '@type': story.type === 'comic' ? 'ComicSeries' : 'Book',
                '@id': `${absolute(contentAlternates(story, storyPath(story.slug)).canonical)}#work`,
                name: story.title,
              },
            },
            {
              '@type': 'BreadcrumbList',
              itemListElement: [
                { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE_URL}${localePath(lang, '/')}` },
                {
                  '@type': 'ListItem',
                  position: 2,
                  name: story.title,
                  item: `${SITE_URL}${localePath(lang, storyPath(story.slug))}`,
                },
                { '@type': 'ListItem', position: 3, name: t('chapter.label', { n: c.number }) },
              ],
            },
          ],
        }}
      />
      <header className="grid gap-1 text-center">
        <Link href={localePath(lang, storyPath(story.slug))} className="text-sm text-primary hover:underline">
          {story.title}
        </Link>
        <h1 className="text-2xl font-bold">{chapterLabel(t, c)}</h1>
        <StoryVersions story={story} lang={lang} t={t} chapter={c.number} className="justify-center" />
      </header>

      {nav}

      {content ? (
        <ChapterBody content={content} />
      ) : c.isFree && story.regions ? (
        <GeoGate regions={story.regions}>
          <ClientChapter chapterId={c.id} />
        </GeoGate>
      ) : c.isFree ? (
        <p className="rounded-2xl bg-white px-6 py-10 text-center text-text-secondary">{t('chapter.unavailable')}</p>
      ) : (
        <PaidChapter
          storyId={story.id}
          chapterId={c.id}
          number={c.number}
          price={c.price}
          premiumIncluded={story.accessModel === 'premium_or_coins'}
          fallback={<Locked t={t} story={story} chapter={c} />}
        />
      )}
      <ReadingProgress storyId={story.id} chapterId={c.id} />

      {nav}
      {content ? (
        <AppBanner deepLink={appLink(`/reader/${story.id}?chapter=${c.number}`)} text={t('banner.keepReading')} />
      ) : null}
    </article>
  );
}

function Locked({ t, story, chapter }: { t: T; story: StoryDetail; chapter: ChapterItem }) {
  return (
    <div className="grid justify-items-center gap-3 rounded-2xl bg-white px-6 py-10 text-center">
      <p className="text-4xl" aria-hidden>
        🔒
      </p>
      <p className="font-semibold">{t('locked.costs', { price: chapter.price })}</p>
      <p className="text-sm text-text-secondary">
        {t(story.accessModel === 'premium_or_coins' ? 'locked.inAppPremium' : 'locked.inApp')}
      </p>
      <AppBanner
        deepLink={appLink(`/reader/${story.id}?chapter=${chapter.number}`)}
        text={t('banner.coinsEverywhere')}
      />
    </div>
  );
}

function ChapterNav({
  lang,
  t,
  slug,
  prev,
  next,
}: {
  lang: Locale;
  t: T;
  slug: string;
  prev?: ChapterItem;
  next?: ChapterItem;
}) {
  const cls = 'rounded-full bg-white px-4 py-2 text-sm font-semibold text-primary';
  return (
    <nav aria-label={t('story.chaptersHeading')} className="grid grid-cols-3 items-center">
      <div>
        {prev ? (
          <Link href={localePath(lang, chapterPath(slug, prev.number))} rel="prev" className={cls}>
            {t('chapter.prev', { n: prev.number })}
          </Link>
        ) : null}
      </div>
      <Link
        href={localePath(lang, storyPath(slug))}
        className="text-center text-sm text-text-tertiary hover:text-primary"
      >
        {t('chapter.all')}
      </Link>
      <div className="text-right">
        {next ? (
          <Link href={localePath(lang, chapterPath(slug, next.number))} rel="next" className={cls}>
            {t('chapter.next', { n: next.number })}
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
