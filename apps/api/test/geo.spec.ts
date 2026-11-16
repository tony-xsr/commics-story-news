import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '../src/infra/redis/redis.service';
import { adminClient } from './admin-helpers';
import { createChapters, createStory, seedGenres } from './factories';
import { bearer, bootApp, device, resetData } from './helpers';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
  await seedGenres(app);
  await app.get(RedisService).cache.flushdb();
});

/** app.inject comes from 127.0.0.1 = one of our proxies, so a CF-IPCountry header is trusted (like Cloudflare's). */
const from = (country: string | null, remoteAddress = '127.0.0.1') => ({
  remoteAddress,
  headers: country ? { 'cf-ipcountry': country } : {},
});

describe('040 · geo-restricted stories', () => {
  it('admin sets “only VN”: detail / chapters / content answer 451 elsewhere and are never CDN-cached', async () => {
    const cm = await adminClient(app, 'content_manager');
    const story = await createStory(app, { title: 'Chỉ Việt Nam', freeChapters: 2 });
    const [ch1] = await createChapters(app, story, 3);
    const open = await createStory(app, { title: 'Mọi nơi', freeChapters: 1 });
    const [openCh] = await createChapters(app, open, 1);

    const patch = await cm.call('PATCH', `/v1/admin/stories/${story.id}`, { regions: { mode: 'allow', countries: ['VN'] } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ regionMode: 'allow', regionCountries: ['VN'] });

    const vn = await app.inject({ method: 'GET', url: `/v1/stories/${story.slug}`, ...from('VN') });
    expect(vn.statusCode).toBe(200);
    expect(vn.json().regions).toEqual({ mode: 'allow', countries: ['VN'] });
    expect(vn.headers['cache-control']).toBe('private, no-store');

    const us = await app.inject({ method: 'GET', url: `/v1/stories/${story.slug}`, ...from('US') });
    expect(us.statusCode).toBe(451);
    expect(us.json().error.code).toBe('GEO_BLOCKED');
    expect((await app.inject({ method: 'GET', url: `/v1/stories/${story.id}/chapters`, ...from('US') })).statusCode).toBe(451);

    const contentUs = await app.inject({ method: 'GET', url: `/v1/chapters/${ch1!.id}/content`, ...from('US') });
    expect(contentUs.statusCode).toBe(451);
    const contentVn = await app.inject({ method: 'GET', url: `/v1/chapters/${ch1!.id}/content`, ...from('VN') });
    expect(contentVn.statusCode).toBe(200);
    expect(contentVn.headers['cache-control']).toBe('private, no-store'); // free, but not shared on the CDN

    // Unrestricted stories keep their CDN caching.
    const openContent = await app.inject({ method: 'GET', url: `/v1/chapters/${openCh!.id}/content`, ...from('US') });
    expect(openContent.headers['cache-control']).toContain('s-maxage');

    // Lists carry the rule so apps / web can hide the card.
    const list = (await app.inject({ method: 'GET', url: '/v1/stories?limit=10' })).json().items;
    expect(list.find((s: { id: string }) => s.id === story.id).regions).toEqual({ mode: 'allow', countries: ['VN'] });
    expect(list.find((s: { id: string }) => s.id === open.id).regions).toBeNull();

    // Clearing the countries removes the restriction.
    await cm.call('PATCH', `/v1/admin/stories/${story.id}`, { regions: { mode: 'allow', countries: [] } });
    expect((await app.inject({ method: 'GET', url: `/v1/stories/${story.slug}`, ...from('US') })).statusCode).toBe(200);
  });

  it('“everywhere except CN”; unknown country is allowed outside production; spoofed headers from outside are ignored', async () => {
    const cm = await adminClient(app, 'content_manager');
    const story = await createStory(app, { title: 'Trừ Trung Quốc' });
    await cm.call('PATCH', `/v1/admin/stories/${story.id}`, { regions: { mode: 'block', countries: ['CN'] } });
    expect((await app.inject({ method: 'GET', url: `/v1/stories/${story.slug}`, ...from('CN') })).statusCode).toBe(451);
    expect((await app.inject({ method: 'GET', url: `/v1/stories/${story.slug}`, ...from('VN') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/stories/${story.slug}`, ...from(null) })).statusCode).toBe(200);

    // A client on the internet can't pick its country: the header only counts from our own proxies.
    const spoof = await app.inject({ method: 'GET', url: '/v1/stories/geo', ...from('CN', '8.8.8.8') });
    expect(spoof.json()).toEqual({ country: null });
    expect((await app.inject({ method: 'GET', url: '/v1/stories/geo', ...from('vn') })).json()).toEqual({ country: 'VN' });
    expect(spoof.headers['cache-control']).toBe('private, no-store');
  });

  it('unlocking a chapter from a blocked country is refused before any coin moves', async () => {
    const cm = await adminClient(app, 'content_manager');
    const story = await createStory(app, { title: 'Trả phí VN', freeChapters: 0 });
    await createChapters(app, story, 2);
    await cm.call('PATCH', `/v1/admin/stories/${story.id}`, { regions: { mode: 'allow', countries: ['VN'] } });
    const guest = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: 'geo-device-1-xxx' }, headers: device('geo-device-1-xxx') });
    const token = guest.json().accessToken as string;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/unlocks',
      remoteAddress: '127.0.0.1',
      headers: { ...bearer(token), 'cf-ipcountry': 'US', 'idempotency-key': 'geo-unlock-0001' },
      payload: { storyId: story.id, offerKey: 'single', fromChapter: 1, expectedPrice: 10 },
    });
    expect(res.statusCode).toBe(451);
  });
});
