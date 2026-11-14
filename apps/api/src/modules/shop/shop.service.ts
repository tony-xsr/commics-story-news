import { Injectable } from '@nestjs/common';
import type {
  Lang,
  MyStickers,
  ShopCatalog,
  ShopQuery,
  Sticker,
  StickerPackCard,
  StickerPackDetail,
  StickerPurchaseResult,
} from '@storyzio/contracts';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../../common/errors/app-error';
import { stickerPacks, stickers, userStickerPacks, users } from '../../db/schema';
import { CacheService } from '../../infra/cache/cache.service';
import { DbService } from '../../infra/db/db.service';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { localized } from '../inbox/inbox.service';
import { EntitlementsService } from '../premium/entitlements.service';
import { WalletService } from '../wallet/wallet.service';

type PackRow = typeof stickerPacks.$inferSelect;
const CATALOG_VERSION = 'c:shop:ver';
const SORT = {
  popular: [desc(stickerPacks.purchaseCount), asc(stickerPacks.sort)],
  new: [desc(stickerPacks.releasedAt), asc(stickerPacks.sort)],
  price_asc: [sql`coalesce(${stickerPacks.priceCoins}, ${stickerPacks.pricePoints}) asc`, asc(stickerPacks.sort)],
  price_desc: [sql`coalesce(${stickerPacks.priceCoins}, ${stickerPacks.pricePoints}) desc`, asc(stickerPacks.sort)],
} as const;

/**
 * Sticker packs. Ownership = bought (user_sticker_packs) ∪ level packs up to the user's level ∪ Premium packs while
 * Premium is active — the last two are computed, so reaching a level or subscribing needs no extra writes.
 */
