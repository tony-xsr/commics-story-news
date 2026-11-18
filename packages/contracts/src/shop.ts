import { z } from 'zod';
import { Reason } from './admin';
import { Lang } from './common';

// Shop: sticker packs. Public catalog (CDN-cacheable) + per-user ownership under /v1/me.

export const StickerPackKind = z.enum(['shop', 'level', 'premium']);
export type StickerPackKind = z.infer<typeof StickerPackKind>;

export const Sticker = z.object({ id: z.uuid(), imageUrl: z.string() });
export type Sticker = z.infer<typeof Sticker>;

export const StickerPackCard = z.object({
  id: z.string(),
  name: z.string(),
  coverUrl: z.string().nullable(),
  kind: StickerPackKind,
  /** Whole coins / whole points; a shop pack has exactly one. */
  priceCoins: z.number().int().nullable(),
  pricePoints: z.number().int().nullable(),
  levelRequired: z.number().int().nullable(),
  stickerCount: z.number().int(),
  releasedAt: z.iso.datetime().nullable(),
});
export type StickerPackCard = z.infer<typeof StickerPackCard>;

export const StickerPackDetail = StickerPackCard.extend({ stickers: z.array(Sticker) });
export type StickerPackDetail = z.infer<typeof StickerPackDetail>;

export const ShopQuery = z
  .object({
    currency: z.enum(['coins', 'points']).optional(),
    sort: z.enum(['popular', 'new', 'price_asc', 'price_desc']).default('popular'),
    lang: Lang.default('en'),
  })
  .strict();
export type ShopQuery = z.infer<typeof ShopQuery>;
export const ShopCatalog = z.object({ items: z.array(StickerPackCard) });
export type ShopCatalog = z.infer<typeof ShopCatalog>;

/** Every pack the user can use now: bought, from their level, or included in Premium. */
export const MyStickers = z.object({
  packs: z.array(StickerPackDetail.extend({ source: z.enum(['purchase', 'level', 'premium']) })),
  /** Level packs not reached yet (to show "unlocks at level N"). */
  upcoming: z.array(StickerPackCard),
});
export type MyStickers = z.infer<typeof MyStickers>;

export const StickerPurchaseRequest = z.object({ packId: z.string().regex(/^[a-z0-9-]{2,40}$/) }).strict();
export type StickerPurchaseRequest = z.infer<typeof StickerPurchaseRequest>;
export const StickerPurchaseResult = z.object({
  packId: z.string(),
  currency: z.enum(['coins', 'points']),
  price: z.number().int(),
  /** Balance of that currency after the purchase (whole units). */
  balance: z.number(),
});
export type StickerPurchaseResult = z.infer<typeof StickerPurchaseResult>;

// ---- admin ----

const I18n = z
  .partialRecord(Lang, z.string().trim().min(1).max(40))
  .refine((t) => !!t.en, 'English (en) name is required');

export const StickerPackInput = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: I18n,
    coverUrl: z.url().nullable().default(null),
    kind: StickerPackKind.default('shop'),
    priceCoins: z.number().int().min(1).max(100_000).nullable().default(null),
    pricePoints: z.number().int().min(1).max(1_000_000).nullable().default(null),
    levelRequired: z.number().int().min(1).max(100).nullable().default(null),
    status: z.enum(['draft', 'active', 'hidden']).default('draft'),
    sort: z.number().int().min(0).max(1000).default(0),
    reason: Reason,
  })
  .strict()
  .refine((p) => p.kind !== 'shop' || (p.priceCoins === null) !== (p.pricePoints === null), {
    path: ['priceCoins'],
    message: 'A shop pack has exactly one price: coins or points',
  })
  .refine((p) => p.kind !== 'level' || p.levelRequired !== null, {
    path: ['levelRequired'],
    message: 'A level pack needs levelRequired',
  });
export type StickerPackInput = z.infer<typeof StickerPackInput>;

/** Replaces the pack's stickers (in order). */
export const StickersInput = z
  .object({ stickers: z.array(z.object({ imageUrl: z.url() }).strict()).max(60), reason: Reason })
  .strict();
export type StickersInput = z.infer<typeof StickersInput>;

export const AdminStickerPack = z.object({
  id: z.string(),
  name: z.partialRecord(Lang, z.string()),
  coverUrl: z.string().nullable(),
  kind: StickerPackKind,
  priceCoins: z.number().int().nullable(),
  pricePoints: z.number().int().nullable(),
  levelRequired: z.number().int().nullable(),
  status: z.enum(['draft', 'active', 'hidden']),
  sort: z.number().int(),
  purchaseCount: z.number().int(),
  releasedAt: z.iso.datetime().nullable(),
  stickers: z.array(Sticker),
});
export type AdminStickerPack = z.infer<typeof AdminStickerPack>;
