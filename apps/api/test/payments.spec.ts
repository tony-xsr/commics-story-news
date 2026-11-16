import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertProducts } from '../src/db/products';
import { orders, subscriptions, walletLedger, walletLots } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { PUBSUB_VERIFIER } from '../src/modules/payments/store-notifications.service';
import { accountHash } from '../src/modules/payments/purchases.service';
import { APPLE_STORE } from '../src/modules/payments/stores/apple-store';
import { GOOGLE_PLAY } from '../src/modules/payments/stores/google-play';
import { SubscriptionsService } from '../src/modules/payments/subscriptions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createChapters, createStory } from './factories';
import { adminClient } from './admin-helpers';
import { createFakeIdp, GOOGLE_AUDIENCE } from './fake-idp';
import { FakeAppleStore, FakeGooglePlay } from './fake-stores';
import { bearer, bootApp, resetData } from './helpers';

const PUBSUB_SA = 'rtdn-push@storyzio.iam.gserviceaccount.com';
let app: NestFastifyApplication;
let apple: FakeAppleStore;
let google: FakeGooglePlay;
let pubsubIdp: Awaited<ReturnType<typeof createFakeIdp>>;

beforeAll(async () => {
  vi.stubEnv('GOOGLE_PUBSUB_SERVICE_ACCOUNT', PUBSUB_SA);
  apple = new FakeAppleStore();
  google = new FakeGooglePlay();
  pubsubIdp = await createFakeIdp('google');
  app = await bootApp({
    overrides: [
      [APPLE_STORE, apple],
      [GOOGLE_PLAY, google],
      [PUBSUB_VERIFIER, pubsubIdp.verifier],
    ],
  });
});
afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await resetData(app);
  await upsertProducts(app.get(DbService).write as never);
});

const db = () => app.get(DbService).write;
let seq = 0;

async function buyer() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `device-pay-${++seq}-xx` },
  });
  const { user, accessToken } = res.json();
  const headers = bearer(accessToken);
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return {
    id: user.id as string,
    call,
    intent: async (productId: string, platform: 'ios' | 'android' = 'ios') =>
      (await call('POST', '/v1/payments/intents', { productId, platform })).json(),
    verifyIos: (signedTransaction: string) => call('POST', '/v1/payments/ios/verify', { signedTransaction }),
    verifyAndroid: (productId: string, purchaseToken: string, subscription = false) =>
      call('POST', '/v1/payments/android/verify', { productId, purchaseToken, subscription }),
    coins: async () => (await call('GET', '/v1/me/wallet')).json().coins as number,
    premium: async () => (await call('GET', '/v1/me/entitlements')).json().premium,
  };
}

const appleWebhook = (signedPayload: string) =>
  app.inject({ method: 'POST', url: '/webhooks/apple', payload: { signedPayload } });

async function googleWebhook(data: object, opts: { email?: string; token?: string | null } = {}) {
  const token =
    opts.token === undefined
      ? await pubsubIdp.sign(
          { sub: '1234', email: opts.email ?? PUBSUB_SA, email_verified: true },
          { aud: GOOGLE_AUDIENCE },
        )
      : opts.token;
  return app.inject({
    method: 'POST',
    url: '/webhooks/google',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: {
      message: {
        data: Buffer.from(JSON.stringify({ packageName: 'com.storyzio.app', ...data })).toString('base64'),
        messageId: randomUUID(),
      },
    },
  });
}

describe('catalog & intents', () => {
  it('lists coin packs and plans with the platform SKUs (public, CDN-cacheable)', async () => {
    const ios = await app.inject({ method: 'GET', url: '/v1/store/catalog?platform=ios' });
    expect(ios.headers['cache-control']).toContain('s-maxage=300');
    const body = ios.json();
    expect(body.coinPacks.map((p: { sku: string }) => p.sku)).toContain('com.storyzio.coins.300');
    expect(body.coinPacks.find((p: { id: string }) => p.id === 'coins_300')).toMatchObject({
      coins: 300,
      bonusCoins: 15,
      tag: { label: 'X2' },
    });
    expect(body.plans.map((p: { plan: string }) => p.plan)).toEqual(['weekly', 'monthly', 'yearly']);
    const android = (await app.inject({ method: 'GET', url: '/v1/store/catalog?platform=android' })).json();
    expect(android.plans[1]).toMatchObject({ sku: 'premium', basePlanId: 'monthly' });
  });

  it('intent returns the appAccountToken / obfuscated account id', async () => {
    const me = await buyer();
    const intent = await me.intent('coins_300');
    expect(intent).toMatchObject({ sku: 'com.storyzio.coins.300', obfuscatedAccountId: accountHash(me.id) });
    expect(intent.appAccountToken).toMatch(/^[0-9a-f-]{36}$/);
    expect((await me.call('POST', '/v1/payments/intents', { productId: 'nope', platform: 'ios' })).statusCode).toBe(
      404,
    );
  });
});

