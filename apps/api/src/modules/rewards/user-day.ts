// Calendar days in the user's time zone (check-in, tasks, streaks). Server clock + stored zone: changing the
// phone's clock does nothing.

function zone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** YYYY-MM-DD in the zone. */
export const localDay = (timeZone: string, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone(timeZone) }).format(now);

export const localHour = (timeZone: string, now = new Date()) =>
  Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone(timeZone) }).format(now));

/** 22:00–04:59 counts as reading "at night" (Night Owl). */
export const isNight = (timeZone: string, now = new Date()) => {
  const h = localHour(timeZone, now);
  return h >= 22 || h < 5;
};

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

/** Next streak value given the last counted day: consecutive → +1, same day → unchanged, gap → 1. */
export function nextStreak(lastDay: string | null, streak: number, today: string): number {
  if (lastDay === today) return streak;
  return lastDay === addDays(today, -1) ? streak + 1 : 1;
}
