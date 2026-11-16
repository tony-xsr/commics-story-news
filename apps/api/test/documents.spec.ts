import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '../src/infra/redis/redis.service';
import { adminClient } from './admin-helpers';
import { seedDocumentDefaults } from './factories';
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
  await seedDocumentDefaults(app);
  await app.get(RedisService).cache.flushdb();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

describe('documents', () => {
  it('default documents served per language with en fallback; admin edits refresh them', async () => {
    const privacy = await get('/v1/documents/privacy?lang=vi');
    expect(privacy.statusCode).toBe(200);
    expect(privacy.headers['cache-control']).toContain('public');
    expect(privacy.json()).toMatchObject({ slug: 'privacy', title: 'Privacy Policy' }); // no vi yet → en
    expect((await get('/v1/documents/faq')).json().sections.length).toBeGreaterThan(3);
    expect((await get('/v1/documents/nope')).statusCode).toBe(400);

    const cm = await adminClient(app, 'content_manager');
    const saved = await cm.call('PUT', '/v1/admin/documents/privacy', {
      title: { en: 'Privacy Policy', vi: 'Chính sách quyền riêng tư' },
      summary: { en: 'Updated', vi: 'Cập nhật' },
      sections: { en: [{ heading: 'One', body: 'Text' }], vi: [{ heading: 'Một', body: 'Nội dung' }] },
      published: true,
      reason: 'Bản dịch tiếng Việt',
    });
    expect(saved.statusCode).toBe(200);
    expect((await get('/v1/documents/privacy?lang=vi')).json()).toMatchObject({
      title: 'Chính sách quyền riêng tư',
      sections: [{ heading: 'Một', body: 'Nội dung' }],
    });
    expect(
      (await cm.call('PUT', '/v1/admin/documents/terms', { title: { vi: 'x' }, summary: { en: '' }, sections: { en: [] }, published: true, reason: 'abc' }))
        .statusCode,
    ).toBe(400); // en required
    expect((await (await adminClient(app, 'moderator')).call('GET', '/v1/admin/documents')).statusCode).toBe(403);
  });
});

describe('feedback', () => {
  it('stored with platform / version, rate limited; admin lists and resolves', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: 'device-feedback-1' } });
    const token = res.json().accessToken as string;
    const send = (message: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/me/feedback',
        headers: { ...bearer(token), 'x-platform': 'ios', 'x-app-version': '1.2.0' },
        payload: { message },
      });
    expect((await send('short')).statusCode).toBe(400);
    for (let i = 0; i < 3; i++) expect((await send(`The reader crashes on chapter ${i}`)).statusCode).toBe(204);
    expect((await send('One more message here')).statusCode).toBe(429);

    const support = await adminClient(app, 'support');
    const list = (await support.call('GET', '/v1/admin/feedback?status=open')).json();
    expect(list.items).toHaveLength(3);
    expect(list.items[0]).toMatchObject({ platform: 'ios', appVersion: '1.2.0', status: 'open' });
    await support.call('PATCH', `/v1/admin/feedback/${list.items[0].id}`, { status: 'resolved' });
    expect((await support.call('GET', '/v1/admin/feedback?status=open')).json().items).toHaveLength(2);
  });
});

describe('app config & force update', () => {
  it('reports update required / available; old app versions get 426 on API calls', async () => {
    const cm = await adminClient(app, 'content_manager');
    const body = {
      ios: { minVersion: '1.2.0', latestVersion: '1.4.0', storeUrl: 'https://apps.apple.com/app/id1' },
      android: { minVersion: '1.0.0', latestVersion: '1.0.0', storeUrl: 'https://play.google.com/store/apps/details?id=x' },
      maintenance: { active: false, message: '' },
      supportEmail: 'help@storyzio.app',
      reason: 'Bản 1.2 sửa lỗi thanh toán',
    };
    expect((await cm.call('PUT', '/v1/admin/app-config', body)).statusCode).toBe(200);
    expect(
      (await cm.call('PUT', '/v1/admin/app-config', { ...body, ios: { ...body.ios, minVersion: '2.0.0' } })).statusCode,
    ).toBe(400); // min above latest

    expect((await get('/v1/app-config?platform=ios&version=1.1.9')).json()).toMatchObject({
      updateRequired: true,
      updateAvailable: true,
      storeUrl: 'https://apps.apple.com/app/id1',
    });
    expect((await get('/v1/app-config?platform=ios&version=1.3.0')).json()).toMatchObject({
      updateRequired: false,
      updateAvailable: true,
    });

    // The guard memoizes config for 15 s per process: a fresh app instance sees the new minimum.
    const fresh = await bootApp();
    try {
      const old = await fresh.inject({
        method: 'GET',
        url: '/v1/genres',
        headers: { 'x-platform': 'ios', 'x-app-version': '1.1.9' },
      });
      expect(old.statusCode).toBe(426);
      expect(old.json().error.code).toBe('UPGRADE_REQUIRED');
      const ok = await fresh.inject({ method: 'GET', url: '/v1/genres', headers: { 'x-platform': 'ios', 'x-app-version': '1.2.0' } });
      expect(ok.statusCode).toBe(200);
      const web = await fresh.inject({ method: 'GET', url: '/v1/genres' });
      expect(web.statusCode).toBe(200);
      const cfg = await fresh.inject({ method: 'GET', url: '/v1/app-config?platform=ios&version=1.1.9', headers: { 'x-platform': 'ios', 'x-app-version': '1.1.9' } });
      expect(cfg.statusCode).toBe(200);
    } finally {
      await fresh.close();
    }
  });

  it('scheduled maintenance: stored with the admin offset, served as UTC, active only inside the window', async () => {
    const cm = await adminClient(app, 'content_manager');
    const base = {
      ios: { minVersion: '1.0.0', latestVersion: '1.0.0', storeUrl: 'https://apps.apple.com/app/id1' },
      android: { minVersion: '1.0.0', latestVersion: '1.0.0', storeUrl: 'https://play.google.com/store/apps/details?id=x' },
      supportEmail: 'help@storyzio.app',
      reason: 'Bảo trì nâng cấp DB',
    };
    const at = (ms: number) => new Date(Date.now() + ms);
    // "07:00 UTC+8"-style input: an offset timestamp
    const plus8 = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19) + '+08:00';
    const put = (m: object) => cm.call('PUT', '/v1/admin/app-config', { ...base, maintenance: { active: false, message: 'Nâng cấp', ...m } });
    const cfg = async () => (await get('/v1/app-config?platform=ios&version=1.0.0')).json().maintenance;

    const start = at(3_600_000);
    expect((await put({ startsAt: plus8(start), endsAt: plus8(at(7_200_000)) })).statusCode).toBe(200);
    const upcoming = await cfg();
    expect(upcoming.active).toBe(false);
    expect(upcoming.startsAt).toBe(new Date(Math.floor(start.getTime() / 1000) * 1000).toISOString()); // UTC

    expect((await put({ startsAt: plus8(at(-60_000)), endsAt: plus8(at(3_600_000)) })).statusCode).toBe(200);
    expect((await cfg()).active).toBe(true);

    expect((await put({ startsAt: plus8(at(-7_200_000)), endsAt: plus8(at(-3_600_000)) })).statusCode).toBe(200);
    expect((await cfg()).active).toBe(false); // over → open again by itself

    expect((await put({ startsAt: plus8(at(7_200_000)), endsAt: plus8(at(3_600_000)) })).statusCode).toBe(400); // end before start
  });
});