describe('iOS coin packs', () => {
  it('verifies, credits paid + bonus lots with revenue value, records the order', async () => {
    const me = await buyer();
    const { appAccountToken } = await me.intent('coins_300');
    const res = await me.verifyIos(apple.sign({ productId: 'com.storyzio.coins.300', appAccountToken }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'coin_pack',
      productId: 'coins_300',
      alreadyProcessed: false,
      coins: 315,
    });

    const lots = await db().select().from(walletLots).where(eq(walletLots.userId, me.id));
    expect(lots.map((l) => [l.kind, l.amount]).sort()).toEqual([
      ['bonus', 15],
      ['paid', 300],
    ]);
    expect(lots.find((l) => l.kind === 'paid')!.unitValueMicros).toBe(Math.round((4_990_000 * 0.7) / 300));
    expect(await db().select().from(orders).where(eq(orders.userId, me.id))).toHaveLength(1);
  });

  it('retry / restore of the same transaction credits once', async () => {
    const me = await buyer();
    const { appAccountToken } = await me.intent('coins_100');
    const jws = apple.sign({ productId: 'com.storyzio.coins.100', appAccountToken });
    await me.verifyIos(jws);
    const again = await me.verifyIos(jws);
    expect(again.json()).toMatchObject({ alreadyProcessed: true, coins: 100 });
  });

  it('a purchase made for another account cannot be claimed (receipt sharing)', async () => {
    const owner = await buyer();
    const thief = await buyer();
    const { appAccountToken } = await owner.intent('coins_500');
    const jws = apple.sign({ productId: 'com.storyzio.coins.500', appAccountToken });
    const res = await thief.verifyIos(jws);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PURCHASE_OWNED_BY_OTHER_USER');
    expect(await thief.coins()).toBe(0);
  });

  it('rejects forged JWS, unknown SKUs and coin purchases without our account token', async () => {
    const me = await buyer();
    expect((await me.verifyIos(`forged.${'x'.repeat(60)}`)).json().error.code).toBe('PURCHASE_INVALID');
    const { appAccountToken } = await me.intent('coins_100');
    expect((await me.verifyIos(apple.sign({ productId: 'com.other.app.coins', appAccountToken }))).statusCode).toBe(
      400,
    );
    expect((await me.verifyIos(apple.sign({ productId: 'com.storyzio.coins.100' }))).json().error.code).toBe(
      'PURCHASE_INVALID',
    );
    expect(await me.coins()).toBe(0);
  });

  it('sandbox purchases (App Review / TestFlight) work and are recorded as sandbox', async () => {
    const me = await buyer();
    const { appAccountToken } = await me.intent('coins_100');
    await me.verifyIos(apple.sign({ productId: 'com.storyzio.coins.100', appAccountToken, environment: 'sandbox' }));
    const [order] = await db().select().from(orders).where(eq(orders.userId, me.id));
    expect(order!.environment).toBe('sandbox');
  });
});

