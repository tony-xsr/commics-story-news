import type { StoryDetail } from '@storyzio/contracts';
import Link from 'next/link';
import { isLocale, LOCALE_NAMES, localePath, type Locale, type T } from '@/i18n';
import { chapterPath, storyPath } from '@/lib/site';

/** “Also in: Tiếng Việt · 日本語” — the story's other language versions (same chapter when `chapter` is given). */
export function StoryVersions({
  story,
  lang,
  t,
  chapter,
  className = '',
}: {
  story: StoryDetail;
  lang: Locale;
  t: T;
  chapter?: number;
  className?: string;
}) {
  if (!story.translations.length) return null;
  return (
    <p data-testid="story-versions" className={`flex flex-wrap items-center gap-2 text-sm ${className}`}>
      <span className="text-text-tertiary">{t('story.versions')}</span>
      {story.translations.map((v) => (
        <Link
          key={v.storyId}
          href={localePath(lang, chapter ? chapterPath(v.slug, chapter) : storyPath(v.slug))}
          hrefLang={v.language}
          title={v.title}
          className="rounded-full border border-container px-3 py-0.5 text-primary hover:bg-container"
        >
          {isLocale(v.language) ? LOCALE_NAMES[v.language] : v.language.toUpperCase()}
        </Link>
      ))}
    </p>
  );
}
