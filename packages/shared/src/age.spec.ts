import { describe, expect, it } from 'vitest';
import { isAdult } from './age';

describe('isAdult', () => {
  it('18+ only', () => {
    expect(isAdult({ ageRating: 18 })).toBe(true);
    expect(isAdult({ ageRating: 16 })).toBe(false);
    expect(isAdult({ ageRating: 0 })).toBe(false);
    expect(isAdult({})).toBe(false);
  });
});
