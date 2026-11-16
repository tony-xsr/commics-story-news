import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertProducts } from '../src/db/products';
import { orders } from '../src/db/schema';
import { ActivityService, dayKey } from '../src/infra/activity/activity.service';
import { DbService } from '../src/infra/db/db.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { DashboardService } from '../src/modules/admin/dashboard.service';
import { dayRankKey } from '../src/modules/stories/views.service';
import { adminClient } from './admin-helpers';
import { createStory } from './factories';
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
  await app.get(RedisService).state.flushdb();
  await upsertProducts(app.get(DbService).write as never);
});

let seq = 0;
async function reader() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `device-dash-${++seq}-x` },
  });
  const { user, accessToken } = res.json();
  return {
    id: user.id as string,
    token: accessToken as string,
    me: () => app.inject({ method: 'GET', url: '/v1/me', headers: bearer(accessToken) }),
  };
}

describe('dashboard analytics', () => {
  it('counts signed-in users (today / online / 30 days), sign-ups, revenue, payers and top stories', async () => {
    const [a, b, c] = [await reader(), await reader(), await reader()];
    for (const r of [a, b, c, a]) expect((await r.me()).statusCode).toBe(200); // a twice → still one user

    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
    const state = app.get(RedisService).state;
    await state.pfadd(dayKey(tenDaysAgo), 'old-user-1', a.id); // a was also active earlier → counted once in MAU

    await app
      .get(DbService)
      .write.insert(orders)
      .values([
        {
          userId: b.id,
          productId: 'coins_300',
          platform: 'ios',
          environment: 'production',
          storeTxnId: 'd-1',
          priceMicros: 4_990_000,
        },
        {
          userId: b.id,
          productId: 'coins_300',
          platform: 'ios',
          environment: 'production',
          storeTxnId: 'd-2',
          priceMicros: 4_990_000,
        },
        {
          userId: c.id,
          productId: 'coins_300',
          platform: 'ios',
          environment: 'sandbox',
          storeTxnId: 'd-3',
          priceMicros: 4_990_000,
        },
      ]);

    const hot = await createStory(app, { title: 'Hot one' });
    const cold = await createStory(app, { title: 'Cold one' });
    await state.zadd(dayRankKey(now), 50, hot.id, 5, cold.id);
    await state.zadd(dayRankKey(tenDaysAgo), 999, cold.id); // outside the 7-day window

    const d = await app.get(DashboardService).compute(now);
    expect(d).toMatchObject({ onlineNow: 3, activeToday: 3, mau: 4, payers30d: 1 });
    expect(d.conversion30d).toBeCloseTo(0.25);
    expect(d.days).toHaveLength(30);
    expect(d.days.at(-1)).toMatchObject({ activeUsers: 3, newUsers: 3, orders: 2, revenueMicros: 9_980_000 }); // sandbox excluded
    expect(d.days.at(-11)).toMatchObject({ activeUsers: 2, newUsers: 0 });
    expect(d.topStories.map((s) => [s.title, s.views7d])).toEqual([
      ['Hot one', 50],
      ['Cold one', 5],
    ]);
  });

  it('activity is buffered (no Redis write per request) and flushed in one go', async () => {
    const activity = app.get(ActivityService);
    const before = await app.get(RedisService).state.pfcount(dayKey(new Date()));
    activity.seen('u-1');
    activity.seen('u-2');
    activity.seen('u-1');
    expect(await app.get(RedisService).state.pfcount(dayKey(new Date()))).toBe(before);
    await activity.flush();
    expect(await app.get(RedisService).state.pfcount(dayKey(new Date()))).toBe(before + 2);
  });

  it('admin route: dashboard.read only, with an admin token', async () => {
    const mod = await adminClient(app, 'moderator');
    const res = await mod.call('GET', '/v1/admin/dashboard/analytics');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mau: expect.any(Number), days: expect.any(Array) });
    const user = await reader();
    const asUser = await app.inject({
      method: 'GET',
      url: '/v1/admin/dashboard/analytics',
      headers: bearer(user.token),
    });
    expect(asUser.statusCode).toBe(401);
  });
});
