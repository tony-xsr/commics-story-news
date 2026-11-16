import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chapterPushQueue, favorites, notifications, pushTokens, users, walletLots } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { PUSH_SENDER, type PushMessage, type PushSender, type PushTicket } from '../src/infra/push/push';
import { EventPushService } from '../src/modules/inbox/event-push.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createChapters, createStory, seedGenres } from './factories';
import { bearer, bootApp, resetData } from './helpers';

class FakePush implements PushSender {
  sent: PushMessage[] = [];
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    this.sent.push(...messages);
    return messages.map(() => ({ ok: true }));
  }
}

let app: NestFastifyApplication;
const push = new FakePush();

beforeAll(async () => {
  app = await bootApp({ overrides: [[PUSH_SENDER, push]] });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
  await seedGenres(app);
  push.sent = [];
});

const db = () => app.get(DbService).write;
const events = () => app.get(EventPushService);

/** A fixed-offset zone where it is currently daytime (12–18 h) or night (0–5 h). */
function zoneWhere(test: (hour: number) => boolean): string {
  for (let offset = -12; offset <= 14; offset++) {
    const zone = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`; // Etc signs are inverted
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(),
    );
    if (test(hour)) return zone;
  }
  throw new Error('no zone');
}
const DAY = zoneWhere((h) => h >= 12 && h <= 18);
const NIGHT = zoneWhere((h) => h >= 0 && h <= 5);

let seq = 0;
async function reader(opts: { locale?: string; timezone?: string; device?: boolean } = {}) {
  const deviceId = `device-evt-${++seq}-x`;
  const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId } });
  const id = res.json().user.id as string;
  await db()
    .update(users)
    .set({ isGuest: false, locale: opts.locale ?? 'en', timezone: opts.timezone ?? DAY })
    .where(eq(users.id, id));
  const token = `fcm${seq}:APA91b${'Q'.repeat(120)}`;
  if (opts.device !== false) await db().insert(pushTokens).values({ userId: id, token, platform: 'android' });
  const call = (method: 'GET' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(res.json().accessToken), ...(payload ? { payload } : {}) });
  return { id, token, call };
}
const follow = (userId: string, ...storyIds: string[]) =>
  db()
    .insert(favorites)
    .values(storyIds.map((storyId) => ({ userId, storyId })));
const to = (token: string) => push.sent.filter((m) => m.to === token);

describe('new chapter pushes', () => {
  it('one digest per user, localized; opted-out / device-less users dropped; quiet hours wait; never twice', async () => {
    const s1 = await createStory(app, { title: 'Kiếm Lai' });
    const s2 = await createStory(app, { title: 'Toàn Chức Pháp Sư' });
    await createChapters(app, s1, 2); // back catalogue before the first run
    expect(await events().chapterUpdates()).toEqual({ queued: 0, pushed: 0 }); // sets the watermark only

    const both = await reader({ locale: 'vi' });
    const one = await reader({ locale: 'en' });
    const optedOut = await reader();
    const noDevice = await reader({ device: false });
    const sleeping = await reader({ timezone: NIGHT });
    await follow(both.id, s1.id, s2.id);
    await follow(one.id, s1.id);
    await follow(optedOut.id, s1.id);
    await follow(noDevice.id, s1.id);
    await follow(sleeping.id, s1.id);
    await optedOut.call('PATCH', '/v1/me/notification-settings', { updates: false });

    await createChapters(app, s1, 1, () => ({ number: 3, publishedAt: new Date() }));
    await createChapters(app, s2, 1, () => ({ number: 7, publishedAt: new Date() }));
    const run = await events().chapterUpdates();
    expect(run).toEqual({ queued: 2, pushed: 2 });

    expect(to(both.token)).toEqual([
      expect.objectContaining({
        title: '2 truyện bạn theo dõi có chương mới',
        body: expect.stringMatching(/Kiếm Lai/),
        data: { type: 'screen', screen: 'library' },
      }),
    ]);
    expect(to(one.token)).toEqual([
      expect.objectContaining({ title: 'Kiếm Lai', body: 'Chapter 3 is out', data: { type: 'story', storyId: s1.id } }),
    ]);
    expect(to(optedOut.token)).toEqual([]);
    expect(to(sleeping.token)).toEqual([]);
    // only the sleeping user's row is still waiting
    expect((await db().select().from(chapterPushQueue)).map((r) => r.userId)).toEqual([sleeping.id]);

    expect(await events().chapterUpdates()).toEqual({ queued: 0, pushed: 0 }); // no repeats, still night for them
    await db().update(users).set({ timezone: DAY }).where(eq(users.id, sleeping.id)); // morning comes
    expect((await events().chapterUpdates()).pushed).toBe(1);
    expect(to(sleeping.token)).toEqual([expect.objectContaining({ title: 'Kiếm Lai' })]);
    expect(await db().select().from(chapterPushQueue)).toEqual([]);
  });

  it('several chapters of one story before delivery → one push naming the latest; drafts and hidden stories ignored', async () => {
    const s = await createStory(app, { title: 'Truyện A' });
    const hidden = await createStory(app, { title: 'Ẩn', status: 'hidden' });
    await events().chapterUpdates();
    const u = await reader({ timezone: NIGHT });
    await follow(u.id, s.id, hidden.id);
    await createChapters(app, s, 3, (n) => ({ publishedAt: new Date(), number: n }));
    await createChapters(app, s, 1, () => ({ number: 4, status: 'draft', publishedAt: null }));
    await createChapters(app, hidden, 1, () => ({ publishedAt: new Date() }));
    await events().chapterUpdates();
    const queue = await db().select().from(chapterPushQueue);
    expect(queue.map((r) => [r.storyId, r.chapterNumber])).toEqual([[s.id, 3]]);
  });
});

describe('coins expiring', () => {
  async function bonus(userId: string, amount: number, inDays: number) {
    const wallet = app.get(WalletService);
    await wallet.transaction((tx) =>
      wallet.credit(tx, userId, {
        currency: 'coins',
        amount,
        kind: 'bonus',
        reason: 'admin_adjust',
        idempotencyKey: `test-bonus:${userId}:${amount}:${inDays}`,
        sourceType: 'test',
        expiresAt: new Date(Date.now() + inDays * 86_400_000),
      }),
    );
  }

  it('inbox notice + push once per lot (summed per user), only within 3 days, outside quiet hours', async () => {
    const vi = await reader({ locale: 'vi' });
    const sleeping = await reader({ timezone: NIGHT });
    await bonus(vi.id, 30, 2);
    await bonus(vi.id, 20, 1);
    await bonus(vi.id, 99, 10); // too far away
    await bonus(sleeping.id, 40, 2);

    expect(await events().coinExpiryNotices()).toBe(1);
    expect(to(vi.token)).toEqual([
      expect.objectContaining({ title: '50 coin sắp hết hạn', data: { type: 'screen', screen: 'wallet' } }),
    ]);
    const inbox = await db().select().from(notifications).where(eq(notifications.userId, vi.id));
    expect(inbox).toEqual([
      expect.objectContaining({
        tab: 'reward',
        title: '50 coin sắp hết hạn',
        action: { type: 'screen', screen: 'wallet' },
      }),
    ]);
    expect(to(sleeping.token)).toEqual([]);

    expect(await events().coinExpiryNotices()).toBe(0); // once per lot
    await db().update(users).set({ timezone: DAY }).where(eq(users.id, sleeping.id));
    expect(await events().coinExpiryNotices()).toBe(1);
    expect(to(sleeping.token)).toHaveLength(1);

    const lots = await db().select().from(walletLots).where(eq(walletLots.userId, vi.id));
    expect(
      lots
        .filter((l) => l.expiryWarnedAt)
        .map((l) => l.amount)
        .sort(),
    ).toEqual([20, 30]);
  });

  it('users without a device still get the inbox notice', async () => {
    const u = await reader({ device: false });
    await bonus(u.id, 15, 1);
    expect(await events().coinExpiryNotices()).toBe(1);
    expect(push.sent).toEqual([]);
    expect(await db().select().from(notifications).where(eq(notifications.userId, u.id))).toHaveLength(1);
  });
});

describe('notification settings', () => {
  it('partial updates', async () => {
    const u = await reader();
    expect((await u.call('GET', '/v1/me/notification-settings')).json()).toEqual({ marketing: true, updates: true });
    expect((await u.call('PATCH', '/v1/me/notification-settings', { updates: false })).json()).toEqual({
      marketing: true,
      updates: false,
    });
    expect((await u.call('PATCH', '/v1/me/notification-settings', { extra: 1 })).statusCode).toBe(400);
  });
});
