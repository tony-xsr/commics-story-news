import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertProducts } from '../src/db/products';
import { adminAuditLogs, walletLots } from '../src/db/schema';
import { CDN_PURGER, type CdnPurger } from '../src/infra/cdn/cdn-purge';
import { DbService } from '../src/infra/db/db.service';
import { PricingSettingsService } from '../src/modules/pricing/pricing-settings.service';
import { APPLE_STORE } from '../src/modules/payments/stores/apple-store';
import { adminClient } from './admin-helpers';
import { createChapters, createStory } from './factories';
import { FakeAppleStore } from './fake-stores';
import { bearer, bootApp, resetData } from './helpers';

class FakePurger implements CdnPurger {
  purged: string[][] = [];
  async purgePaths(paths: string[]) {
    this.purged.push(paths);
  }
}

let app: NestFastifyApplication;
const purger = new FakePurger();
const apple = new FakeAppleStore();

beforeAll(async () => {
  app = await bootApp({
    overrides: [
      [CDN_PURGER, purger],
      [APPLE_STORE, apple],
    ],
  });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
  await upsertProducts(app.get(DbService).write as never);
  await app.get(PricingSettingsService).invalidate();
  purger.purged = [];
});

const db = () => app.get(DbService).write;
const catalog = async () =>
  (await app.inject({ method: 'GET', url: '/v1/store/catalog?platform=ios' })).json() as {
    coinPacks: { id: string; coins: number; tag: unknown }[];
  };

const newPack = {
  id: 'coins_250_promo',
  kind: 'coin_pack',
  title: '250 Coins Tết',
  coins: 250,
  bonusCoins: 50,
  priceUsdMicros: 3_990_000,
  config: { tag: { label: 'TẾT', kind: 'bonus' } },
  iosSku: 'com.storyzio.coins.250tet',
  reason: 'Khuyến mãi Tết',
};

