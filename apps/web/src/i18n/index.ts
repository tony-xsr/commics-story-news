import { DEFAULT_LOCALE, isLocale, type Locale } from './locales';
import { STRINGS, type StringKey } from './strings';

export * from './locales';
export type { StringKey } from './strings';

export type Vars = Record<string, string | number>;
export type T = (key: StringKey, vars?: Vars) => string;

/** Translator for one locale (server components call it with the route's `lang`). */
export function translator(lang: Locale): T {
  return (key, vars) => {
    const text = STRINGS[key][lang] || STRINGS[key].en;
    return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
  };
}

/** The `[lang]` route param, validated (proxy.ts only lets known locales through; anything else → default). */
export const routeLocale = (value: string): Locale => (isLocale(value) ? value : DEFAULT_LOCALE);
