import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAuditLogs, broadcasts, entitlements, pushTokens, users } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { PUSH_SENDER, type PushMessage, type PushSender, type PushTicket } from '../src/infra/push/push';
import { BroadcastPushService } from '../src/modules/inbox/broadcast-push.service';
import { InboxService } from '../src/modules/inbox/inbox.service';
import { adminClient } from './admin-helpers';
import { bearer, bootApp, device, resetData } from './helpers';

class FakePush implements PushSender {
  sent: PushMessage[] = [];
  dead = new Set<string>();
  calls = 0;
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    this.calls++;
    this.sent.push(...messages);
    return messages.map((m) =>
      this.dead.has(m.to) ? { ok: false, error: 'DeviceNotRegistered', unregistered: true } : { ok: true },
    );
  }
}

/** FCM-shaped registration token. */
const fcmToken = (id: string) => `${id}:APA91b${'Q'.repeat(120)}`;

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
  push.sent = [];
  push.dead.clear();
  push.calls = 0;
});

const db = () => app.get(DbService).write;
let seq = 0;

async function user(opts: { platform?: string; locale?: string; ageMs?: number } = {}) {
  const id = `device-inbox-${++seq}-x`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    headers: device(id, opts.platform ?? 'ios'),
    payload: { deviceId: id },
  });
  const userId = res.json().user.id as string;
  await db()
    .update(users)
    .set({ locale: opts.locale ?? 'en', createdAt: new Date(Date.now() - (opts.ageMs ?? 3600_000)) })
    .where(eq(users.id, userId));
  const token = res.json().accessToken as string;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });
  return { id: userId, call };
}
type User = Awaited<ReturnType<typeof user>>;

const inbox = async (u: User, qs = '') => (await u.call('GET', `/v1/me/inbox${qs}`)).json();
const unread = async (u: User) => (await u.call('GET', '/v1/me/inbox/unread-count')).json().count as number;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const announce = {
  tab: 'update',
  kind: 'system',
  title: { en: 'Maintenance tonight', vi: 'Bảo trì tối nay' },
  body: { en: 'From 1 to 2 AM', vi: 'Từ 1 đến 2 giờ sáng' },
  reason: 'Thông báo bảo trì',
};

