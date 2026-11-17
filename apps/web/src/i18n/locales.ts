/**
 * Web locales = the app's languages. The default locale has no URL prefix (`/story/x`); others do (`/en/story/x`).
 * `NEXT_PUBLIC_DEFAULT_LOCALE=vi` makes Vietnamese the unprefixed main site (build-time; pick it before launch —
 * changing it later moves every URL).
 */
export const LOCALES = ['en', 'vi', 'ja', 'ko', 'zh', 'es', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

export const DEFAULT_LOCALE: Locale = isLocale(process.env.NEXT_PUBLIC_DEFAULT_LOCALE)
  ? process.env.NEXT_PUBLIC_DEFAULT_LOCALE
  : 'en';

/** `/story/x` in `vi` → `/vi/story/x`; the default locale stays unprefixed (one canonical URL per page). */
export const localePath = (lang: Locale, path: `/${string}`) =>
  lang === DEFAULT_LOCALE ? path : path === '/' ? `/${lang}` : `/${lang}${path}`;

/** hreflang alternates for a path (Metadata `alternates.languages`), x-default = the default locale. */
export const languageAlternates = (path: `/${string}`) => ({
  ...Object.fromEntries(LOCALES.map((l) => [l, localePath(l, path)])),
  'x-default': path,
});

/** Names shown in the language switcher (each in its own language). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  vi: 'Tiếng Việt',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  es: 'Español',
  fr: 'Français',
};
