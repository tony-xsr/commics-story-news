// 2023-01-01 was a Sunday: day d of the week = that date + d days (UTC).
const SUNDAY = Date.UTC(2023, 0, 1, 12);

/** Release days (0 = Sunday … 6 = Saturday) as short weekday names in `locale`, week starting on Monday. */
export function releaseDayNames(days: number[], locale: string): string[] {
  const names = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  return [...new Set(days)]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => names.format(new Date(SUNDAY + d * 86_400_000)));
}
