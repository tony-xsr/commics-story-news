import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertProducts } from '../src/db/products';
import { adminAuditLogs, products, storeNotifications } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { APPLE_STORE } from '../src/modules/payments/stores/apple-store';
import { adminClient } from './admin-helpers';
import { FakeAppleStore } from './fake-stores';
import { bearer, bootApp, resetData } from './helpers';

let app: NestFastifyApplication;
let apple: FakeAppleStore;

beforeAll(async () => {
  apple = new FakeAppleStore();
  app = await bootApp({ overrides: [[APPLE_STORE, apple]] });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
  await upsertProducts(app.get(DbService).write as never);
});

const db = () => app.get(DbService).write;
const today = () => new Date().toISOString().slice(0, 10);
let seq = 0;

async function buyer(name = `Buyer ${++seq}`) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `device-fin-${++seq}-x` },
  });
  const { user, accessToken } = res.json();
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(accessToken), ...(payload ? { payload } : {}) });
  return {
    id: user.id as string,
    name,
    /** Buys on iOS through the real verify endpoint; returns the store transaction. */
    async buy(productId: string, sku: string, extra: object = {}) {
      const { appAccountToken } = (await call('POST', '/v1/payments/intents', { productId, platform: 'ios' })).json();
      const jws = apple.sign({ productId: sku, appAccountToken, ...extra });
      const verified = await call('POST', '/v1/payments/ios/verify', { signedTransaction: jws });
      expect(verified.statusCode).toBe(200);
      return apple.verifyTransaction(jws);
    },
  };
}

const appleWebhook = (signedPayload: string) =>
  app.inject({ method: 'POST', url: '/webhooks/apple', payload: { signedPayload } });

describe('orders & subscriptions', () => {
  it('lists, filters and searches orders; detail has the raw store payload; role-gated', async () => {
    const a = await buyer();
    const b = await buyer();
    const tx300 = await a.buy('coins_300', 'com.storyzio.coins.300', { priceMicros: 129_000_000_000, currency: 'VND' });
    await b.buy('coins_100', 'com.storyzio.coins.100');
    await b.buy('coins_100', 'com.storyzio.coins.100', { environment: 'sandbox' });

    const fin = await adminClient(app, 'finance');
    const all = (await fin.call('GET', '/v1/admin/orders')).json();
    expect(all.items).toHaveLength(3);
    expect(all.items[2]).toMatchObject({
      productId: 'coins_300',
      productTitle: '300 Coins',
      user: { id: a.id },
      platform: 'ios',
      priceMicros: 129_000_000_000,
      currency: 'VND',
      status: 'verified',
    });
    const ids = async (qs: string) =>
      (await fin.call('GET', `/v1/admin/orders?${qs}`)).json().items.map((o: { productId: string }) => o.productId);
    expect(await ids(`q=${tx300.transactionId}`)).toEqual(['coins_300']);
    expect(await ids(`q=${b.id}`)).toEqual(['coins_100', 'coins_100']);
    expect(await ids('environment=sandbox')).toEqual(['coins_100']);
    expect(await ids(`from=${today()}&to=${today()}&productId=coins_300`)).toEqual(['coins_300']);
    expect(await ids('from=2001-01-01&to=2001-01-02')).toEqual([]);

    const page1 = (await fin.call('GET', '/v1/admin/orders?limit=2')).json();
    const page2 = (await fin.call('GET', `/v1/admin/orders?limit=2&cursor=${page1.nextCursor}`)).json();
    expect([...page1.items, ...page2.items].map((o: { id: string }) => o.id)).toEqual(
      all.items.map((o: { id: string }) => o.id),
    );

    const detail = (await fin.call('GET', `/v1/admin/orders/${all.items[2].id}`)).json();
    expect(detail.raw).toBeTruthy();

    expect((await (await adminClient(app, 'support')).call('GET', '/v1/admin/orders')).statusCode).toBe(200);
    expect((await (await adminClient(app, 'content_manager')).call('GET', '/v1/admin/orders')).statusCode).toBe(403);
  });

  it('subscription list + detail with every billing period', async () => {
    const a = await buyer();
    const first = await a.buy('premium_monthly', 'com.storyzio.premium.monthly');
    // renewal arrives by webhook
    const renewal = apple.sign({
      productId: 'com.storyzio.premium.monthly',
      originalTransactionId: first.originalTransactionId,
      purchaseDate: new Date(Date.now() + 1000),
      expiresDate: new Date(Date.now() + 60 * 86_400_000),
    });
    const res = await appleWebhook(
      apple.notify({
        type: 'DID_RENEW',
        subtype: null,
        transaction: await apple.verifyTransaction(renewal),
        renewal: null,
      }),
    );
    expect(res.statusCode).toBe(200);

    const fin = await adminClient(app, 'finance');
    const list = (await fin.call('GET', '/v1/admin/subscriptions?plan=monthly')).json();
    expect(list.items).toEqual([
      expect.objectContaining({ plan: 'monthly', status: 'active', user: expect.objectContaining({ id: a.id }) }),
    ]);
    const detail = (await fin.call('GET', `/v1/admin/subscriptions/${list.items[0].id}`)).json();
    expect(detail.orders).toHaveLength(2);
    expect((await fin.call('GET', '/v1/admin/subscriptions?status=expired')).json().items).toEqual([]);
  });
});