describe('products', () => {
  it('finance creates a pack (inactive by default), activates it → public catalog; CDN purged; audited', async () => {
    const fin = await adminClient(app, 'finance');
    const created = await fin.call('POST', '/v1/admin/products', newPack);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'coins_250_promo', active: false, orders: 0 });
    expect((await catalog()).coinPacks.map((p) => p.id)).not.toContain('coins_250_promo');

    const activated = await fin.call('PATCH', '/v1/admin/products/coins_250_promo', {
      active: true,
      sort: 99,
      reason: 'Mở bán',
    });
    expect(activated.json()).toMatchObject({ active: true, sort: 99 });
    expect((await catalog()).coinPacks.at(-1)).toMatchObject({
      id: 'coins_250_promo',
      coins: 250,
      tag: { label: 'TẾT', kind: 'bonus' },
    });
    expect(purger.purged).toHaveLength(2);
    expect(purger.purged[0]).toEqual([
      '/v1/store/catalog?platform=ios',
      '/v1/store/catalog?platform=android',
      '/v1/store/catalog?platform=web',
    ]);

    const audits = await db().select().from(adminAuditLogs).where(eq(adminAuditLogs.entityId, 'coins_250_promo'));
    expect(audits.map((a) => a.action).sort()).toEqual(['product.create', 'product.update']);
    const update = audits.find((a) => a.action === 'product.update')!;
    expect(update).toMatchObject({ before: { active: false, sort: 0 }, after: { active: true, sort: 99 } });

    const list = (await fin.call('GET', '/v1/admin/products')).json().items;
    expect(list.length).toBeGreaterThan(9);
  });

  it('SKU rules: unique; fill in a missing one any time; never change after a sale', async () => {
    const fin = await adminClient(app, 'finance');
    const dup = await fin.call('POST', '/v1/admin/products', { ...newPack, iosSku: 'com.storyzio.coins.100' });
    expect(dup.statusCode).toBe(409);
    expect((await fin.call('POST', '/v1/admin/products', { ...newPack, id: 'coins_100' })).statusCode).toBe(409);

    await fin.call('POST', '/v1/admin/products', { ...newPack, iosSku: null });
    const filled = await fin.call('PATCH', '/v1/admin/products/coins_250_promo', {
      iosSku: 'com.storyzio.coins.250new',
      androidSku: 'coins_250_new',
      reason: 'Đã tạo SKU trên store',
    });
    expect(filled.json()).toMatchObject({ iosSku: 'com.storyzio.coins.250new', androidSku: 'coins_250_new' });
    // no sale yet → a typo can still be fixed
    const fixed = await fin.call('PATCH', '/v1/admin/products/coins_250_promo', {
      iosSku: 'com.storyzio.coins.250fix',
      reason: 'Sửa lỗi gõ',
    });
    expect(fixed.statusCode).toBe(200);

    // coins_300 sells → its SKU is frozen, other fields stay editable
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: { deviceId: 'device-eco-buyer-1' },
    });
    const call = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: bearer(res.json().accessToken), payload });
    const { appAccountToken } = (
      await call('/v1/payments/intents', { productId: 'coins_300', platform: 'ios' })
    ).json();
    const signedTransaction = apple.sign({ productId: 'com.storyzio.coins.300', appAccountToken });
    expect((await call('/v1/payments/ios/verify', { signedTransaction })).statusCode).toBe(200);

    const frozen = await fin.call('PATCH', '/v1/admin/products/coins_300', {
      iosSku: 'com.storyzio.coins.300b',
      reason: 'đổi SKU',
    });
    expect(frozen.statusCode).toBe(409);
    expect(
      (await fin.call('PATCH', '/v1/admin/products/coins_300', { bonusCoins: 30, reason: 'Tăng bonus' })).json(),
    ).toMatchObject({ bonusCoins: 30, orders: 1 });
  });

  it('validation and permissions', async () => {
    const fin = await adminClient(app, 'finance');
    const bad = [
      { ...newPack, kind: 'subscription' }, // no plan
      { ...newPack, coins: 0 },
      { ...newPack, id: 'Coins 250' },
      { ...newPack, reason: '' },
      { ...newPack, iosSku: 'com storyzio' },
      { ...newPack, config: { tag: { label: 'QUÁ DÀI CHO NHÃN', kind: 'bonus' } } },
    ];
    for (const body of bad) expect((await fin.call('POST', '/v1/admin/products', body)).statusCode).toBe(400);
    expect((await fin.call('PATCH', '/v1/admin/products/coins_300', { coins: 1 })).statusCode).toBe(400); // no reason
    expect((await fin.call('PATCH', '/v1/admin/products/nope_nope', { coins: 1, reason: 'abc' })).statusCode).toBe(404);

    const support = await adminClient(app, 'support');
    expect((await support.call('GET', '/v1/admin/products')).statusCode).toBe(200);
    expect((await support.call('POST', '/v1/admin/products', newPack)).statusCode).toBe(403);
    expect((await (await adminClient(app, 'content_manager')).call('GET', '/v1/admin/products')).statusCode).toBe(403);
  });
});

