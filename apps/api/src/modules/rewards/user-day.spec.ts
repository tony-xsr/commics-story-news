import { describe, expect, it } from 'vitest';
import { addDays, isNight, localDay, nextStreak, weekdayIndex } from './user-day';

describe('user day helpers', () => {
  it('local day follows the user zone, not the server', () => {
    const at = new Date('2026-10-27T18:30:00Z');
    expect(localDay('Asia/Ho_Chi_Minh', at)).toBe('2026-10-28'); // 01:30 next day
    expect(localDay('America/Los_Angeles', at)).toBe('2026-10-27');
    expect(localDay('Not/AZone', at)).toBe('2026-10-27'); // falls back to UTC
  });

  it('night window 22:00–05:00', () => {
    expect(isNight('Asia/Ho_Chi_Minh', new Date('2026-10-27T16:00:00Z'))).toBe(true); // 23:00
    expect(isNight('Asia/Ho_Chi_Minh', new Date('2026-10-27T22:00:00Z'))).toBe(false); // 05:00
  });

  it('days, weekdays (Monday = 0), streaks across months', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayIndex('2026-10-26')).toBe(0); // Monday
    expect(weekdayIndex('2026-11-01')).toBe(6); // Sunday
    expect(nextStreak(null, 0, '2026-11-01')).toBe(1);
    expect(nextStreak('2026-10-31', 4, '2026-11-01')).toBe(5);
    expect(nextStreak('2026-11-01', 5, '2026-11-01')).toBe(5);
    expect(nextStreak('2026-10-29', 9, '2026-11-01')).toBe(1);
  });
});
