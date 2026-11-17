'use client';

import { createContext, useContext, useMemo } from 'react';
import { localePath, translator, type Locale, type T } from './index';

const I18nContext = createContext<{ lang: Locale; t: T; href: (path: `/${string}`) => string }>({
  lang: 'en',
  t: translator('en'),
  href: (path) => path,
});

/** Language for client components: `t()` for strings, `href()` for locale-prefixed internal links. */
export function I18nProvider({ lang, children }: { lang: Locale; children: React.ReactNode }) {
  const value = useMemo(() => ({ lang, t: translator(lang), href: (path: `/${string}`) => localePath(lang, path) }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
