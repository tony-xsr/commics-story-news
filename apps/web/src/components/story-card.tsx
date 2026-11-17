import type { StoryCard as Story } from '@storyzio/contracts';
import Link from 'next/link';
import { localePath, translator, type Locale } from '@/i18n';
import { storyPath } from '@/lib/site';
import { Cover } from './cover';
import { GeoHide } from './geo';

export function StoryCard({ story, lang, priority = false }: { story: Story; lang: Locale; priority?: boolean }) {
  return (
    <Link href={localePath(lang, storyPath(story.slug))} className="group grid gap-2">
      <Cover src={story.coverUrl} alt={story.title} priority={priority} />
      <div className="grid gap-0.5">
        <h3 className="line-clamp-2 font-semibold leading-snug group-hover:text-primary">{story.title}</h3>
        <p className="text-sm text-text-tertiary">{story.genres[0]?.name ?? translator(lang)(story.type === 'comic' ? 'type.comic' : 'type.novel')}</p>
      </div>
    </Link>
  );
}

export function StoryGrid({ stories, lang, priorityCount = 0 }: { stories: Story[]; lang: Locale; priorityCount?: number }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
      {stories.map((s, i) =>
        s.regions ? (
          <GeoHide key={s.id} regions={s.regions}>
            <StoryCard story={s} lang={lang} priority={i < priorityCount} />
          </GeoHide>
        ) : (
          <StoryCard key={s.id} story={s} lang={lang} priority={i < priorityCount} />
        ),
      )}
    </div>
  );
}