describe('payment settings (admin → Cấu hình thanh toán)', () => {
  it('sandbox only for listed testers; unknown testers rejected; store ids fall back to env; finance-only edits', async () => {
    const admin = await adminClient(app, 'super_admin');
    const tester = await buyer();
    const other = await buyer();
    const sandboxBuy = async (me: Awaited<ReturnType<typeof buyer>>) => {
      const { appAccountToken } = await me.intent('coins_100');
      return me.verifyIos(apple.sign({ productId: 'com.storyzio.coins.100', appAccountToken, environment: 'sandbox' }));
    };

    // default (nothing saved): env PAYMENTS_ALLOW_SANDBOX=true → everyone
    const initial = (await admin.call('GET', '/v1/admin/payments/settings')).json();
    expect(initial).toMatchObject({
      sandbox: 'all',
      testers: [],
      appleBundleId: null,
      effective: { sandboxAllowedByServer: true },
    });
    expect(initial.effective.appleBundleId).toBeTruthy();

    const save = (body: object) =>
      admin.call('PUT', '/v1/admin/payments/settings', { reason: 'Chỉ tester mua sandbox', ...body });
    expect((await save({ sandbox: 'testers', testers: ['nobody@x.test'] })).statusCode).toBe(400); // unknown account
    const saved = await save({ sandbox: 'testers', testers: [tester.id], googlePackageName: 'com.storyzio.next' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      sandbox: 'testers',
      testers: [{ id: tester.id }],
      effective: { googlePackageName: 'com.storyzio.next' },
    });

    expect((await sandboxBuy(tester)).statusCode).toBe(200);
    const denied = await sandboxBuy(other);
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe('PURCHASE_INVALID');
    expect(await other.coins()).toBe(0);

    expect((await save({ sandbox: 'off' })).statusCode).toBe(200);
    expect((await sandboxBuy(tester)).statusCode).toBe(400);
    expect((await save({ sandbox: 'all', appleBundleId: 'not a bundle' })).statusCode).toBe(400);

    expect(
      (
        await (
          await adminClient(app, 'content_manager')
        ).call('PUT', '/v1/admin/payments/settings', { sandbox: 'all', reason: 'thử quyền' })
      ).statusCode,
    ).toBe(403);
  });
});

describe('Android coin packs', () => {
  it('verifies, credits once and acknowledges (Google refunds unacknowledged purchases after 3 days)', async () => {
    const me = await buyer();
    const intent = await me.intent('coins_1000', 'android');
    google.addProduct('tok-1000-purchase-token', {
      productId: 'coins_1000',
      obfuscatedAccountId: intent.obfuscatedAccountId,
      obfuscatedProfileId: intent.intentId,
    });
    const res = await me.verifyAndroid('coins_1000', 'tok-1000-purchase-token');
    expect(res.json()).toMatchObject({ coins: 1150, alreadyProcessed: false });
    expect(google.acks).toContain('tok-1000-purchase-token');
    expect((await me.verifyAndroid('coins_1000', 'tok-1000-purchase-token')).json().alreadyProcessed).toBe(true);
    expect(await me.coins()).toBe(1150);
  });

  it('pending payments and purchases for another account are refused', async () => {
    const me = await buyer();
    const other = await buyer();
    google.addProduct('tok-pending-purchase-token', {
      productId: 'coins_100',
      state: 'pending',
      obfuscatedAccountId: accountHash(me.id),
    });
    expect((await me.verifyAndroid('coins_100', 'tok-pending-purchase-token')).json().error.message).toContain(
      'pending',
    );
    google.addProduct('tok-other-purchase-token', {
      productId: 'coins_100',
      obfuscatedAccountId: accountHash(other.id),
    });
    expect((await me.verifyAndroid('coins_100', 'tok-other-purchase-token')).statusCode).toBe(409);
    expect(await me.coins()).toBe(0);
  });
});

