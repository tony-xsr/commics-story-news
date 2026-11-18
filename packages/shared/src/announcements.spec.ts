import { describe, expect, it } from 'vitest';
import { pickAnnouncement, pruneSeen, type PickableAnnouncement } from './announcements';

const a = (id: string, frequency: PickableAnnouncement['frequency'] = 'once', audience: PickableAnnouncement['audience'] = 'all') => ({
  id,
  frequency,
  audience,
});
const ctx = (over: Partial<Parameters<typeof pickAnnouncement>[1]> = {}) => ({
  seen: {},
  today: '2026-11-03',
  premium: false,
  shownThisSession: new Set<string>(),
  ...over,
});

describe('pickAnnouncement', () => {
  it('first unseen in server order; none → null', () => {
    expect(pickAnnouncement([a('1'), a('2')], ctx())?.id).toBe('1');
    expect(pickAnnouncement([a('1'), a('2')], ctx({ seen: { '1': '2026-01-01' } }))?.id).toBe('2');
    expect(pickAnnouncement([], ctx())).toBeNull();
  });

  it('once = never again · daily = again tomorrow · always = once per session', () => {
    expect(pickAnnouncement([a('1', 'once')], ctx({ seen: { '1': '2020-01-01' } }))).toBeNull();
    expect(pickAnnouncement([a('1', 'daily')], ctx({ seen: { '1': '2026-11-03' } }))).toBeNull();
    expect(pickAnnouncement([a('1', 'daily')], ctx({ seen: { '1': '2026-11-02' } }))?.id).toBe('1');
    expect(pickAnnouncement([a('1', 'always')], ctx({ seen: { '1': '2026-11-03' } }))?.id).toBe('1');
    expect(pickAnnouncement([a('1', 'always')], ctx({ shownThisSession: new Set(['1']) }))).toBeNull();
  });

  it('audience: premium / free match the viewer; targeted ones wait while premium is unknown', () => {
    const items = [a('p', 'once', 'premium'), a('f', 'once', 'free'), a('all')];
    expect(pickAnnouncement(items, ctx({ premium: true }))?.id).toBe('p');
    expect(pickAnnouncement(items, ctx({ premium: false }))?.id).toBe('f');
    expect(pickAnnouncement(items, ctx({ premium: null }))?.id).toBe('all');
  });
});

describe('pruneSeen', () => {
  it('drops ids no longer live', () => {
    expect(pruneSeen({ '1': 'x', '2': 'y' }, ['2', '3'])).toEqual({ '2': 'y' });
  });
});
