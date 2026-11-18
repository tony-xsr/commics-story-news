// Pay-per-chapter pricing, ported from the prototype (storyzio/src/data/chapterAccess.ts).
// The server is authoritative: it recomputes offers with the same function and never trusts a client price.

export type PricingConfig = {
  /** Coins per chapter (story default; a chapter may override). */
  chapterPrice: number;
  /** Bulk discounts, highest `from` first. */
  discounts: readonly { from: number; percent: number }[];
  /** Bundle sizes offered besides "unlock all". */
  bundleSizes: readonly number[];
};

export const DEFAULT_PRICING: PricingConfig = {
  chapterPrice: 10,
  discounts: [
    { from: 50, percent: 15 },
    { from: 20, percent: 10 },
    { from: 10, percent: 5 },
  ],
  bundleSizes: [10, 20, 50],
};

export type UnlockOffer = {
  /** `single`, `bundle-<n>` or `all`. Clients build the label from key + chapters.length via i18n. */
  key: string;
  /** Chapter numbers the offer unlocks, in reading order. */
  chapters: number[];
  percent: number;
  /** Price without the discount (struck through). */
  original: number;
  price: number;
};

export const discountFor = (count: number, config: PricingConfig = DEFAULT_PRICING) =>
  config.discounts.find((tier) => count >= tier.from)?.percent ?? 0;

/** A locked chapter and its own price (a chapter may override the story price). */
export type PricedChapter = { number: number; price: number };

// Rounds DOWN (in the buyer's favour). Rounding to nearest made "unlock all" cost more per chapter than a smaller
// bundle in the same discount tier (e.g. 11 locked: bundle-10 = 95, all = 104.5 → 105).
const offer = (key: string, chapters: PricedChapter[], percent: number): UnlockOffer => {
  const original = chapters.reduce((sum, c) => sum + c.price, 0);
  return {
    key,
    chapters: chapters.map((c) => c.number),
    percent,
    original,
    price: Math.floor((original * (100 - percent)) / 100),
  };
};

/**
 * Offers for the locked chapters (in reading order). A bundle is offered only while MORE chapters than its size are
 * still locked (otherwise it equals "unlock all"). Buying more is never worse than buying less.
 * One locked chapter left: no bundles, only the single purchase.
 */
export function buildOffers(locked: number[], config: PricingConfig = DEFAULT_PRICING): UnlockOffer[] {
  return buildPricedOffers(
    locked.map((number) => ({ number, price: config.chapterPrice })),
    config,
  );
}

/** Same rules as `buildOffers`, with per-chapter prices (bundle price = sum of chapter prices − discount). */
export function buildPricedOffers(locked: PricedChapter[], config: PricingConfig = DEFAULT_PRICING): UnlockOffer[] {
  if (locked.length < 2) return [];
  const bundles = config.bundleSizes
    .filter((size) => size < locked.length)
    .map((size) => offer(`bundle-${size}`, locked.slice(0, size), discountFor(size, config)));
  return [...bundles, offer('all', locked, discountFor(locked.length, config))];
}

/**
 * Every purchase option the unlock sheet shows, starting at the chapter the reader is on:
 * `single` (just that chapter, full price) followed by the discounted bundles and "all".
 */
export function unlockOptions(locked: PricedChapter[], config: PricingConfig = DEFAULT_PRICING): UnlockOffer[] {
  const [first] = locked;
  if (!first) return [];
  return [offer('single', [first], 0), ...buildPricedOffers(locked, config)];
}

/**
 * Splits an offer's (discounted) price over its chapters, proportionally to each chapter's own price, so per-chapter
 * revenue adds up exactly to what was charged. Rounding leftovers go to the first chapters.
 */
export function allocatePrice(chapters: PricedChapter[], total: number): number[] {
  const original = chapters.reduce((sum, c) => sum + c.price, 0);
  if (original === 0) return chapters.map(() => 0);
  const shares = chapters.map((c) => Math.floor((c.price * total) / original));
  let leftover = total - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length, leftover--) shares[i]! += 1;
  return shares;
}