@Injectable()
export class ShopService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly wallet: WalletService,
    private readonly entitlements: EntitlementsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Public catalog of packs for sale (CDN-cacheable; no per-user data). */
  async catalog(q: ShopQuery): Promise<ShopCatalog> {
    const ver = await this.cache.version(CATALOG_VERSION);
    const key = `c:shop:v${ver}:${q.currency ?? 'all'}:${q.sort}:${q.lang}`;
    return this.cache.getOrSet(key, 300, async () => {
      const rows = await this.db.read
        .select({ pack: stickerPacks, n: count(stickers.id) })
        .from(stickerPacks)
        .leftJoin(stickers, eq(stickers.packId, stickerPacks.id))
        .where(
          and(
            eq(stickerPacks.status, 'active'),
            eq(stickerPacks.kind, 'shop'),
            q.currency === 'coins' ? sql`${stickerPacks.priceCoins} is not null` : undefined,
            q.currency === 'points' ? sql`${stickerPacks.pricePoints} is not null` : undefined,
          ),
        )
        .groupBy(stickerPacks.id)
        .orderBy(...SORT[q.sort]);
      return { items: rows.map((r) => toCard(r.pack, r.n, q.lang)) };
    });
  }

  async pack(id: string, lang: Lang): Promise<StickerPackDetail> {
    const [pack] = await this.db.read
      .select()
      .from(stickerPacks)
      .where(and(eq(stickerPacks.id, id), eq(stickerPacks.status, 'active')));
    if (!pack) throw new AppError('NOT_FOUND', 'Sticker pack not found');
    const list = await this.stickersOf([id]);
    return { ...toCard(pack, list.length, lang), stickers: list };
  }

  async mine(userId: string, lang: Lang): Promise<MyStickers> {
    const [[user], bought, premium] = await Promise.all([
      this.db.read.select({ level: users.level }).from(users).where(eq(users.id, userId)),
      this.db.read
        .select({ packId: userStickerPacks.packId })
        .from(userStickerPacks)
        .where(eq(userStickerPacks.userId, userId))
        .orderBy(desc(userStickerPacks.acquiredAt)),
      this.entitlements.hasPremium(userId),
    ]);
    const level = user?.level ?? 1;
    const boughtIds = bought.map((b) => b.packId);
    const packs = await this.db.read
      .select()
      .from(stickerPacks)
      .where(
        sql`${stickerPacks.status} = 'active' and (
          ${boughtIds.length ? inArray(stickerPacks.id, boughtIds) : sql`false`}
          or ${stickerPacks.kind} = 'level'
          or (${stickerPacks.kind} = 'premium' and ${premium})
        )`,
      )
      .orderBy(asc(stickerPacks.sort));
    const usable = packs.filter(
      (p) => boughtIds.includes(p.id) || p.kind === 'premium' || (p.kind === 'level' && level >= p.levelRequired!),
    );
    const list = await this.stickersOf(usable.map((p) => p.id));
    return {
      packs: usable.map((p) => {
        const own = list.filter((s) => s.packId === p.id).map(({ packId: _p, ...s }) => s);
        return {
          ...toCard(p, own.length, lang),
          stickers: own,
          source: boughtIds.includes(p.id) ? 'purchase' : p.kind === 'premium' ? 'premium' : 'level',
        };
      }),
      upcoming: packs
        .filter((p) => p.kind === 'level' && level < p.levelRequired! && !boughtIds.includes(p.id))
        .map((p) => toCard(p, 0, lang)),
    };
  }

  /** Coins or points (whole units) → pack; one purchase per user (PK + wallet idempotency key). */
  async purchase(userId: string, packId: string): Promise<StickerPurchaseResult> {
    await this.rateLimit.consume('shop', userId, 10, 60);
    const [[user], [pack]] = await Promise.all([
      this.db.read.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, userId)),
      this.db.read
        .select()
        .from(stickerPacks)
        .where(and(eq(stickerPacks.id, packId), eq(stickerPacks.status, 'active'), eq(stickerPacks.kind, 'shop'))),
    ]);
    if (!user || user.isGuest) throw new AppError('FORBIDDEN', 'Create an account to buy stickers');
    if (!pack) throw new AppError('NOT_FOUND', 'Sticker pack not for sale');
    const currency = pack.priceCoins !== null ? 'coins' : 'points';
    const price = pack.priceCoins ?? pack.pricePoints!;

    const balance = await this.wallet.transaction(async (tx) => {
      const [owned] = await tx.insert(userStickerPacks).values({ userId, packId }).onConflictDoNothing().returning();
      if (!owned) throw new AppError('CONFLICT', 'You already own this sticker pack');
      const res = await this.wallet.debit(tx, userId, {
        currency,
        amount: currency === 'points' ? price * 100 : price, // ledger points are hundredths
        reason: 'shop',
        idempotencyKey: `shop:${userId}:${packId}`,
        refType: 'sticker_pack',
        refId: packId,
      });
      await tx
        .update(stickerPacks)
        .set({ purchaseCount: sql`${stickerPacks.purchaseCount} + 1` })
        .where(eq(stickerPacks.id, packId));
      return res.balance;
    });
    return { packId, currency, price, balance: currency === 'points' ? balance / 100 : balance };
  }

  /** For comments / chat: the sticker, if the user may use it. */
  async usableSticker(userId: string, stickerId: string): Promise<Sticker> {
    const [row] = await this.db.read
      .select({ id: stickers.id, imageUrl: stickers.imageUrl, packId: stickers.packId })
      .from(stickers)
      .where(eq(stickers.id, stickerId));
    if (!row) throw new AppError('NOT_FOUND', 'Sticker not found');
    const mine = await this.mine(userId, 'en');
    if (!mine.packs.some((p) => p.id === row.packId)) {
      throw new AppError('FORBIDDEN', 'Get this sticker pack first');
    }
    return { id: row.id, imageUrl: row.imageUrl };
  }

  /** Admin writes call this so the public catalog refreshes. */
  bumpCatalog(): Promise<number> {
    return this.cache.bumpVersion(CATALOG_VERSION);
  }

  private async stickersOf(packIds: string[]) {
    if (!packIds.length) return [];
    return this.db.read
      .select({ id: stickers.id, imageUrl: stickers.imageUrl, packId: stickers.packId })
      .from(stickers)
      .where(inArray(stickers.packId, packIds))
      .orderBy(asc(stickers.sort));
  }
}

function toCard(p: PackRow, stickerCount: number, lang: Lang): StickerPackCard {
  return {
    id: p.id,
    name: localized(p.name, lang),
    coverUrl: p.coverUrl,
    kind: p.kind,
    priceCoins: p.priceCoins,
    pricePoints: p.pricePoints,
    levelRequired: p.levelRequired,
    stickerCount,
    releasedAt: p.releasedAt?.toISOString() ?? null,
  };
}
