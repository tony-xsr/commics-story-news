import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stories } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { StoriesRepo } from '../src/modules/stories/stories.repo';
import { StoriesService } from '../src/modules/stories/stories.service';
import { ViewsService } from '../src/modules/stories/views.service';
import { createChapters, createStory, seedGenres } from './factories';
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
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const db = () => app.get(DbService).write;
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe('genres & tags', () => {
  it('lists active genres in order, localized with English fallback', async () => {
    const vi = (await get('/v1/genres?lang=vi')).json();
    expect(vi.items.map((g: { name: string }) => g.name)).toEqual(['Lãng mạn', 'Kỳ ảo', 'Drama']);
    const res = await get('/v1/genres');
    expect(res.json().items[0]).toEqual({ id: 'romance', name: 'Romance', color: '#FF8CC0', imageUrl: null, intro: null, faq: [] });
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  });

  it('lists tags', async () => {
    expect((await get('/v1/tags')).json().items).toEqual([
      { id: 'isekai', name: 'Isekai' },
      { id: 'slow-burn', name: 'Slow Burn' },
    ]);
  });

  it('rejects unknown languages and unknown query params', async () => {
    expect((await get('/v1/genres?lang=xx')).statusCode).toBe(400);
    expect((await get('/v1/genres?cachebust=1')).statusCode).toBe(400);
  });
});

