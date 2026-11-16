import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '../src/infra/redis/redis.service';
import { adminClient } from './admin-helpers';
import { createStory, seedGenres, seedHomeDefaults } from './factories';
import { bootApp, resetData } from './helpers';

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
  await seedHomeDefaults(app);
  await app.get(RedisService).cache.flushdb();
});

const home = async (lang = 'en') => (await app.inject({ method: 'GET', url: `/v1/home?lang=${lang}` }));

describe('home', () => {
  it('default sections in order, resolved to stories, localized titles, CDN-cacheable', async () => {
    await createStory(app, { title: 'Novel A', type: 'novel', viewCount: 10 });
    await createStory(app, { title: 'Comic B', type: 'comic', viewCount: 50 });
    const res = await home('vi');
    expect(res.headers['cache-control']).toContain('public');
    const sections = res.json().sections;
    expect(sections.map((s: { key: string }) => s.key)).toEqual([
      'popular', 'trending', 'new-releases', 'novel-picks', 'comic-picks', 'more-stories',
    ]);
    expect(sections[0]).toMatchObject({ title: 'Phổ biến', kind: 'query', layout: 'grid' });
    expect(sections[0].stories.map((s: { title: string }) => s.title)).toEqual(['Comic B', 'Novel A']);
    expect(sections[3].stories.map((s: { title: string }) => s.title)).toEqual(['Novel A']); // type filter
  });

  it('admin: curated + banner sections with a time window; delete; see-more; validation & permission', async () => {
    const a = await createStory(app, { title: 'Pick 1' });
    const b = await createStory(app, { title: 'Pick 2' });
    const cm = await adminClient(app, 'content_manager');
    const curated = {
      title: { en: 'Editor picks', vi: 'Biên tập chọn' },
      kind: 'curated',
      layout: 'grid',
      storyIds: [b.id, a.id],
      limit: 1,
      sort: 1,
      reason: 'Chiến dịch tháng 11',
    };
    expect((await cm.call('PUT', '/v1/admin/home-sections/editor-picks', curated)).statusCode).toBe(200);
    const banner = {
      title: { en: 'Banner' },
      kind: 'banner',
      layout: 'banner',
      banners: [{ imageUrl: 'https://cdn.test/b.webp', storyId: a.id }],
      sort: 0,
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'Banner sự kiện',
    };
    expect((await cm.call('PUT', '/v1/admin/home-sections/hero', banner)).statusCode).toBe(200);

    const sections = (await home()).json().sections; // admin save already refreshed the cache
    expect(sections.slice(0, 2).map((s: { key: string }) => s.key)).toEqual(['hero', 'editor-picks']);
    expect(sections[0].banners).toEqual([{ imageUrl: 'https://cdn.test/b.webp', storyId: a.id, url: null }]);
    expect(sections[1].stories.map((s: { title: string }) => s.title)).toEqual(['Pick 2']); // limit 1, admin order
    const more = (await app.inject({ method: 'GET', url: '/v1/home/sections/editor-picks' })).json();
    expect(more.stories.map((s: { title: string }) => s.title)).toEqual(['Pick 2', 'Pick 1']);

    // scheduled for later → hidden; deleted → gone
    await cm.call('PUT', '/v1/admin/home-sections/hero', { ...banner, startsAt: new Date(Date.now() + 3600_000).toISOString() });
    expect((await home()).json().sections.map((s: { key: string }) => s.key)).not.toContain('hero');
    expect((await cm.call('DELETE', '/v1/admin/home-sections/editor-picks', { reason: 'Hết chiến dịch' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/home/sections/editor-picks' })).statusCode).toBe(404);

    expect((await cm.call('PUT', '/v1/admin/home-sections/bad', { ...curated, storyIds: [] })).statusCode).toBe(400);
    expect((await cm.call('PUT', '/v1/admin/home-sections/bad', { ...banner, layout: 'grid' })).statusCode).toBe(400);
    const list = (await cm.call('GET', '/v1/admin/home-sections')).json().items;
    expect(list.find((s: { key: string }) => s.key === 'hero')).toMatchObject({ kind: 'banner', startsAt: expect.any(String) });
    expect((await (await adminClient(app, 'moderator')).call('GET', '/v1/admin/home-sections')).statusCode).toBe(403);
  });

  it('tabs (041): defaults in order, localized; tabs of missing / inactive genres are dropped', async () => {
    const tabs = (await home('vi')).json().tabs;
    // 'lgbt' points at genre lgbtq, which this test DB doesn't have → hidden
    expect(tabs.map((t: { key: string }) => t.key)).toEqual(['for-you', 'novel', 'comic', 'romance', 'drama']);
    expect(tabs[0]).toEqual({ key: 'for-you', title: 'Dành cho bạn', kind: 'home', query: null });
    expect(tabs[3]).toEqual({ key: 'romance', title: 'Lãng mạn', kind: 'stories', query: { genre: 'romance', sort: 'popular' } });
  });

  it('tabs admin: add / reorder / switch off / delete, always a landing tab; validation & permission', async () => {
    const cm = await adminClient(app, 'content_manager');
    const tab = { title: { en: 'Fantasy', vi: 'Kỳ ảo' }, kind: 'stories', query: { genre: 'fantasy', sort: 'new' }, sort: 15, reason: 'Thêm tab' };
    expect((await cm.call('PUT', '/v1/admin/home-tabs/fantasy', tab)).statusCode).toBe(200);
    expect((await cm.call('PUT', '/v1/admin/home-tabs/hidden', { ...tab, query: { genre: 'hidden-genre', sort: 'popular' }, sort: 16 })).statusCode).toBe(200);
    let keys = (await home()).json().tabs.map((t: { key: string }) => t.key);
    expect(keys.slice(0, 3)).toEqual(['for-you', 'fantasy', 'novel']); // admin save refreshed the cached home
    expect(keys).not.toContain('hidden'); // inactive genre

    // landing tab switched off → the API still opens on "For you"
    const forYou = { title: { en: 'Home' }, kind: 'home', sort: 10, active: false, reason: 'Thử tắt' };
    expect((await cm.call('PUT', '/v1/admin/home-tabs/for-you', forYou)).statusCode).toBe(200);
    expect((await cm.call('DELETE', '/v1/admin/home-tabs/novel', { reason: 'Bỏ tab' })).statusCode).toBe(204);
    const tabs = (await home()).json().tabs;
    expect(tabs[0]).toEqual({ key: 'for-you', title: 'For you', kind: 'home', query: null });
    keys = tabs.map((t: { key: string }) => t.key);
    expect(keys).not.toContain('novel');

    expect((await cm.call('PUT', '/v1/admin/home-tabs/bad', { ...tab, query: null })).statusCode).toBe(400); // stories needs a query
    expect((await cm.call('PUT', '/v1/admin/home-tabs/bad', { ...tab, query: { sort: 'popular', evil: 1 } })).statusCode).toBe(400);
    expect((await cm.call('PUT', '/v1/admin/home-tabs/Bad%20Key', tab)).statusCode).toBe(400);
    expect((await cm.call('DELETE', '/v1/admin/home-tabs/nope', { reason: 'không có' })).statusCode).toBe(404);
    const list = (await cm.call('GET', '/v1/admin/home-tabs')).json().items;
    expect(list.find((t: { key: string }) => t.key === 'for-you')).toMatchObject({ active: false, title: { en: 'Home' } });
    expect((await (await adminClient(app, 'moderator')).call('GET', '/v1/admin/home-tabs')).statusCode).toBe(403);
  });

  it('admin genre / tag lists include inactive ones and story counts', async () => {
    await createStory(app, { genreIds: ['romance'], tagIds: ['isekai'] });
    const cm = await adminClient(app, 'content_manager');
    const g = (await cm.call('GET', '/v1/admin/genres')).json().items;
    expect(g.find((x: { id: string }) => x.id === 'hidden-genre')).toMatchObject({ active: false });
    expect(g.find((x: { id: string }) => x.id === 'romance')).toMatchObject({ storyCount: 1, name: { en: 'Romance', vi: 'Lãng mạn' } });
    const t = (await cm.call('GET', '/v1/admin/tags')).json().items;
    expect(t.find((x: { id: string }) => x.id === 'isekai')).toMatchObject({ storyCount: 1 });
  });
});
