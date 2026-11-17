import type { Lang } from '@storyzio/contracts';
import { cookies } from 'next/headers';
import { isLocale } from '@/i18n/locales';
import { READING_COOKIE } from './reading-cookie';

/**
 * Reading language (the language stories are written in) chosen in the header — English by default. Only the list
 * pages read it (home, genres, rankings, search, author): they render per request; story / chapter pages stay static.
 */
export async function readingLanguage(): Promise<Lang> {
  const value = (await cookies()).get(READING_COOKIE)?.value;
  return value && isLocale(value) ? (value as Lang) : 'en';
}
