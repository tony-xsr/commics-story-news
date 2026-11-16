import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbService } from '../src/infra/db/db.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { MeiliEngine } from '../src/modules/search/meili.engine';
import { SEARCH_ENGINE } from '../src/modules/search/search.engine';
import { PgSearchEngine } from '../src/modules/search/search.repo';
import { SearchService } from '../src/modules/search/search.service';
import { adminClient } from './admin-helpers';
import { seedGenres } from './factories';
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
  await app.get(RedisService).cache.flushdb();
  await seedGenres(app);
  const engine = app.get<MeiliEngine>(SEARCH_ENGINE);
  await engine.drop();
  await engine.setup();
});

const get = (url: string) => app.inject({ method: 'GET', url });
const ids = (body: { items: { id: string }[] }) => body.items.map((s) => s.id).sort();

/** An English work with a published Vietnamese version, one chapter each. */
async function work() {
  const admin = await adminClient(app, 'content_manager');
  const en = (
    await admin.call('POST', '/v1/admin/stories', {
      title: 'Moon Gate',
      type: 'novel',
      status: 'ongoing',
      language: 'en',
      authorName: 'Ana',
      genreIds: ['fantasy'],
      chapterPrice: 7,
    })
  ).json();
  await admin.call('POST', `/v1/admin/stories/${en.id}/chapters`, { title: 'One', body: 'English text', isFree: true, status: 'published' });
  const created = await admin.call('POST', `/v1/admin/stories/${en.id}/translations`, {
    language: 'vi',
    title: 'Cổng Trăng',
    description: 'Bản tiếng Việt',
  });
  expect(created.statusCode).toBe(201);
  const vi = created.json();
  return { admin, en, vi };
}

describe('story language versions', () => {
  it('a translation copies the work, starts as a draft, then both versions list each other', async () => {
    const { admin, en, vi } = await work();
    expect(vi).toMatchObject({ language: 'vi', title: 'Cổng Trăng', status: 'draft', translationOf: en.id, chapterPrice: 7, genreIds: ['fantasy'], authorName: 'Ana' });
    expect(vi.translations.map((t: { language: string }) => t.language)).toEqual(['en', 'vi']);
    // draft: not public, not offered to readers
    expect((await get(`/v1/stories/${en.id}`)).json().translations).toEqual([]);

    await admin.call('PATCH', `/v1/admin/stories/${vi.id}`, { status: 'ongoing' });
    await admin.call('POST', `/v1/admin/stories/${vi.id}/chapters`, { title: 'Một', body: 'Chữ tiếng Việt', isFree: true, status: 'published' });
    const enDetail = (await get(`/v1/stories/${en.id}`)).json();
    expect(enDetail.translations).toEqual([{ storyId: vi.id, slug: vi.slug, language: 'vi', title: 'Cổng Trăng' }]);
    const viDetail = (await get(`/v1/stories/${vi.slug}`)).json();
    expect(viDetail).toMatchObject({ language: 'vi', translations: [{ storyId: en.id, language: 'en', title: 'Moon Gate' }] });
    // own chapters per version
    const viChapters = (await get(`/v1/stories/${vi.id}/chapters`)).json().items;
    expect(viChapters).toHaveLength(1);
    expect((await get(`/v1/chapters/${viChapters[0].id}/content`)).json().body).toContain('tiếng Việt');

    // a translation of a translation joins the same work
    const ja = (await admin.call('POST', `/v1/admin/stories/${vi.id}/translations`, { language: 'ja', title: '月の門' })).json();
    expect(ja.translationOf).toBe(en.id);
  });

  it('one version per language: a second one, or switching a version to a taken language → 409', async () => {
    const { admin, en, vi } = await work();
    const again = await admin.call('POST', `/v1/admin/stories/${en.id}/translations`, { language: 'vi', title: 'Lại' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
    expect((await admin.call('POST', `/v1/admin/stories/${vi.id}/translations`, { language: 'en', title: 'Again' })).statusCode).toBe(409);
    const switched = await admin.call('PATCH', `/v1/admin/stories/${vi.id}`, { language: 'en' });
    expect(switched.statusCode).toBe(409);
    expect((await admin.call('POST', `/v1/admin/stories/${en.id}/translations`, { language: 'xx', title: 'Bad' })).statusCode).toBe(400);
  });

  it('reading language filters lists, search and home; omitted = every language', async () => {
    const { admin, en, vi } = await work();
    await admin.call('PATCH', `/v1/admin/stories/${vi.id}`, { status: 'ongoing' });
    expect(ids((await get('/v1/stories?language=vi')).json())).toEqual([vi.id]);
    expect(ids((await get('/v1/stories?language=en')).json())).toEqual([en.id]);
    expect(ids((await get('/v1/stories')).json())).toEqual([en.id, vi.id].sort());
    expect((await get('/v1/stories?language=ja')).json().items).toEqual([]);
    expect((await get('/v1/stories?language=klingon')).statusCode).toBe(400);
    // cards say their language
    expect((await get('/v1/stories?language=vi')).json().items[0].language).toBe('vi');

    // Meilisearch (filterable `language`) and the Postgres fallback
    await app.get(SearchService).syncPending();
    expect(ids((await get(`/v1/search?q=${encodeURIComponent('Cổng')}&language=vi`)).json())).toEqual([vi.id]);
    expect((await get('/v1/search?q=Moon&language=vi')).json().items).toEqual([]);
    expect(ids((await get('/v1/search?q=Moon&language=en')).json())).toEqual([en.id]);
    const pg = new PgSearchEngine(app.get(DbService));
    expect((await pg.search({ q: 'Trăng', offset: 0, limit: 10, language: 'vi' })).ids).toEqual([vi.id]);
    expect((await pg.search({ q: 'Trăng', offset: 0, limit: 10, language: 'en' })).ids).toEqual([]);

    const home = (language?: string) =>
      get(`/v1/home?lang=en${language ? `&language=${language}` : ''}`).then((r) => r.json().sections.flatMap((s: { stories: { id: string }[] }) => s.stories.map((x) => x.id)));
    const viHome = await home('vi');
    expect(viHome).not.toContain(en.id);
    expect((await home('en'))).not.toContain(vi.id);
  });
});
