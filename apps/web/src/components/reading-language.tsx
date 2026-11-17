'use client';

import { useRouter } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { useI18n } from '@/i18n/client';
import { isLocale, LOCALE_NAMES, LOCALES, type Locale } from '@/i18n/locales';
import { READING_COOKIE } from '@/lib/reading-cookie';

const noSubscribe = () => () => {};
const current = (): Locale => {
  const value = document.cookie.match(new RegExp(`(?:^|; )${READING_COOKIE}=([^;]+)`))?.[1];
  return value && isLocale(value) ? value : 'en';
};

/** Language of the stories listed (not of the site's texts): saved in a cookie, lists reload with it. */
export function ReadingLanguage() {
  const { t } = useI18n();
  const router = useRouter();
  const value = useSyncExternalStore(noSubscribe, current, () => 'en' as Locale);
  return (
    <label className="flex items-center gap-1" title={t('nav.readingLanguage')}>
      <span className="sr-only">{t('nav.readingLanguage')}</span>
      <span aria-hidden>📖</span>
      <select
        data-testid="reading-language"
        value={value}
        onChange={(e) => {
          document.cookie = `${READING_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
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
