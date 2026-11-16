import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedRewardDefaults } from './factories';
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
  await seedRewardDefaults(app);
});

describe('account language', () => {
  it('badge texts follow a locale change at once (no stale cached profile)', async () => {
    const guest = (await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: 'device-locale-sync-1' } })).json();
    const headers = bearer(guest.accessToken);
    const title = async () =>
      (await app.inject({ method: 'GET', url: '/v1/me/badges', headers })).json().items.find((b: { id: string }) => b.id === 'story-lover').title;

    expect(await title()).toBe('Story Lover'); // also warms the rewards profile cache
    const res = await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers, payload: { locale: 'vi' } });
    expect(res.statusCode).toBe(200);
    expect(await title()).toBe('Mọt truyện');
  });
});

describe('default badges', () => {
  it('ship in all 7 languages', async () => {
    const guest = (await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: 'device-locale-sync-2' } })).json();
    const headers = bearer(guest.accessToken);
    const titles: string[] = [];
    for (const locale of ['en', 'vi', 'ja', 'ko', 'zh', 'es', 'fr']) {
      await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers, payload: { locale } });
      const res = await app.inject({ method: 'GET', url: '/v1/me/badges', headers });
      titles.push(res.json().items.find((b: { id: string }) => b.id === 'night-owl').title);
    }
    expect(titles).toEqual(['Night Owl', 'Cú đêm', '夜ふかし', '올빼미', '夜猫子', 'Búho nocturno', 'Oiseau de nuit']);
  });
});
