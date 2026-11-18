import { describe, expect, it } from 'vitest';
import { releaseDayNames } from './schedule';

describe('releaseDayNames', () => {
  it('weekday names in the locale, Monday first, no duplicates / junk', () => {
    expect(releaseDayNames([5, 2], 'en')).toEqual(['Tue', 'Fri']);
    expect(releaseDayNames([0, 1], 'en')).toEqual(['Mon', 'Sun']);
    expect(releaseDayNames([2, 2, 9, -1], 'en')).toEqual(['Tue']);
    expect(releaseDayNames([2, 5], 'vi')).toEqual(['Thứ 3', 'Thứ 6']);
    expect(releaseDayNames([], 'en')).toEqual([]);
  });
});
