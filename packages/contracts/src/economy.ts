import { z } from 'zod';
import { Cursor, limit, page } from './common';

export const Currency = z.enum(['coins', 'points']);
export type Currency = z.infer<typeof Currency>;

export const Wallet = z.object({
  coins: z.number().int(),
  /** Hundredths (634.43 points → 63443). Display as points / 100. */
  points: z.number().int(),
  /** Coins owed after a store refund of coins already spent. Spending is blocked until it is covered (0 normally). */
  coinDebt: z.number().int(),
  /** Bonus amounts expiring within 7 days (prototype: reminder before expiry). */
  expiringSoon: z.array(z.object({ currency: Currency, amount: z.number().int(), expiresAt: z.iso.datetime() })),
});
export type Wallet = z.infer<typeof Wallet>;

export const LedgerQuery = z
  .object({ currency: Currency.optional(), cursor: Cursor.optional(), limit: limit(100, 30) })
  .strict();
export type LedgerQuery = z.infer<typeof LedgerQuery>;

export const LedgerItem = z.object({
  id: z.uuid(),
  currency: Currency,
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type LedgerItem = z.infer<typeof LedgerItem>;
export const LedgerPage = page(LedgerItem);
export type LedgerPage = z.infer<typeof LedgerPage>;

// ---- chapter unlocks ----

export const UnlockOffer = z.object({
  /** `single`, `bundle-10`, `bundle-20`, `bundle-50`, `all` — the client builds the label via i18n. */
  key: z.string(),
  chapters: z.array(z.number().int()),
  percent: z.number().int(),
  original: z.number().int(),
  price: z.number().int(),
});
export type UnlockOffer = z.infer<typeof UnlockOffer>;

export const OffersQuery = z.object({ fromChapter: z.coerce.number().int().min(1).optional() }).strict();
export type OffersQuery = z.infer<typeof OffersQuery>;

export const UnlockOffers = z.object({
  storyId: z.uuid(),
  balance: z.number().int(),
  /** Locked chapters from `fromChapter` on (free, already-owned and unpublished chapters excluded). */
  lockedCount: z.number().int(),
  offers: z.array(UnlockOffer),
  /** True when the user's Premium already includes these chapters (premium_or_coins stories): no purchase needed. */
  coveredByPremium: z.boolean(),
  /** Wait-for-free story: when the next free chapter can be opened (`availableAt` null = now). Null = not offered. */
  waitForFree: z.object({ hours: z.number().int(), availableAt: z.iso.datetime().nullable() }).nullable(),
});
export type UnlockOffers = z.infer<typeof UnlockOffers>;

/**
 * Buy an offer. The server recomputes the offer; if it no longer matches `expectedPrice` (price changed, chapter
 * already owned…) the answer is 409 PRICE_CHANGED with fresh offers. Requires an `Idempotency-Key` header (UUID).
 */
export const UnlockRequest = z
  .object({
    storyId: z.uuid(),
    offerKey: z.string().regex(/^(single|all|bundle-\d{1,4})$/),
    fromChapter: z.number().int().min(1),
    expectedPrice: z.number().int().min(0),
  })
  .strict();
export type UnlockRequest = z.infer<typeof UnlockRequest>;

/** Open one locked chapter for free (wait-for-free stories, once every `waitForFreeHours`). */
export const WaitFreeUnlockRequest = z.object({ storyId: z.uuid(), chapterId: z.uuid() }).strict();
export type WaitFreeUnlockRequest = z.infer<typeof WaitFreeUnlockRequest>;

export const UnlockResult = z.object({
  storyId: z.uuid(),
  chapters: z.array(z.number().int()),
  spent: z.number().int(),
  balance: z.number().int(),
});
export type UnlockResult = z.infer<typeof UnlockResult>;
