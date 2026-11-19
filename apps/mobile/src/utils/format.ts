const pad = (value: number) => String(value).padStart(2, '0');

export function formatNow(date = new Date()) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local calendar day as "YYYY-MM-DD" (used to tell one day from the next). */
export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A chapter's own title, or '' when it only repeats the number (“Chapter 5”, “Chap. 5”, “5”) — callers already show
 * the localized “Chương 5” / “第5話”, so the English placeholder title would be noise next to it.
 */
export function meaningfulChapterTitle(number: number, title: string | null | undefined): string {
  const trimmed = (title ?? '').trim();
  return new RegExp(`^(chap(ter)?\\.?\\s*)?${number}$`, 'i').test(trimmed) ? '' : trimmed;
}

/** "7 days" / "1 tháng" in the reader's language (falls back to "7 day" if the device lacks Intl unit formatting). */
export function formatDuration(count: number, unit: 'day' | 'week' | 'month' | 'year', lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'long' }).format(count);
  } catch {
    return `${count} ${unit}`;
  }
}