describe('story list', () => {
  it('only public stories: drafts, hidden and scheduled (future) ones never appear', async () => {
    const visible = await createStory(app, { title: 'Visible' });
    await createStory(app, { status: 'draft' });
    await createStory(app, { status: 'hidden' });
    await createStory(app, { publishedAt: later(60) });
    await createStory(app, { publishedAt: null });

    const res = await get('/v1/stories?sort=new');
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((s: { id: string }) => s.id)).toEqual([visible.id]);
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  });

  it('filters by type, genre, tag and status', async () => {
    const romanceNovel = await createStory(app, { genreIds: ['romance'], tagIds: ['slow-burn'] });
    const fantasyComic = await createStory(app, { type: 'comic', genreIds: ['fantasy'], status: 'completed' });
    const ids = async (qs: string) => (await get(`/v1/stories?${qs}`)).json().items.map((s: { id: string }) => s.id);

    expect(await ids('type=comic')).toEqual([fantasyComic.id]);
    expect(await ids('genre=romance')).toEqual([romanceNovel.id]);
    expect(await ids('tag=slow-burn')).toEqual([romanceNovel.id]);
    expect(await ids('status=completed')).toEqual([fantasyComic.id]);
    expect(await ids('genre=romance&type=comic')).toEqual([]);
  });

  it('cards carry localized genres, author and counters', async () => {
    await createStory(app, { title: 'Moonlit Garden', author: 'Mai', genreIds: ['romance', 'fantasy'], viewCount: 42 });
    const [card] = (await get('/v1/stories?lang=vi')).json().items;
    expect(card).toMatchObject({
      title: 'Moonlit Garden',
      author: 'Mai',
      views: 42,
      genres: [
        { id: 'romance', name: 'Lãng mạn' },
        { id: 'fantasy', name: 'Kỳ ảo' },
      ],
    });
  });

  it.each(['popular', 'new', 'updated', 'rating'])(
    'sort=%s paginates with a cursor without gaps or duplicates',
    async (sort) => {
      for (let i = 0; i < 7; i++) {
        await createStory(app, {
          viewCount: i % 3, // ties on purpose: the id tiebreaker must keep pages stable
          ratingSum: (i % 2) * 9,
          ratingCount: (i % 2) * 2,
          publishedAt: new Date(Date.now() - (10 + (i % 2)) * 60_000),
          lastChapterAt: new Date(Date.now() - (i % 3) * 60_000),
        });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(`/v1/stories?sort=${sort}&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        seen.push(...body.items.map((s: { id: string }) => s.id));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    },
  );

  it('popular = most viewed first', async () => {
    const low = await createStory(app, { viewCount: 5 });
    const high = await createStory(app, { viewCount: 500 });
    expect((await get('/v1/stories?sort=popular')).json().items.map((s: { id: string }) => s.id)).toEqual([
      high.id,
      low.id,
    ]);
  });

  it('a tampered cursor is a 400, not a 500', async () => {
    expect((await get('/v1/stories?sort=popular&cursor=eyJ4IjoxfQ')).statusCode).toBe(400);
    expect((await get('/v1/stories?sort=new&cursor=%27%3B--')).statusCode).toBe(400);
  });

  it('limit is capped', async () => {
    expect((await get('/v1/stories?limit=500')).statusCode).toBe(400);
  });
});

describe('story detail', () => {
  it('by id or slug, with a purge tag; never contains per-user data', async () => {
    const story = await createStory(app, {
      slug: 'moonlit-garden',
      author: 'Mai',
      genreIds: ['romance'],
      tagIds: ['isekai'],
    });
    const byId = await get(`/v1/stories/${story.id}`);
    const bySlug = await get('/v1/stories/moonlit-garden');
    expect(byId.statusCode).toBe(200);
    expect(bySlug.json()).toEqual(byId.json());
    expect(byId.headers['cache-tag']).toBe(`story-${story.id}`);
    expect(byId.json()).toMatchObject({
      slug: 'moonlit-garden',
      authorInfo: { name: 'Mai' },
      tags: ['isekai'],
      accessModel: 'premium_or_coins',
      freeChapters: 3,
      chapterPrice: 10,
    });
    expect(Object.keys(byId.json())).not.toEqual(expect.arrayContaining(['liked', 'unlocked', 'progress']));
  });

  it('404 for unknown, draft or scheduled stories', async () => {
    const draft = await createStory(app, { status: 'draft' });
    const scheduled = await createStory(app, { publishedAt: later(10) });
    for (const id of [draft.id, scheduled.id, '01a166bc-20af-77b9-8cbf-543e2f2d97f2']) {
      const res = await get(`/v1/stories/${id}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect((await get('/v1/stories/No_Such')).statusCode).toBe(400); // invalid slug format
  });

  it('is cached: repeated reads do not hit the database', async () => {
    const story = await createStory(app);
    const spy = vi.spyOn(app.get(StoriesRepo), 'findStory');
    await get(`/v1/stories/${story.id}`);
    await get(`/v1/stories/${story.id}`);
    await get(`/v1/stories?sort=new`);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('invalidate() makes edits visible immediately, in detail AND in lists', async () => {
    const story = await createStory(app, { title: 'Old title' });
    await get(`/v1/stories/${story.id}`);
    await get('/v1/stories?sort=new');
    await db().update(stories).set({ title: 'New title' }).where(eq(stories.id, story.id));

    expect((await get(`/v1/stories/${story.id}`)).json().title).toBe('Old title'); // cached until invalidated
    await app.get(StoriesService).invalidate(story.id);
    expect((await get(`/v1/stories/${story.id}`)).json().title).toBe('New title');
    expect((await get('/v1/stories?sort=new')).json().items[0].title).toBe('New title');
  });

  it('a story hidden by admin disappears from lists after invalidate', async () => {
    const story = await createStory(app);
    expect((await get('/v1/stories')).json().items).toHaveLength(1);
    await db().update(stories).set({ status: 'hidden' }).where(eq(stories.id, story.id));
    await app.get(StoriesService).invalidate(story.id);
    expect((await get('/v1/stories')).json().items).toHaveLength(0);
    expect((await get(`/v1/stories/${story.id}`)).statusCode).toBe(404);
  });
});

describe('chapters', () => {
  it('lists published chapters with free/price computed from the story rules', async () => {
    const story = await createStory(app, { freeChapters: 3, chapterPrice: 10 });
    await createChapters(app, story, 6, (n) => (n === 5 ? { isFree: true } : n === 6 ? { price: 25 } : {}));
    const items = (await get(`/v1/stories/${story.id}/chapters`)).json().items;
    expect(items.map((c: { number: number; isFree: boolean; price: number }) => [c.number, c.isFree, c.price])).toEqual(
      [
        [1, true, 0],
        [2, true, 0],
        [3, true, 0],
        [4, false, 10],
        [5, true, 0], // promo chapter
        [6, false, 25], // price override
      ],
    );
  });

  it('hides draft and scheduled chapters', async () => {
    const story = await createStory(app);
    await createChapters(app, story, 4, (n) =>
      n === 3 ? { status: 'draft' } : n === 4 ? { publishedAt: later(30) } : {},
    );
    const numbers = (await get(`/v1/stories/${story.id}/chapters`))
      .json()
      .items.map((c: { number: number }) => c.number);
    expect(numbers).toEqual([1, 2]);
  });

  it('paginates in both directions', async () => {
    const story = await createStory(app);
    await createChapters(app, story, 5);
    const first = (await get(`/v1/stories/${story.id}/chapters?limit=2&order=desc`)).json();
    expect(first.items.map((c: { number: number }) => c.number)).toEqual([5, 4]);
    const second = (await get(`/v1/stories/${story.id}/chapters?limit=2&order=desc&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((c: { number: number }) => c.number)).toEqual([3, 2]);
  });

  it('free story (access_model=free) has every chapter free', async () => {
    const story = await createStory(app, { accessModel: 'free', freeChapters: 0 });
    await createChapters(app, story, 3);
    const items = (await get(`/v1/stories/${story.id}/chapters`)).json().items;
    expect(items.every((c: { isFree: boolean }) => c.isFree)).toBe(true);
  });

  it('404 for chapters of a non-public story', async () => {
    const story = await createStory(app, { status: 'draft' });
    expect((await get(`/v1/stories/${story.id}/chapters`)).statusCode).toBe(404);
  });
});

describe('chapter content', () => {
  it('free novel chapter: body + prev/next, CDN-cacheable', async () => {
    const story = await createStory(app);
    const [c1, c2, c3] = await createChapters(app, story, 3);
    const res = await get(`/v1/chapters/${c2!.id}/content`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: c2!.id,
      storyId: story.id,
      number: 2,
      title: 'Chapter 2',
      kind: 'text',
      body: 'Body of chapter 2',
      pages: null,
      prevChapterId: c1!.id,
      nextChapterId: c3!.id,
      watermark: null, // free chapters are never marked
    });
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  });

  it('comic chapter returns pages', async () => {
    const story = await createStory(app, { type: 'comic' });
    const [c1] = await createChapters(app, story, 1);
    const body = (await get(`/v1/chapters/${c1!.id}/content`)).json();
    expect(body).toMatchObject({ kind: 'images', body: null, pages: [{ width: 720, height: 1280 }] });
  });

  it('locked chapter → 402 CHAPTER_LOCKED with the price, and is never cached publicly', async () => {
    const story = await createStory(app, { freeChapters: 1, chapterPrice: 12 });
    const [, c2] = await createChapters(app, story, 2);
    const res = await get(`/v1/chapters/${c2!.id}/content`);
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ code: 'CHAPTER_LOCKED', details: { price: 12, chapterId: c2!.id } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('Body of chapter 2');
  });

  it('draft chapters and chapters of hidden stories are not readable', async () => {
    const story = await createStory(app);
    const [, draft] = await createChapters(app, story, 2, (n) => (n === 2 ? { status: 'draft' } : {}));
    expect((await get(`/v1/chapters/${draft!.id}/content`)).statusCode).toBe(404);

    const hidden = await createStory(app, { status: 'hidden' });
    const [h1] = await createChapters(app, hidden, 1);
    expect((await get(`/v1/chapters/${h1!.id}/content`)).statusCode).toBe(404);
  });
});

describe('views & rankings', () => {
  it('counts a view once per viewer per 30 min, flushes to Postgres in one batch', async () => {
    const story = await createStory(app, { viewCount: 10 });
    const view = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/v1/stories/${story.id}/view`, headers });
    expect((await view({ 'x-device-id': 'device-aaaa-1' })).statusCode).toBe(204);
    await view({ 'x-device-id': 'device-aaaa-1' }); // duplicate
    await view({ 'x-device-id': 'device-bbbb-2' });

    expect(await app.get(ViewsService).flush()).toBe(1);
    const [row] = await db().select({ v: stories.viewCount }).from(stories).where(eq(stories.id, story.id));
    expect(row!.v).toBe(12);
    expect(await app.get(ViewsService).flush()).toBe(0); // nothing pending
  });

  it('a failed flush re-queues the counts (no lost views)', async () => {
    const story = await createStory(app);
    await app.inject({
      method: 'POST',
      url: `/v1/stories/${story.id}/view`,
      headers: { 'x-device-id': 'device-aaaa-1' },
    });
    const spy = vi.spyOn(app.get(StoriesRepo), 'addViews').mockRejectedValueOnce(new Error('db down'));
    await expect(app.get(ViewsService).flush()).rejects.toThrow('db down');
    spy.mockRestore();
    expect(await app.get(ViewsService).flush()).toBe(1);
    const [row] = await db().select({ v: stories.viewCount }).from(stories).where(eq(stories.id, story.id));
    expect(row!.v).toBe(1);
  });

  it('views of unknown stories are rejected (no junk in counters/rankings)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/stories/01a166bc-20af-77b9-8cbf-543e2f2d97f2/view' });
    expect(res.statusCode).toBe(404);
  });

  it('daily ranking orders by views today, filterable by type', async () => {
    const a = await createStory(app);
    const b = await createStory(app, { type: 'comic' });
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: `/v1/stories/${b.id}/view`,
        headers: { 'x-device-id': `device-b-${i}000` },
      });
    }
    await app.inject({ method: 'POST', url: `/v1/stories/${a.id}/view`, headers: { 'x-device-id': 'device-a-0000' } });

    const day = (await get('/v1/rankings?period=day')).json();
    expect(day.items.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    const novels = (await get('/v1/rankings?period=week&type=novel')).json();
    expect(novels.items.map((s: { id: string }) => s.id)).toEqual([a.id]);
  });
});
