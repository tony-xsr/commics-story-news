import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { giftCodes, users, walletLots } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { adminClient } from './admin-helpers';
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

async function member(guest = false) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: `device-gift-${++seq}-x` } });
  const id = res.json().user.id as string;
  if (!guest) await db().update(users).set({ isGuest: false }).where(eq(users.id, id));
  const redeem = (code: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/me/gift-codes/redeem',
      headers: bearer(res.json().accessToken),
      payload: { code },
    });
  return { id, redeem };
}

const create = async (body: object) => {
  const admin = await adminClient(app, 'finance');
  return admin.call('POST', '/v1/admin/gift-codes', { maxUses: null, reason: 'Sự kiện Tết', ...body });
};

describe('redeem', () => {
  it('credits coins (expiring bonus lot) and points once per user; codes are case / space insensitive', async () => {
    expect(
      (await create({ code: 'TET2027', reward: { coins: 50, points: 10, coinExpiryDays: 30 } })).statusCode,
    ).toBe(201);
    const m = await member();
    const res = await m.redeem(' tet 2027 ');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ coins: 50, points: 10, balance: { coins: 50, points: 10 } });
    const [lot] = await db().select().from(walletLots).where(eq(walletLots.userId, m.id));
    expect(lot).toMatchObject({ kind: 'bonus', sourceType: 'gift_code' });
    expect(lot!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const again = await m.redeem('TET2027');
    expect(again.json().error.code).toBe('GIFT_CODE_USED');
  });

  it('max uses across users is atomic; expired / disabled / unknown codes are invalid; guests refused', async () => {
    await create({ code: 'ONLY2X', reward: { coins: 5 }, maxUses: 2 });
    const results = await Promise.all([member(), member(), member()].map(async (p) => (await (await p).redeem('ONLY2X')).statusCode));
    expect(results.sort()).toEqual([200, 200, 409]);
    const [row] = await db().select().from(giftCodes).where(eq(giftCodes.code, 'ONLY2X'));
    expect(row!.usedCount).toBe(2);

    await create({ code: 'OLD-CODE', reward: { coins: 5 }, expiresAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() - 5000).toISOString() });
    const m = await member();
    expect((await m.redeem('OLD-CODE')).json().error.code).toBe('GIFT_CODE_INVALID');
    expect((await m.redeem('NOPE-NOPE')).json().error.code).toBe('GIFT_CODE_INVALID');
    expect((await (await member(true)).redeem('ONLY2X')).statusCode).toBe(403);
  });

  it('rate limited: 5 attempts per minute', async () => {
    const m = await member();
    for (let i = 0; i < 5; i++) expect((await m.redeem(`WRONG-${i}`)).statusCode).toBe(400);
    expect((await m.redeem('WRONG-6')).statusCode).toBe(429);
  });
});

describe('admin', () => {
  it('batches of random codes, list / search, disable; finance only', async () => {
    const batch = (await create({ count: 20, prefix: 'VIP', reward: { points: 3 }, maxUses: 1, note: 'KOL' })).json();
    expect(batch.items).toHaveLength(20);
    expect(batch.items[0].code).toMatch(/^VIP[A-Z2-9]{10}$/);
    const admin = await adminClient(app, 'finance');
    const page = (await admin.call('GET', `/v1/admin/gift-codes?batchId=${batch.batchId}&limit=15`)).json();
    expect(page.items).toHaveLength(15);
    const rest = (await admin.call('GET', `/v1/admin/gift-codes?batchId=${batch.batchId}&cursor=${page.nextCursor}`)).json();
    expect(rest.items).toHaveLength(5);

    const one = batch.items[0];
    const off = await admin.call('PATCH', `/v1/admin/gift-codes/${one.id}`, { status: 'disabled', reason: 'Lộ mã' });
    expect(off.json().status).toBe('disabled');
    expect((await (await member()).redeem(one.code)).json().error.code).toBe('GIFT_CODE_INVALID');

    expect((await create({ code: 'TET2027', count: 2, reward: { coins: 1 } })).statusCode).toBe(400); // both
    expect((await create({ code: 'ZERO', reward: { coins: 0 } })).statusCode).toBe(400);
    await create({ code: 'DUPE', reward: { coins: 1 } });
    expect((await create({ code: 'DUPE', reward: { coins: 1 } })).statusCode).toBe(409);
    const mod = await adminClient(app, 'moderator');
    expect((await mod.call('GET', '/v1/admin/gift-codes')).statusCode).toBe(403);
  });
});