describe('pricing settings', () => {
  async function storyWithLockedChapters() {
    const story = await createStory(app, { freeChapters: 0, chapterPrice: 10 });
    await createChapters(app, story, 30);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: 'device-eco-reader' } });
    const offers = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/me/stories/${story.id}/offers`,
          headers: bearer(res.json().accessToken),
        })
      ).json().offers as { key: string; percent: number; price: number }[];
    return { offers };
  }

  const value = {
    discounts: [
      { from: 5, percent: 10 },
      { from: 25, percent: 30 },
    ],
    bundleSizes: [5, 25, 5],
    purchaseBonusExpiryDays: 30,
  };

  it('defaults until configured; a saved version applies immediately to unlock offers', async () => {
    const { offers } = await storyWithLockedChapters();
    const fin = await adminClient(app, 'finance');
    const initial = (await fin.call('GET', '/v1/admin/economy/settings')).json();
    expect(initial).toMatchObject({ current: null, scheduled: [], history: [] });
    expect(initial.effective.bundleSizes).toEqual([10, 20, 50]);
    expect((await offers()).map((o) => o.key)).toContain('bundle-10');

    const saved = await fin.call('POST', '/v1/admin/economy/settings', { value, reason: 'Khuyến mãi mùa hè' });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().value).toEqual({
      discounts: [
        { from: 25, percent: 30 },
        { from: 5, percent: 10 },
      ],
      bundleSizes: [5, 25],
      purchaseBonusExpiryDays: 30,
    });
    const now = await offers();
    expect(now.map((o) => o.key)).toEqual(['single', 'bundle-5', 'bundle-25', 'all']);
    expect(now.find((o) => o.key === 'bundle-25')).toMatchObject({ percent: 30, price: 175 });
    const [audit] = await db().select().from(adminAuditLogs).where(eq(adminAuditLogs.action, 'economy.settings'));
    expect(audit).toMatchObject({ reason: 'Khuyến mãi mùa hè', before: { bundleSizes: [10, 20, 50] } });
  });

  it('scheduled changes start on time and can be cancelled before', async () => {
    const { offers } = await storyWithLockedChapters();
    const fin = await adminClient(app, 'finance');
    const soon = new Date(Date.now() + 1500).toISOString();
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await fin.call('POST', '/v1/admin/economy/settings', { value, effectiveFrom: soon, reason: 'Bắt đầu sau' });
    const toCancel = (
      await fin.call('POST', '/v1/admin/economy/settings', { value, effectiveFrom: later, reason: 'Ngày mai' })
    ).json();

    let state = (await fin.call('GET', '/v1/admin/economy/settings')).json();
    expect(state.current).toBeNull();
    expect(state.scheduled).toHaveLength(2);
    expect((await offers()).map((o) => o.key)).toContain('bundle-10'); // not yet

    await new Promise((r) => setTimeout(r, 1600));
    await app.get(PricingSettingsService).invalidate(); // (in production the 30 s cache TTL does this)
    expect((await offers()).map((o) => o.key)).toContain('bundle-25');
    state = (await fin.call('GET', '/v1/admin/economy/settings')).json();
    expect(state.current.reason).toBe('Bắt đầu sau');

    const cancel = (id: string) => fin.call('DELETE', `/v1/admin/economy/settings/${id}`, { reason: 'Đổi kế hoạch' });
    expect((await cancel(toCancel.id)).statusCode).toBe(204);
    expect((await cancel(state.current.id)).statusCode).toBe(404); // already in force: history is immutable
    expect((await fin.call('GET', '/v1/admin/economy/settings')).json().scheduled).toEqual([]);
  });

  it('rejects back-dating and inconsistent tiers', async () => {
    const fin = await adminClient(app, 'finance');
    const post = (body: object) => fin.call('POST', '/v1/admin/economy/settings', { value, reason: 'thử', ...body });
    expect((await post({ effectiveFrom: '2020-01-01T00:00:00.000Z' })).statusCode).toBe(400);
    const tiers = (discounts: object[]) => post({ value: { ...value, discounts } });
    expect(
      (
        await tiers([
          { from: 5, percent: 30 },
          { from: 25, percent: 10 },
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await tiers([
          { from: 5, percent: 10 },
          { from: 5, percent: 20 },
        ])
      ).statusCode,
    ).toBe(400);
    expect((await tiers([{ from: 5, percent: 95 }])).statusCode).toBe(400);
    expect(
      (await (await adminClient(app, 'support')).call('POST', '/v1/admin/economy/settings', { value, reason: 'x y z' }))
        .statusCode,
    ).toBe(403);
  });

  it('purchase bonus coins get the configured expiry', async () => {
    const fin = await adminClient(app, 'finance');
    await fin.call('POST', '/v1/admin/economy/settings', { value, reason: 'Bonus hết hạn sau 30 ngày' });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: 'device-eco-bonus' } });
    const userId = res.json().user.id as string;
    const call = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: bearer(res.json().accessToken), payload });
    const { appAccountToken } = (
      await call('/v1/payments/intents', { productId: 'coins_300', platform: 'ios' })
    ).json();
    await call('/v1/payments/ios/verify', {
      signedTransaction: apple.sign({ productId: 'com.storyzio.coins.300', appAccountToken }),
    });
    const lots = await db()
      .select()
      .from(walletLots)
      .where(and(eq(walletLots.userId, userId)));
    const bonus = lots.find((l) => l.kind === 'bonus')!;
    const paid = lots.find((l) => l.kind === 'paid')!;
    expect(paid.expiresAt).toBeNull();
    expect(Math.abs(bonus.expiresAt!.getTime() - (Date.now() + 30 * 86_400_000))).toBeLessThan(60_000);
  });
});
