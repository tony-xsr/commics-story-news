'use client';

import { usePathname, useRouter } from 'next/navigation';
import { DEFAULT_LOCALE, isLocale, LOCALE_NAMES, LOCALES, localePath, type Locale } from '@/i18n/locales';
import { useI18n } from '@/i18n/client';

/** Same page in another language: strips the current prefix, adds the new one (English = no prefix). */
export function LanguageSwitcher() {
  const { lang, t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const first = pathname.split('/')[1];
  const bare = (isLocale(first) && first !== DEFAULT_LOCALE ? pathname.slice(first.length + 1) || '/' : pathname) as `/${string}`;
  return (
    <label className="ml-auto flex items-center gap-1">
      <span className="sr-only">{t('nav.language')}</span>
      <span aria-hidden>🌐</span>
      <select
        value={lang}
        onChange={(e) => router.push(localePath(e.target.value as Locale, bare))}
        className="rounded-md bg-transparent py-1 text-text-secondary"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
