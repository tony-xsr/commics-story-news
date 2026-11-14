import { Body, Controller, Get, Injectable, Module, Param, Put } from '@nestjs/common';
import { StickerPackInput, StickersInput, type AdminStickerPack } from '@storyzio/contracts';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ZodPipe } from '../../common/http/zod.pipe';
import { stickerPacks, stickers } from '../../db/schema';
import { DbService } from '../../infra/db/db.service';
import { AdminModule } from '../admin/admin.module';
import { AuditService } from '../admin/audit.service';
import { AdminRoute, CurrentAdmin, type AdminContext } from '../admin/permissions';
import { ShopModule } from './shop.module';
import { ShopService } from './shop.service';

const PackId = z.string().regex(/^[a-z0-9-]{2,40}$/);

@Injectable()
export class ShopAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly shop: ShopService,
  ) {}

  async list(): Promise<{ items: AdminStickerPack[] }> {
    const packs = await this.db.read
      .select()
      .from(stickerPacks)
      .orderBy(asc(stickerPacks.kind), asc(stickerPacks.sort));
    const all = packs.length
      ? await this.db.read
          .select()
          .from(stickers)
          .where(
            inArray(
              stickers.packId,
              packs.map((p) => p.id),
            ),
          )
          .orderBy(asc(stickers.sort))
      : [];
    return {
      items: packs.map((p) => ({
        id: p.id,
        name: p.name,
        coverUrl: p.coverUrl,
        kind: p.kind,
        priceCoins: p.priceCoins,
        pricePoints: p.pricePoints,
        levelRequired: p.levelRequired,
        status: p.status,
        sort: p.sort,
        purchaseCount: p.purchaseCount,
        releasedAt: p.releasedAt?.toISOString() ?? null,
        stickers: all.filter((s) => s.packId === p.id).map((s) => ({ id: s.id, imageUrl: s.imageUrl })),
      })),
    };
  }

  /** Create or update. Going live the first time stamps `released_at` (sort "new"). */
  async upsert(admin: AdminContext, id: string, req: StickerPackInput) {
    if (req.id !== id) throw new AppError('VALIDATION', 'Body id must match the URL');
    const { reason, ...pack } = req;
    const values = {
      ...pack,
      // prices only make sense for shop packs; level only for level packs
      priceCoins: pack.kind === 'shop' ? pack.priceCoins : null,
      pricePoints: pack.kind === 'shop' ? pack.pricePoints : null,
      levelRequired: pack.kind === 'level' ? pack.levelRequired : null,
    };
    await this.db.write.transaction(async (tx) => {
      await tx
        .insert(stickerPacks)
        .values({ ...values, releasedAt: values.status === 'active' ? new Date() : null })
        .onConflictDoUpdate({
          target: stickerPacks.id,
          set: {
            ...values,
            releasedAt:
              values.status === 'active'
                ? sql`coalesce(${stickerPacks.releasedAt}, now())`
                : sql`${stickerPacks.releasedAt}`,
            updatedAt: new Date(),
          },
        });
      await this.audit.record(
        admin,
        { action: 'sticker_pack.save', entity: 'sticker_pack', entityId: id, after: values, reason },
        tx,
      );
    });
    await this.shop.bumpCatalog();
    return this.list();
  }

  async setStickers(admin: AdminContext, id: string, req: StickersInput) {
    await this.db.write.transaction(async (tx) => {
      const [pack] = await tx.select({ id: stickerPacks.id }).from(stickerPacks).where(eq(stickerPacks.id, id));
      if (!pack) throw new AppError('NOT_FOUND', 'Sticker pack not found');
      // Existing stickers keep their ids (comments reference them); removed ones are deleted.
      const current = await tx.select().from(stickers).where(eq(stickers.packId, id));
      const keep = new Map(current.map((s) => [s.imageUrl, s]));
      const wanted = req.stickers.map((s, i) => ({ imageUrl: s.imageUrl, sort: i }));
      const removed = current.filter((s) => !wanted.some((w) => w.imageUrl === s.imageUrl));
      if (removed.length)
        await tx.delete(stickers).where(
          inArray(
            stickers.id,
            removed.map((r) => r.id),
          ),
        );
      for (const w of wanted) {
        const existing = keep.get(w.imageUrl);
        if (existing) await tx.update(stickers).set({ sort: w.sort }).where(eq(stickers.id, existing.id));
        else await tx.insert(stickers).values({ packId: id, imageUrl: w.imageUrl, sort: w.sort });
      }
      await this.audit.record(
        admin,
        {
          action: 'sticker_pack.stickers',
          entity: 'sticker_pack',
          entityId: id,
          after: { count: wanted.length, removed: removed.length },
          reason: req.reason,
        },
        tx,
      );
    });
    await this.shop.bumpCatalog();
    return this.list();
  }
}

@Controller('v1/admin/shop/packs')
export class ShopAdminController {
  constructor(private readonly shop: ShopAdminService) {}

  @Get()
  @AdminRoute('shop.write')
  list() {
    return this.shop.list();
  }

  @Put(':id')
  @AdminRoute('shop.write')
  upsert(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ZodPipe(PackId)) id: string,
    @Body(new ZodPipe(StickerPackInput)) body: StickerPackInput,
  ) {
    return this.shop.upsert(admin, id, body);
  }

  @Put(':id/stickers')
  @AdminRoute('shop.write')
  stickers(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ZodPipe(PackId)) id: string,
    @Body(new ZodPipe(StickersInput)) body: StickersInput,
  ) {
    return this.shop.setStickers(admin, id, body);
  }
}

@Module({ imports: [AdminModule, ShopModule], controllers: [ShopAdminController], providers: [ShopAdminService] })
export class ShopAdminModule {}
