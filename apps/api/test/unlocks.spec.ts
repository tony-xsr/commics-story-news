import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chapterUnlocks, walletLedger } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { stripWatermarks } from '../src/modules/content-guard/watermark';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createChapters, createStory } from './factories';
import { bearer, bootApp, resetData } from './helpers';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
});

const db = () => app.get(DbService).write;
let seq = 0;

async function reader(coins = 0) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `device-unlock-${++seq}-x` },
  });
  const { user, accessToken } = res.json();
  if (coins) {
    const wallet = app.get(WalletService);
    await wallet.transaction((tx) =>
      wallet.credit(tx, user.id, {
        currency: 'coins',
        amount: coins,
        kind: 'paid',
        reason: 'purchase',
        idempotencyKey: `seed:${seq}`,
        sourceType: 'test',
      }),
    );
  }
  const headers = bearer(accessToken);
  return {
    id: user.id as string,
    get: (url: string) => app.inject({ method: 'GET', url, headers }),
    unlock: (payload: object, key: string | null = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: '/v1/me/unlocks',
        payload,
        headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
      }),
  };
}

/** Story with 3 free chapters, 10 coins each after, chapter 6 priced 25, chapter 8 a free promo. */
async function pricedStory(count = 15) {
  const story = await createStory(app, { freeChapters: 3, chapterPrice: 10 });
  const chapters = await createChapters(app, story, count, (n) =>
    n === 6 ? { price: 25 } : n === 8 ? { isFree: true } : {},
  );
  return { story, chapters };
}

describe('offers', () => {
  it('lists only chapters the user must pay for, with per-chapter prices and bundle discounts', async () => {
    const { story } = await pricedStory(15);
    const me = await reader(500);
    const res = await me.get(`/v1/me/stories/${story.id}/offers?fromChapter=4`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ storyId: story.id, balance: 500, lockedCount: 11 }); // 4..15 minus promo ch.8
    expect(
      body.offers.map((o: { key: string; chapters: number[]; price: number }) => [o.key, o.chapters.length, o.price]),
    ).toEqual([
      ['single', 1, 10],
      ['bundle-10', 10, 109], // 9×10 + 25 = 115, −5%
      ['all', 11, 118], // 115 + 10 = 125, −5% = 118.75 → 118
    ]);
  });

  it('no offers for free stories or when everything is owned', async () => {
    const free = await createStory(app, { accessModel: 'free' });
    await createChapters(app, free, 5);
    const me = await reader();
    expect((await me.get(`/v1/me/stories/${free.id}/offers`)).json()).toMatchObject({ lockedCount: 0, offers: [] });
  });

  it('requires sign-in', async () => {
    const { story } = await pricedStory(5);
    expect((await app.inject({ method: 'GET', url: `/v1/me/stories/${story.id}/offers` })).statusCode).toBe(401);
  });
});