describe('Premium (iOS subscription)', () => {
  async function subscribed(productId = 'premium_monthly', tx: Record<string, unknown> = {}) {
    const me = await buyer();
    const { appAccountToken } = await me.intent(productId);
    const sku = `com.storyzio.premium.${productId.split('_')[1]}`;
    const jws = apple.sign({ productId: sku, appAccountToken, ...tx });
    const res = await me.verifyIos(jws);
    return { me, res, appAccountToken, sku, original: (await apple.verifyTransaction(jws)).originalTransactionId };
  }

  it('grants Premium + the period points; reads premium_or_coins chapters but not coins_only ones', async () => {
    const { me, res } = await subscribed();
    expect(res.json().entitlements.premium).toMatchObject({
      active: true,
      plan: 'monthly',
      status: 'active',
      source: 'ios',
    });
    expect((await me.call('GET', '/v1/me/wallet')).json().points).toBe(10_000); // 100 points

    const premiumStory = await createStory(app, { freeChapters: 1, accessModel: 'premium_or_coins' });
    const [, p2] = await createChapters(app, premiumStory, 2);
    const coinsOnly = await createStory(app, { freeChapters: 1, accessModel: 'coins_only' });
    const [, c2] = await createChapters(app, coinsOnly, 2);

    expect((await me.call('GET', `/v1/chapters/${p2!.id}/content`)).statusCode).toBe(200);
    expect((await me.call('GET', `/v1/chapters/${c2!.id}/content`)).statusCode).toBe(402);
    expect((await me.call('GET', `/v1/me/stories/${premiumStory.id}/offers`)).json()).toMatchObject({
      coveredByPremium: true,
      offers: [],
    });
    expect((await me.call('GET', `/v1/me/stories/${coinsOnly.id}/offers`)).json().coveredByPremium).toBe(false);
  });

  it('free trial: Premium yes, bonus points no (no trial-cancel farming)', async () => {
    const { me, res } = await subscribed('premium_monthly', { isTrial: true });
    expect(res.json().entitlements.premium.status).toBe('trial');
    expect((await me.call('GET', '/v1/me/wallet')).json().points).toBe(0);
  });

  it('renewal notification extends access and grants the new period points once (duplicates ignored)', async () => {
    const { me, sku, original, appAccountToken } = await subscribed();
    const renewal = apple.notify({
      type: 'DID_RENEW',
      subtype: null,
      transaction: {
        ...(await apple.verifyTransaction(
          apple.sign({ productId: sku, originalTransactionId: original, appAccountToken }),
        )),
        transactionId: 'renew-2',
        expiresDate: new Date(Date.now() + 60 * 86_400_000),
      },
      renewal: { autoRenew: true, gracePeriodExpiresDate: null, inBillingRetry: false },
      id: 'uuid-renew-2',
    });
    expect((await appleWebhook(renewal)).json()).toEqual({ status: 'processed' });
    expect((await appleWebhook(renewal)).json()).toEqual({ status: 'duplicate' });
    expect((await me.call('GET', '/v1/me/wallet')).json().points).toBe(20_000);
    expect(new Date((await me.premium()).expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 86_400_000);
  });

  async function notifyStatus(sku: string, original: string, type: string, subtype: string | null, extra: object = {}) {
    const tx = await apple.verifyTransaction(apple.sign({ productId: sku, originalTransactionId: original }));
    return appleWebhook(apple.notify({ type, subtype, transaction: { ...tx, ...extra }, renewal: null }));
  }

  it('auto-renew turned off → canceled but still Premium until the period ends', async () => {
    const { me, sku, original } = await subscribed();
    await notifyStatus(sku, original, 'DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED');
    expect(await me.premium()).toMatchObject({ active: true, status: 'canceled', willRenew: false });
  });

  it('expired → Premium gone, premium chapters locked again', async () => {
    const { me, sku, original } = await subscribed();
    const story = await createStory(app, { freeChapters: 0 });
    const [c1] = await createChapters(app, story, 1);
    expect((await me.call('GET', `/v1/chapters/${c1!.id}/content`)).statusCode).toBe(200);
    await notifyStatus(sku, original, 'EXPIRED', 'VOLUNTARY', { expiresDate: new Date(Date.now() - 1000) });
    expect(await me.premium()).toBeNull();
    expect((await me.call('GET', `/v1/chapters/${c1!.id}/content`)).statusCode).toBe(402);
  });

  it('billing failure with grace period keeps Premium until the grace end', async () => {
    const { me, sku, original } = await subscribed();
    const tx = await apple.verifyTransaction(apple.sign({ productId: sku, originalTransactionId: original }));
    const graceEnd = new Date(Date.now() + 16 * 86_400_000);
    await appleWebhook(
      apple.notify({
        type: 'DID_FAIL_TO_RENEW',
        subtype: 'GRACE_PERIOD',
        transaction: { ...tx, expiresDate: new Date(Date.now() - 1000) },
        renewal: { autoRenew: true, gracePeriodExpiresDate: graceEnd, inBillingRetry: true },
      }),
    );
    expect(await me.premium()).toMatchObject({ active: true, status: 'grace_period' });
  });

  it('refund → revoked immediately', async () => {
    const { me, sku, original } = await subscribed();
    await notifyStatus(sku, original, 'REFUND', null, { revocationDate: new Date() });
    expect(await me.premium()).toBeNull();
  });

  it('cannot buy Premium on Android while subscribed on iOS (no double charge)', async () => {
    const { me } = await subscribed();
    const res = await me.call('POST', '/v1/payments/intents', { productId: 'premium_monthly', platform: 'android' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'ALREADY_SUBSCRIBED_ON_OTHER_PLATFORM',
      details: { platform: 'ios' },
    });
  });

  it('yearly: signup bonus once + monthly points once per month (worker job)', async () => {
    const { me } = await subscribed('premium_yearly', { expiresDate: new Date(Date.now() + 365 * 86_400_000) });
    expect((await me.call('GET', '/v1/me/wallet')).json().points).toBe(100_000);
    const subs = app.get(SubscriptionsService);
    expect(await subs.grantMonthlyPoints()).toBe(1);
    expect(await subs.grantMonthlyPoints()).toBe(0);
    expect((await me.call('GET', '/v1/me/wallet')).json().points).toBe(120_000);
  });

  it('restore without account token claims an unowned subscription; never one owned by someone else', async () => {
    const me = await buyer();
    const jws = apple.sign({ productId: 'com.storyzio.premium.weekly' });
    const restored = (await me.call('POST', '/v1/payments/restore', { ios: [jws] })).json();
    expect(restored).toMatchObject({ restored: 1, failed: 0, entitlements: { premium: { plan: 'weekly' } } });
    const other = await buyer();
    expect((await other.call('POST', '/v1/payments/restore', { ios: [jws] })).json()).toMatchObject({
      restored: 0,
      failed: 1,
    });
    expect(await other.premium()).toBeNull();
  });
});

describe('refunds (coins)', () => {
  it('Apple refund after spending: coins clawed back into debt, spending blocked, books stay consistent', async () => {
    const me = await buyer();
    const { appAccountToken } = await me.intent('coins_100');
    const jws = apple.sign({ productId: 'com.storyzio.coins.100', appAccountToken });
    await me.verifyIos(jws);
    const wallet = app.get(WalletService);
    await wallet.transaction((tx) =>
      wallet.debit(tx, me.id, { currency: 'coins', amount: 60, reason: 'unlock', idempotencyKey: 'spend-1' }),
    );

    const tx = await apple.verifyTransaction(jws);
    expect(
      (
        await appleWebhook(
          apple.notify({
            type: 'REFUND',
            subtype: null,
            transaction: { ...tx, revocationDate: new Date() },
            renewal: null,
          }),
        )
      ).statusCode,
    ).toBe(200);

    const [debt] = await db().select().from(walletLedger).where(eq(walletLedger.reason, 'refund_clawback'));
    expect(debt).toMatchObject({ delta: -100, balanceAfter: -60 });
    expect((await me.call('GET', '/v1/me/wallet')).json()).toMatchObject({ coins: 0, coinDebt: 60 });
    await expect(
      wallet.transaction((t) =>
        wallet.debit(t, me.id, { currency: 'coins', amount: 1, reason: 'unlock', idempotencyKey: 'spend-2' }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });
    expect(await wallet.reconcile()).toEqual({ mismatches: 0 });
    // a refunded transaction can't be re-verified for coins
    expect((await me.verifyIos(jws)).statusCode).toBe(400);
  });

  it('CONSUMPTION_REQUEST: tells Apple how much of the pack / period was used (no refund once all spent)', async () => {
    const me = await buyer();
    const { appAccountToken } = await me.intent('coins_100');
    const jws = apple.sign({ productId: 'com.storyzio.coins.100', appAccountToken });
    await me.verifyIos(jws);
    const tx = await apple.verifyTransaction(jws);
    const ask = (transaction = tx) =>
      appleWebhook(apple.notify({ type: 'CONSUMPTION_REQUEST', subtype: null, transaction, renewal: null }));
    const wallet = app.get(WalletService);
    const spend = (amount: number, key: string) =>
      wallet.transaction((t) =>
        wallet.debit(t, me.id, { currency: 'coins', amount, reason: 'unlock', idempotencyKey: key }),
      );

    expect((await ask()).statusCode).toBe(200);
    await spend(60, 'c-1');
    await ask();
    await spend(40, 'c-2');
    await ask();
    // never credited to anyone (unknown transaction id) → not delivered
    await ask({ ...tx, transactionId: '2000000999' });
    // subscription: share of the period already elapsed (10 of 30 days)
    await ask({
      ...tx,
      productId: 'com.storyzio.premium.monthly',
      kind: 'subscription',
      purchaseDate: new Date(Date.now() - 10 * 86_400_000),
      expiresDate: new Date(Date.now() + 20 * 86_400_000),
    });

    const sent = apple.consumption.slice(-5).map((c) => c.info);
    expect(sent.slice(0, 4)).toEqual([
      { consumptionPercentage: 0, delivered: true, refundPreference: 'GRANT_FULL' },
      { consumptionPercentage: 60_000, delivered: true, refundPreference: 'GRANT_PRORATED' },
      { consumptionPercentage: 100_000, delivered: true, refundPreference: 'DECLINE' },
      { consumptionPercentage: 0, delivered: false, refundPreference: 'GRANT_FULL' },
    ]);
    expect(sent[4]!.consumptionPercentage).toBeCloseTo(33_333, -2);
    expect(sent[4]!.refundPreference).toBe('GRANT_PRORATED');
    // answering never changes the wallet
    expect(await wallet.reconcile()).toEqual({ mismatches: 0 });
  });
});

describe('Google RTDN webhook', () => {
  it('rejects requests without a valid Pub/Sub token or from another sender', async () => {
    expect((await googleWebhook({ testNotification: {} }, { token: null })).statusCode).toBe(401);
    expect((await googleWebhook({ testNotification: {} }, { token: 'garbage.token.here' })).statusCode).toBe(401);
    expect(
      (await googleWebhook({ testNotification: {} }, { email: 'attacker@evil.iam.gserviceaccount.com' })).statusCode,
    ).toBe(401);
    expect((await googleWebhook({ testNotification: {} })).statusCode).toBe(200);
  });

  it('subscription purchased → Premium for the user behind the intent', async () => {
    const me = await buyer();
    const intent = await me.intent('premium_monthly', 'android');
    google.addSubscription('sub-tok-1-purchase-token', {
      obfuscatedAccountId: intent.obfuscatedAccountId,
      obfuscatedProfileId: intent.intentId,
    });
    const res = await googleWebhook({
      subscriptionNotification: { purchaseToken: 'sub-tok-1-purchase-token', notificationType: 4 },
    });
    expect(res.json()).toEqual({ status: 'processed' });
    expect(await me.premium()).toMatchObject({ active: true, source: 'android', plan: 'monthly' });
    expect(google.acks).toContain('sub-tok-1-purchase-token');
  });

  it('upgrade (linked purchase token) replaces the old subscription', async () => {
    const me = await buyer();
    const intent = await me.intent('premium_monthly', 'android');
    google.addSubscription('old-tok-purchase-token', {
      obfuscatedAccountId: intent.obfuscatedAccountId,
      obfuscatedProfileId: intent.intentId,
    });
    await me.verifyAndroid('premium', 'old-tok-purchase-token', true);
    google.addSubscription('new-tok-purchase-token', {
      basePlanId: 'yearly',
      expiryTime: new Date(Date.now() + 365 * 86_400_000),
      linkedPurchaseToken: 'old-tok-purchase-token',
      obfuscatedAccountId: intent.obfuscatedAccountId,
      obfuscatedProfileId: intent.intentId,
    });
    await me.verifyAndroid('premium', 'new-tok-purchase-token', true);
    const rows = await db().select().from(subscriptions).where(eq(subscriptions.userId, me.id));
    expect(rows.map((r) => [r.originalId, r.status]).sort()).toEqual([
      ['new-tok-purchase-token', 'active'],
      ['old-tok-purchase-token', 'replaced'],
    ]);
    expect(await me.premium()).toMatchObject({ plan: 'yearly' });
  });

  it('offer codes: redeemed outside our purchase flow (no account token) still unlock Premium for this account', async () => {
    // iOS: Apple's redemption sheet can't carry appAccountToken; the app sends the transaction on its next start.
    const ios = await buyer();
    const code = apple.sign({ productId: 'com.storyzio.premium.monthly', offerCode: true });
    expect((await ios.verifyIos(code)).statusCode).toBe(200);
    expect(await ios.premium()).toMatchObject({ active: true, source: 'ios' });
    // …claimed once: another account on the device can't take it over.
    const other = await buyer();
    expect((await other.verifyIos(code)).statusCode).toBeGreaterThanOrEqual(400);
    // A token-less purchase WITHOUT an offer code is still refused outside a restore.
    const plain = apple.sign({ productId: 'com.storyzio.premium.monthly' });
    expect((await (await buyer()).verifyIos(plain)).json().error.code).toBe('PURCHASE_INVALID');

    // Android: promo code redeemed in the Play Store (no obfuscated account id).
    const android = await buyer();
    google.addSubscription('promo-tok-purchase-token', { redeemedCode: true });
    expect((await android.verifyAndroid('premium', 'promo-tok-purchase-token', true)).statusCode).toBe(200);
    expect(await android.premium()).toMatchObject({ active: true, source: 'android' });
    google.addSubscription('anon-tok-purchase-token', {});
    expect((await (await buyer()).verifyAndroid('premium', 'anon-tok-purchase-token', true)).statusCode).toBe(409);
  });

  it('switching plan on Android: the intent tells the app which purchase to replace and how', async () => {
    const me = await buyer();
    const first = await me.intent('premium_monthly', 'android');
    expect(first.replace).toBeNull();
    google.addSubscription('live-tok-purchase-token', {
      obfuscatedAccountId: first.obfuscatedAccountId,
      obfuscatedProfileId: first.intentId,
    });
    await me.verifyAndroid('premium', 'live-tok-purchase-token', true);

    // Longer plan → now (time left carried over); shorter → from the next renewal; same plan → refused.
    expect((await me.intent('premium_yearly', 'android')).replace).toEqual({
      purchaseToken: 'live-tok-purchase-token',
      mode: 'immediate',
    });
    expect((await me.intent('premium_weekly', 'android')).replace).toEqual({
      purchaseToken: 'live-tok-purchase-token',
      mode: 'deferred',
    });
    const same = await me.call('POST', '/v1/payments/intents', { productId: 'premium_monthly', platform: 'android' });
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('ALREADY_ON_THIS_PLAN');
    // Coin packs are never replacements.
    expect((await me.intent('coins_300', 'android')).replace).toBeNull();
  });

  it('one-time purchase completed while the app crashed is credited by the webhook — and only once', async () => {
    const me = await buyer();
    const intent = await me.intent('coins_300', 'android');
    google.addProduct('crash-tok-purchase-token', {
      productId: 'coins_300',
      obfuscatedAccountId: intent.obfuscatedAccountId,
      obfuscatedProfileId: intent.intentId,
    });
    await googleWebhook({
      oneTimeProductNotification: { purchaseToken: 'crash-tok-purchase-token', sku: 'coins_300', notificationType: 1 },
    });
    expect(await me.coins()).toBe(315);
    expect((await me.verifyAndroid('coins_300', 'crash-tok-purchase-token')).json().alreadyProcessed).toBe(true);
    expect(await me.coins()).toBe(315);
  });

  it('voided purchase → coins clawed back', async () => {
    const me = await buyer();
    const intent = await me.intent('coins_100', 'android');
    google.addProduct('void-tok-purchase-token', {
      productId: 'coins_100',
      obfuscatedAccountId: intent.obfuscatedAccountId,
    });
    await me.verifyAndroid('coins_100', 'void-tok-purchase-token');
    const orderId = google.products.get('void-tok-purchase-token')!.orderId;
    await googleWebhook({
      voidedPurchaseNotification: { purchaseToken: 'void-tok-purchase-token', orderId, productType: 2 },
    });
    expect(await me.coins()).toBe(0);
    const [order] = await db().select().from(orders).where(eq(orders.storeTxnId, orderId));
    expect(order!.status).toBe('refunded');
  });

  it('rejects notifications for another app package', async () => {
    const res = await googleWebhook({ packageName: 'com.evil.app', testNotification: {} });
    expect(res.statusCode).toBe(403);
  });
});
