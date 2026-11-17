import type { HomeTab } from '@storyzio/contracts';
import Link from 'next/link';
import { localePath, type Locale } from '@/i18n';

/**
 * Where a home tab (041, admin-managed) leads: "For you" = home, a genre-only tab = its genre page (the canonical list
 * for that genre), anything else = /browse/<key>.
 */
export function tabHref(lang: Locale, tab: HomeTab): string {
  const q = tab.query;
  if (tab.kind === 'home' || !q) return localePath(lang, '/');
  if (q.genre && !q.type) return `${localePath(lang, `/genre/${q.genre}`)}${q.sort && q.sort !== 'popular' ? `?sort=${q.sort}` : ''}`;
  return localePath(lang, `/browse/${tab.key}`);
}

/** Same chip menu as the app's home screen. */
export function HomeTabs({ tabs, active, lang, label }: { tabs: HomeTab[]; active: string; lang: Locale; label: string }) {
  return (
    <nav aria-label={label} className="flex gap-2 overflow-x-auto pb-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tabHref(lang, tab)}
          aria-current={tab.key === active ? 'page' : undefined}
          className={`shrink-0 rounded-full px-3 py-1 text-sm ${tab.key === active ? 'bg-primary text-white' : 'bg-white text-text-secondary hover:text-primary'}`}
        >
          {tab.title}
        </Link>
      ))}
    </nav>
  );
}