describe('unlock', () => {
  it('single chapter: charges the price, grants access to the content, shows in state', async () => {
    const { story, chapters } = await pricedStory(6);
    const me = await reader(100);
    expect((await me.get(`/v1/chapters/${chapters[3]!.id}/content`)).statusCode).toBe(402);

    const res = await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ storyId: story.id, chapters: [4], spent: 10, balance: 90 });

    const content = await me.get(`/v1/chapters/${chapters[3]!.id}/content`);
    expect(content.statusCode).toBe(200);
    expect(stripWatermarks(content.json().body)).toBe('Body of chapter 4'); // paid text carries the reader's mark
    expect(content.headers['cache-control']).toBe('private, no-store'); // owned content is never CDN-cached
    expect((await me.get(`/v1/me/stories/${story.id}/state`)).json().unlocked).toEqual([[4, 4]]);
  });

  it('bundle: one ledger entry, per-chapter prices add up to what was charged', async () => {
    const { story } = await pricedStory(15);
    const me = await reader(500);
    const res = await me.unlock({ storyId: story.id, offerKey: 'bundle-10', fromChapter: 4, expectedPrice: 109 });
    expect(res.json()).toMatchObject({ spent: 109, balance: 391 });
    const rows = await db().select().from(chapterUnlocks).where(eq(chapterUnlocks.userId, me.id));
    expect(rows).toHaveLength(10);
    expect(rows.reduce((sum, r) => sum + r.price, 0)).toBe(109);
    expect(rows.find((r) => r.chapterNumber === 6)!.price).toBeGreaterThan(
      rows.find((r) => r.chapterNumber === 4)!.price,
    );
    expect((await me.get(`/v1/me/stories/${story.id}/state`)).json().unlocked).toEqual([
      [4, 7],
      [9, 14],
    ]);
  });

  it('other users still cannot read a chapter someone else bought', async () => {
    const { story, chapters } = await pricedStory(5);
    const buyer = await reader(100);
    const other = await reader(100);
    await buyer.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 });
    expect((await other.get(`/v1/chapters/${chapters[3]!.id}/content`)).statusCode).toBe(402);
    expect((await app.inject({ method: 'GET', url: `/v1/chapters/${chapters[3]!.id}/content` })).statusCode).toBe(402);
  });

  it('not enough coins → 402 INSUFFICIENT_COINS, nothing unlocked', async () => {
    const { story } = await pricedStory(15);
    const me = await reader(50);
    const res = await me.unlock({ storyId: story.id, offerKey: 'bundle-10', fromChapter: 4, expectedPrice: 109 });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ code: 'INSUFFICIENT_COINS', details: { needed: 109, balance: 50 } });
    expect(await db().select().from(chapterUnlocks)).toEqual([]);
  });

  it('client price differs from the server price → 409 PRICE_CHANGED with fresh offers (never charges another price)', async () => {
    const { story } = await pricedStory(6);
    const me = await reader(100);
    const res = await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PRICE_CHANGED');
    expect(res.json().error.details.offers[0]).toMatchObject({ key: 'single', price: 10 });
    expect((await me.get('/v1/me/wallet')).json().coins).toBe(100);
  });

  it('cannot be tricked into buying a different chapter than the one shown', async () => {
    const { story } = await pricedStory(6);
    const me = await reader(100);
    await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 });
    // a stale screen still shows "unlock chapter 4 for 10" — chapter 5 also costs 10 but was NOT what the user saw
    const res = await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.lockedFrom).toBe(5);
    expect((await me.get('/v1/me/wallet')).json().coins).toBe(90);
  });

  it('free chapters can never be bought', async () => {
    const { story } = await pricedStory(6);
    const me = await reader(100);
    const res = await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 2, expectedPrice: 10 });
    expect(res.statusCode).toBe(409); // first locked chapter is 4, not 2
    expect((await me.get('/v1/me/wallet')).json().coins).toBe(100);
  });

  it('everything owned → 409 ALREADY_UNLOCKED', async () => {
    const { story } = await pricedStory(4);
    const me = await reader(100);
    await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 });
    const res = await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 });
    expect(res.json().error.code).toBe('ALREADY_UNLOCKED');
  });
});

describe('idempotency', () => {
  it('Idempotency-Key header is required', async () => {
    const { story } = await pricedStory(5);
    const me = await reader(100);
    const res = await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 }, null);
    expect(res.statusCode).toBe(400);
    const bad = await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 }, 'x');
    expect(bad.statusCode).toBe(400);
  });

  it('a retry with the same key returns the same result and charges once', async () => {
    const { story } = await pricedStory(6);
    const me = await reader(100);
    const key = randomUUID();
    const body = { storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 };
    const first = await me.unlock(body, key);
    const retry = await me.unlock(body, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await me.get('/v1/me/wallet')).json().coins).toBe(90);
    expect(await db().select().from(walletLedger).where(eq(walletLedger.reason, 'unlock'))).toHaveLength(1);
  });

  it('reusing a key for a different request → 409 CONFLICT', async () => {
    const { story } = await pricedStory(15);
    const me = await reader(500);
    const key = randomUUID();
    await me.unlock({ storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 }, key);
    const res = await me.unlock({ storyId: story.id, offerKey: 'all', fromChapter: 5, expectedPrice: 108 }, key);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('double tap / two devices at once with DIFFERENT keys → charged exactly once', async () => {
    const { story } = await pricedStory(6);
    const me = await reader(100);
    const body = { storyId: story.id, offerKey: 'single', fromChapter: 4, expectedPrice: 10 };
    const results = await Promise.all(Array.from({ length: 6 }, () => me.unlock(body)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect((await me.get('/v1/me/wallet')).json().coins).toBe(90);
    expect(await app.get(WalletService).reconcile()).toEqual({ mismatches: 0 });
  });
});
