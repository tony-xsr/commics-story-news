import { describe, expect, it } from 'vitest';
import { storyAvailable } from './regions';

describe('storyAvailable', () => {
  it('no restriction → everywhere', () => {
    expect(storyAvailable(null, 'US')).toBe(true);
    expect(storyAvailable({ mode: 'allow', countries: [] }, 'US')).toBe(true);
  });
  it('allow-list: only listed countries; unknown country follows the policy', () => {
    const r = { mode: 'allow' as const, countries: ['VN', 'TH'] };
    expect(storyAvailable(r, 'VN')).toBe(true);
    expect(storyAvailable(r, 'vn')).toBe(true);
    expect(storyAvailable(r, 'US')).toBe(false);
    expect(storyAvailable(r, null)).toBe(true);
    expect(storyAvailable(r, null, 'deny')).toBe(false);
  });
  it('block-list: everywhere except listed; unknown is allowed', () => {
    const r = { mode: 'block' as const, countries: ['CN'] };
    expect(storyAvailable(r, 'CN')).toBe(false);
    expect(storyAvailable(r, 'VN')).toBe(true);
    expect(storyAvailable(r, null, 'deny')).toBe(true);
  });
});