describe('store webhooks (dead letters)', () => {
  it('failed notifications are listed; only super admin can replay; a fixed cause makes the replay succeed', async () => {
    const tx = await apple.verifyTransaction(apple.sign({ productId: 'com.storyzio.coins.777' }));
    const res = await appleWebhook(
      apple.notify({ type: 'ONE_TIME_CHARGE', subtype: null, transaction: tx, renewal: null }),
    );
    expect(res.statusCode).toBe(500); // unknown product → stored with error, Apple retries

    const fin = await adminClient(app, 'finance');
    const failed = (await fin.call('GET', '/v1/admin/store-notifications')).json().items;
    expect(failed).toEqual([
      expect.objectContaining({
        provider: 'apple',
        type: 'ONE_TIME_CHARGE',
        processedAt: null,
        error: expect.stringMatching(/unknown product/),
      }),
    ]);
    const id = failed[0].id;
    expect((await fin.call('GET', `/v1/admin/store-notifications/${id}`)).json().payload.transaction.productId).toBe(
      'com.storyzio.coins.777',
    );
    expect((await fin.call('POST', `/v1/admin/store-notifications/${id}/replay`)).statusCode).toBe(403);

    const sa = await adminClient(app, 'super_admin');
    const stillFailing = (await sa.call('POST', `/v1/admin/store-notifications/${id}/replay`)).json();
    expect(stillFailing).toEqual({ ok: false, error: expect.stringMatching(/unknown product/) });

    await db()
      .insert(products)
      .values({ id: 'coins_777', kind: 'coin_pack', title: '777 Coins', coins: 777, iosSku: 'com.storyzio.coins.777' });
    expect((await sa.call('POST', `/v1/admin/store-notifications/${id}/replay`)).json()).toEqual({
      ok: true,
      error: null,
    });
    const [row] = await db().select().from(storeNotifications).where(eq(storeNotifications.id, id));
    expect(row).toMatchObject({ error: null, processedAt: expect.any(Date) });
    expect((await sa.call('GET', '/v1/admin/store-notifications')).json().items).toEqual([]);
    expect((await sa.call('GET', '/v1/admin/store-notifications?state=processed')).json().items).toHaveLength(1);

    const audits = await db()
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.action, 'store_notification.replay'));
    expect(audits).toHaveLength(2);
  });
});

describe('revenue report', () => {
  it('estimates USD from product prices, reports real money per currency, MRR and coin flows', async () => {
    const a = await buyer();
    const b = await buyer();
    await a.buy('coins_300', 'com.storyzio.coins.300', { priceMicros: 129_000_000_000, currency: 'VND' }); // $4.99 ref
    const refunded = await b.buy('coins_100', 'com.storyzio.coins.100'); // $1.99, refunded below
    await b.buy('premium_monthly', 'com.storyzio.premium.monthly'); // $9.99
    await a.buy('coins_100', 'com.storyzio.coins.100', { environment: 'sandbox' }); // excluded
    await appleWebhook(
      apple.notify({
        type: 'REFUND',
        subtype: null,
        transaction: { ...refunded, revocationDate: new Date() },
        renewal: null,
      }),
    );

    const fin = await adminClient(app, 'finance');
    const r = (await fin.call('GET', `/v1/admin/revenue?from=${today()}&to=${today()}`)).json();
    expect(r.totals).toEqual({
      orders: 3,
      refunds: 1,
      estimatedUsdGrossMicros: 4_990_000 + 9_990_000,
      estimatedUsdNetMicros: Math.round((4_990_000 + 9_990_000) * 0.7),
    });
    expect(r.days).toEqual([{ date: today(), platform: 'ios', orders: 3, refunds: 1, estimatedUsdMicros: 14_980_000 }]);
    expect(r.byCurrency).toEqual(
      expect.arrayContaining([
        { currency: 'VND', grossMicros: 129_000_000_000, refundedMicros: 0 },
        { currency: 'USD', grossMicros: 4_990_000 * 2, refundedMicros: 4_990_000 },
      ]),
    );
    expect(r.subscriptions).toEqual({ active: 1, byPlan: { monthly: 1 }, estimatedMrrUsdMicros: 9_990_000 });
    expect(r.coins).toMatchObject({ sold: 300 + 100 + 100, bonusGranted: 15, clawedBack: 100, spent: 0 });
    expect(r.coins.unspentPaid).toBe(400); // 300 + sandbox 100 (ledger has no environment) — refunded 100 clawed back
    expect(r.coins.deferredRevenueMicros).toBeGreaterThan(0);

    expect((await fin.call('GET', '/v1/admin/revenue?from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await fin.call('GET', '/v1/admin/revenue?from=2024-01-01&to=2026-01-01')).statusCode).toBe(400);
  });
});
