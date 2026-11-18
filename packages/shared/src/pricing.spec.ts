import { describe, expect, it } from 'vitest';
import {
  allocatePrice,
  buildOffers,
  buildPricedOffers,
  DEFAULT_PRICING,
  discountFor,
  unlockOptions,
  type PricingConfig,
} from './pricing';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('discountFor', () => {
  it.each([
    [1, 0],
    [9, 0],
    [10, 5],
    [19, 5],
    [20, 10],
    [49, 10],
    [50, 15],
    [500, 15],
  ])('%i chapters → %i%%', (count, percent) => {
    expect(discountFor(count)).toBe(percent);
  });
});

describe('buildOffers', () => {
  it('no offers when fewer than 2 chapters are locked (single purchase only)', () => {
    expect(buildOffers([])).toEqual([]);
    expect(buildOffers([7])).toEqual([]);
  });

  it('only "all" when locked count is below the smallest bundle', () => {
    const offers = buildOffers(range(4, 8)); // 5 locked
    expect(offers).toEqual([{ key: 'all', chapters: range(4, 8), percent: 0, original: 50, price: 50 }]);
  });

  it('a bundle is offered only while MORE chapters than its size are locked', () => {
    expect(buildOffers(range(1, 10)).map((o) => o.key)).toEqual(['all']); // 10 locked: bundle-10 == all
    expect(buildOffers(range(1, 11)).map((o) => o.key)).toEqual(['bundle-10', 'all']);
    expect(buildOffers(range(1, 60)).map((o) => o.key)).toEqual(['bundle-10', 'bundle-20', 'bundle-50', 'all']);
  });

  it('bundles take the first locked chapters in reading order', () => {
    const [bundle10] = buildOffers([4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 20]);
    expect(bundle10?.chapters).toEqual([4, 5, 6, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('prices: 10 coins/chapter with tiered discount, rounded down for the buyer', () => {
    const offers = buildOffers(range(1, 57));
    expect(offers.map(({ key, original, price, percent }) => ({ key, original, price, percent }))).toEqual([
      { key: 'bundle-10', original: 100, price: 95, percent: 5 },
      { key: 'bundle-20', original: 200, price: 180, percent: 10 },
      { key: 'bundle-50', original: 500, price: 425, percent: 15 },
      { key: 'all', original: 570, price: 484, percent: 15 }, // 484.5 → 484
    ]);
  });

  it('regression: 11 locked — "all" is not more expensive per chapter than bundle-10', () => {
    const [bundle10, all] = buildOffers(range(1, 11));
    expect(bundle10?.price).toBe(95);
    expect(all?.price).toBe(104); // was 105 with Math.round
  });

  it('buying more is never more expensive per chapter', () => {
    for (let locked = 2; locked <= 300; locked++) {
      const offers = buildOffers(range(1, locked));
      const perChapter = offers.map((o) => o.price / o.chapters.length);
      for (let i = 1; i < perChapter.length; i++) expect(perChapter[i]).toBeLessThanOrEqual(perChapter[i - 1]! + 1e-9);
    }
  });

  it('respects a custom per-story config', () => {
    const config: PricingConfig = { chapterPrice: 25, discounts: [{ from: 5, percent: 20 }], bundleSizes: [5] };
    expect(buildOffers(range(1, 8), config)).toEqual([
      { key: 'bundle-5', chapters: range(1, 5), percent: 20, original: 125, price: 100 },
      { key: 'all', chapters: range(1, 8), percent: 20, original: 200, price: 160 },
    ]);
  });

  it('default config matches the designer prototype', () => {
    expect(DEFAULT_PRICING.chapterPrice).toBe(10);
    expect(DEFAULT_PRICING.bundleSizes).toEqual([10, 20, 50]);
  });
});

describe('per-chapter prices', () => {
  const priced = (prices: number[], from = 1) => prices.map((price, i) => ({ number: from + i, price }));

  it('bundle original = sum of each chapter price, then the tier discount', () => {
    const chapters = priced([10, 10, 25, ...Array(9).fill(10)]); // 12 locked, chapter 3 costs 25
    const [bundle10, all] = buildPricedOffers(chapters);
    expect(bundle10).toMatchObject({ key: 'bundle-10', original: 115, percent: 5, price: 109 });
    expect(all).toMatchObject({ key: 'all', original: 135, percent: 5, price: 128 });
  });

  it('unlockOptions starts with the single chapter at full price', () => {
    const options = unlockOptions(priced([12, 12, 12], 7));
    expect(options.map((o) => [o.key, o.chapters, o.price])).toEqual([
      ['single', [7], 12],
      ['all', [7, 8, 9], 36],
    ]);
    expect(unlockOptions([])).toEqual([]);
    expect(unlockOptions(priced([5]))).toEqual([{ key: 'single', chapters: [1], percent: 0, original: 5, price: 5 }]);
  });

  it('allocatePrice splits the charged total exactly, proportional to chapter prices', () => {
    const chapters = priced([10, 10, 25, 10]);
    const shares = allocatePrice(chapters, 52);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(52);
    expect(shares[2]).toBeGreaterThan(shares[0]!);
    for (let total = 0; total <= 200; total++) {
      expect(allocatePrice(priced([7, 3, 11]), total).reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(allocatePrice(priced([0, 0]), 0)).toEqual([0, 0]);
  });

  it('buildOffers (uniform price) is unchanged', () => {
    expect(buildOffers(range(1, 11))).toEqual(buildPricedOffers(range(1, 11).map((number) => ({ number, price: 10 }))));
  });
});