describe('inbox', () => {
  it('merges personal items and broadcasts (localized), newest first; tabs; read state; unread badge', async () => {
    const u = await user({ locale: 'vi-VN' });
    const cm = await adminClient(app, 'content_manager');
    const notify = app.get(InboxService);
    await notify.notify(u.id, { tab: 'reward', title: 'Nhận 50 points', body: 'Điểm danh 7 ngày' });
    const b = (await cm.call('POST', '/v1/admin/broadcasts', { ...announce, publishAt: ago(1000) })).json();
    await notify.notify(u.id, {
      tab: 'update',
      title: 'Chương mới',
      body: 'Truyện bạn thích có chương 12',
      action: { type: 'screen', screen: 'library' },
    });

    const page = await inbox(u);
    expect(page.items.map((i: { title: string }) => i.title)).toEqual([
      'Chương mới',
      'Nhận 50 points',
      'Bảo trì tối nay', // published 1 s ago; vi text for a vi-VN user
    ]);
    expect(page.items[2]).toMatchObject({ source: 'broadcast', id: b.id, read: false, body: 'Từ 1 đến 2 giờ sáng' });
    expect((await inbox(u, '?tab=reward')).items).toHaveLength(1);
    expect(await unread(u)).toBe(3);

    await u.call('POST', '/v1/me/inbox/read', { items: [{ source: 'broadcast', id: b.id }] });
    expect(await unread(u)).toBe(2);
    expect((await inbox(u)).items[2].read).toBe(true);

    await u.call('POST', '/v1/me/inbox/read', { all: true });
    expect(await unread(u)).toBe(0);
    expect((await inbox(u)).items.every((i: { read: boolean }) => i.read)).toBe(true);
    // other users never see personal items
    expect((await inbox(await user())).items.map((i: { title: string }) => i.title)).toEqual(['Maintenance tonight']);
  });

  it('paginates across both sources without gaps or repeats', async () => {
    const u = await user();
    const cm = await adminClient(app, 'content_manager');
    for (let i = 0; i < 7; i++) {
      await app.get(InboxService).notify(u.id, { tab: 'update', title: `p${i}`, body: '.' });
      await cm.call('POST', '/v1/admin/broadcasts', { ...announce, title: { en: `b${i}` }, publishAt: ago(500 - i) });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { title: string }[]; nextCursor: string | null } = await inbox(
        u,
        `?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.items.map((i) => i.title));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(14);
    expect(new Set(seen).size).toBe(14);
  });

  it('audience: language, platform, premium; broadcasts older than the account show as read', async () => {
    const cm = await adminClient(app, 'content_manager');
    const viIos = await user({ locale: 'vi', platform: 'ios' });
    const enAndroid = await user({ locale: 'en-US', platform: 'android' });
    await db()
      .insert(entitlements)
      .values({ userId: enAndroid.id, key: 'premium', source: 'promo', expiresAt: new Date(Date.now() + 86_400_000) });
    const post = (title: string, audience: object) =>
      cm.call('POST', '/v1/admin/broadcasts', { ...announce, title: { en: title }, audience, publishAt: ago(1000) });
    await post('vi only', { langs: ['vi'] });
    await post('android only', { platforms: ['android'] });
    await post('premium only', { premium: 'only' });
    await post('free only', { premium: 'exclude' });
    const titles = async (u: User) => (await inbox(u)).items.map((i: { title: string }) => i.title).sort();
    expect(await titles(viIos)).toEqual(['free only', 'vi only']);
    expect(await titles(enAndroid)).toEqual(['android only', 'premium only']);

    const newcomer = await user({ ageMs: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect((await inbox(newcomer)).items.every((i: { read: boolean }) => i.read)).toBe(true);
    expect(await unread(newcomer)).toBe(0);
  });

  it('drafts, scheduled, expired and canceled broadcasts are not shown', async () => {
    const u = await user();
    const cm = await adminClient(app, 'content_manager');
    const post = (title: string, extra: object) =>
      cm.call('POST', '/v1/admin/broadcasts', { ...announce, title: { en: title }, ...extra });
    await post('draft', {});
    await post('scheduled', { publishAt: new Date(Date.now() + 3600_000).toISOString() });
    const expiring = (
      await post('expiring', { publishAt: ago(1000), expiresAt: new Date(Date.now() + 300).toISOString() })
    ).json();
    const live = (await post('live', { publishAt: ago(1000) })).json();
    expect((await inbox(u)).items.map((i: { title: string }) => i.title).sort()).toEqual(['expiring', 'live']);

    const cancel = await cm.call('POST', `/v1/admin/broadcasts/${live.id}/cancel`, { reason: 'Gửi nhầm' });
    expect(cancel.json().status).toBe('canceled');
    await new Promise((r) => setTimeout(r, 350));
    expect((await inbox(u)).items).toEqual([]);
    expect(expiring.status).toBe('live');
  });

  it('push tokens: validated, moved to the signed-in account, removable; marketing opt-out setting', async () => {
    const a = await user();
    const b = await user();
    const token = fcmToken('abcdefghij1234567890');
    expect((await a.call('PUT', '/v1/me/push-tokens', { token: 'not a token!', platform: 'ios' })).statusCode).toBe(
      400,
    );
    expect((await a.call('PUT', '/v1/me/push-tokens', { token, platform: 'ios' })).statusCode).toBe(204);
    await b.call('PUT', '/v1/me/push-tokens', { token, platform: 'ios' }); // same device, other account
    const rows = await db().select().from(pushTokens);
    expect(rows).toEqual([expect.objectContaining({ userId: b.id, token })]);
    await a.call('DELETE', '/v1/me/push-tokens', { token, platform: 'ios' }); // not a's anymore: no effect
    expect(await db().select().from(pushTokens)).toHaveLength(1);
    await b.call('DELETE', '/v1/me/push-tokens', { token, platform: 'ios' });
    expect(await db().select().from(pushTokens)).toHaveLength(0);

    expect((await a.call('GET', '/v1/me/notification-settings')).json()).toEqual({ marketing: true, updates: true });
    expect((await a.call('PATCH', '/v1/me/notification-settings', { marketing: false })).json()).toEqual({
      marketing: false,
      updates: true,
    });
  });
});

describe('broadcast push', () => {
  async function withToken(opts: Parameters<typeof user>[0] & { n: number }) {
    const u = await user(opts);
    const token = fcmToken(`device${String(opts.n).padStart(6, '0')}`);
    await u.call('PUT', '/v1/me/push-tokens', { token, platform: opts.platform ?? 'ios' });
    return { ...u, token };
  }

  it('worker sends to the audience (localized), honours marketing opt-out, removes dead tokens, records stats', async () => {
    const vi = await withToken({ n: 1, locale: 'vi' });
    const en = await withToken({ n: 2, locale: 'en' });
    const optedOut = await withToken({ n: 3, locale: 'en' });
    const dead = await withToken({ n: 4, locale: 'en' });
    await optedOut.call('PATCH', '/v1/me/notification-settings', { marketing: false });
    push.dead.add(dead.token);

    const cm = await adminClient(app, 'content_manager');
    const b = (
      await cm.call('POST', '/v1/admin/broadcasts', {
        ...announce,
        kind: 'marketing',
        push: true,
        publishAt: ago(1000),
        action: { type: 'screen', screen: 'shop' },
      })
    ).json();
    expect((await cm.call('GET', `/v1/admin/broadcasts/${b.id}`)).json().estimate).toEqual({ pushTokens: 3 });

    expect(await app.get(BroadcastPushService).runDue()).toBe(1);
    expect(push.sent.map((m) => [m.to, m.title]).sort()).toEqual(
      [
        [vi.token, 'Bảo trì tối nay'],
        [en.token, 'Maintenance tonight'],
        [dead.token, 'Maintenance tonight'],
      ].sort(),
    );
    expect(push.sent[0]!.data).toEqual({ broadcastId: b.id, action: { type: 'screen', screen: 'shop' } });
    const detail = (await cm.call('GET', `/v1/admin/broadcasts/${b.id}`)).json();
    expect(detail).toMatchObject({ pushStatus: 'sent', pushSent: 2, pushFailed: 1 });
    expect((await db().select().from(pushTokens)).map((t) => t.token)).not.toContain(dead.token);
    expect(await app.get(BroadcastPushService).runDue()).toBe(0); // never twice
  });

  it('only after publishAt; batches of 100; a crashed send resumes after its cursor', async () => {
    const cm = await adminClient(app, 'content_manager');
    for (let i = 0; i < 205; i++) {
      const u = await db()
        .insert(users)
        .values({ displayName: `u${i}`, isGuest: false })
        .returning({ id: users.id });
      await db()
        .insert(pushTokens)
        .values({
          userId: u[0]!.id,
          token: fcmToken(`bulk${String(i).padStart(6, '0')}`),
          platform: 'android',
        });
    }
    const scheduled = (
      await cm.call('POST', '/v1/admin/broadcasts', {
        ...announce,
        push: true,
        publishAt: new Date(Date.now() + 3600_000).toISOString(),
      })
    ).json();
    expect(await app.get(BroadcastPushService).runDue()).toBe(0);

    // Simulate a worker that crashed after the first 100.
    const [first100] = await db()
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .orderBy(pushTokens.id)
      .offset(99)
      .limit(1);
    await db()
      .update(broadcasts)
      .set({
        publishAt: new Date(Date.now() - 1000),
        pushStatus: 'sending',
        pushCursor: first100!.id,
        pushSent: 100,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(broadcasts.id, scheduled.id));
    expect(await app.get(BroadcastPushService).runDue()).toBe(1);
    expect(push.sent).toHaveLength(105);
    expect(push.calls).toBe(2);
    const [row] = await db().select().from(broadcasts).where(eq(broadcasts.id, scheduled.id));
    expect(row).toMatchObject({ pushStatus: 'sent', pushSent: 205 });
  });

  it('test send goes to one user only; canceled broadcasts never push', async () => {
    const a = await withToken({ n: 11 });
    await withToken({ n: 12 });
    const cm = await adminClient(app, 'content_manager');
    const b = (await cm.call('POST', '/v1/admin/broadcasts', { ...announce, push: true })).json(); // draft
    const test = await cm.call('POST', `/v1/admin/broadcasts/${b.id}/test`, { userId: a.id });
    expect(test.json()).toEqual({ sent: 1, failed: 0 });
    expect(push.sent.map((m) => m.to)).toEqual([a.token]);

    await cm.call('PATCH', `/v1/admin/broadcasts/${b.id}`, { publishAt: ago(100), reason: 'Đăng ngay' });
    await cm.call('POST', `/v1/admin/broadcasts/${b.id}/cancel`, { reason: 'Đổi ý' });
    expect(await app.get(BroadcastPushService).runDue()).toBe(0);
    expect(push.sent).toHaveLength(1);
  });
});

describe('admin broadcasts', () => {
  it('validation, edit rules, permissions, audit', async () => {
    const cm = await adminClient(app, 'content_manager');
    const bad = [
      { ...announce, title: { vi: 'Thiếu tiếng Anh' } },
      { ...announce, action: { type: 'url', url: 'javascript:alert(1)' } },
      { ...announce, action: { type: 'url', url: 'http://insecure.example' } },
      { ...announce, audience: { langs: ['xx'] } },
      { ...announce, expiresAt: ago(1000) },
      { ...announce, publishAt: ago(-7200_000), expiresAt: ago(-3600_000) }, // expires before publish
    ];
    for (const body of bad) expect((await cm.call('POST', '/v1/admin/broadcasts', body)).statusCode).toBe(400);

    const live = (await cm.call('POST', '/v1/admin/broadcasts', { ...announce, publishAt: ago(1000) })).json();
    const edit = await cm.call('PATCH', `/v1/admin/broadcasts/${live.id}`, { title: { en: 'x' }, reason: 'sửa' });
    expect(edit.statusCode).toBe(409);
    const draft = (await cm.call('POST', '/v1/admin/broadcasts', announce)).json();
    expect(draft.status).toBe('draft');
    const edited = await cm.call('PATCH', `/v1/admin/broadcasts/${draft.id}`, {
      title: { en: 'Fixed' },
      reason: 'Sửa tiêu đề',
    });
    expect(edited.json()).toMatchObject({ title: { en: 'Fixed' }, status: 'draft' });

    const list = (await cm.call('GET', '/v1/admin/broadcasts')).json();
    expect(list.items.map((b: { id: string }) => b.id)).toEqual([draft.id, live.id]);
    const audits = await db().select().from(adminAuditLogs).where(eq(adminAuditLogs.entity, 'broadcast'));
    expect(audits.map((a) => a.action).sort()).toEqual(['broadcast.create', 'broadcast.create', 'broadcast.update']);

    for (const role of ['moderator', 'finance', 'support'] as const) {
      expect((await (await adminClient(app, role)).call('GET', '/v1/admin/broadcasts')).statusCode).toBe(403);
    }
  });
});
