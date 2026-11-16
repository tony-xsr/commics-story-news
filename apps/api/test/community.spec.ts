import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bannedWords, comments, stories, users } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { BannedWordsService } from '../src/modules/community/banned-words.service';
import { CommentsService } from '../src/modules/community/comments.service';
import { RatingsService } from '../src/modules/community/ratings.service';
import { createChapters, createStory, seedGenres } from './factories';
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
  await seedGenres(app);
});

const db = () => app.get(DbService).write;
let seq = 0;

/** Guest session; `member` upgrades it to a registered account of the given age. */
async function guest() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `device-com-${++seq}-x` },
  });
  const body = res.json();
  return { id: body.user.id as string, token: body.accessToken as string };
}

async function member(name = `Reader ${++seq}`, ageHours = 48) {
  const u = await guest();
  await db()
    .update(users)
    .set({ isGuest: false, displayName: name, createdAt: new Date(Date.now() - ageHours * 3600_000) })
    .where(eq(users.id, u.id));
  return { ...u, name };
}

type User = { token: string };
const call = (user: User | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: user ? bearer(user.token) : {}, ...(payload ? { payload } : {}) });

const post = (user: User, payload: object) => call(user, 'POST', '/v1/comments', payload);
const list = (storyId: string, query = '') => call(null, 'GET', `/v1/stories/${storyId}/comments${query}`);

async function setup() {
  const story = await createStory(app);
  const chapters = await createChapters(app, story, 3);
  return { story, chapters };
}

describe('comments', () => {
  it('guests read but must create an account to comment; members post on the story page or a chapter', async () => {
    const { story, chapters } = await setup();
    const g = await guest();
    expect((await post(g, { storyId: story.id, body: 'Hi' })).statusCode).toBe(403);

    const mai = await member('Mai');
    const onStory = await post(mai, { storyId: story.id, body: '  Truyện hay quá!  ' });
    expect(onStory.statusCode).toBe(201);
    expect(onStory.json()).toMatchObject({
      body: 'Truyện hay quá!',
      chapterId: null,
      author: { displayName: 'Mai', level: 1 },
    });
    await post(mai, { storyId: story.id, chapterId: chapters[0]!.id, body: 'Chương 1 đỉnh', isSpoiler: true });

    const storyPage = await list(story.id);
    expect(storyPage.headers['cache-control']).toContain('public');
    expect(storyPage.json().items.map((c: { body: string }) => c.body)).toEqual(['Truyện hay quá!']);
    const chapterPage = await list(story.id, `?chapterId=${chapters[0]!.id}`);
    expect(chapterPage.json().items).toEqual([expect.objectContaining({ body: 'Chương 1 đỉnh', isSpoiler: true })]);
  });

  it('only on public stories / chapters of that story', async () => {
    const { story } = await setup();
    const other = await setup();
    const draft = await createStory(app, { status: 'draft' });
    const [hidden] = await createChapters(app, story, 1, () => ({ number: 99, status: 'hidden' }));
    const u = await member();
    expect((await post(u, { storyId: draft.id, body: 'x' })).statusCode).toBe(404);
    expect((await post(u, { storyId: story.id, chapterId: other.chapters[0]!.id, body: 'x' })).statusCode).toBe(404);
    expect((await post(u, { storyId: story.id, chapterId: hidden!.id, body: 'x' })).statusCode).toBe(404);
    expect((await list(draft.id)).statusCode).toBe(404);
  });

  it('replies are one level deep, oldest first, and keep the thread chapter', async () => {
    const { story, chapters } = await setup();
    const a = await member('A');
    const b = await member('B');
    const top = (await post(a, { storyId: story.id, chapterId: chapters[1]!.id, body: 'Top' })).json();
    const r1 = (await post(b, { storyId: story.id, parentId: top.id, body: 'Reply 1' })).json();
    // replying to a reply attaches to the top-level comment
    const r2 = (await post(a, { storyId: story.id, parentId: r1.id, body: 'Reply 2' })).json();
    expect(r1).toMatchObject({ parentId: top.id, chapterId: chapters[1]!.id });
    expect(r2.parentId).toBe(top.id);

    const replies = await call(null, 'GET', `/v1/comments/${top.id}/replies`);
    expect(replies.json().items.map((c: { body: string }) => c.body)).toEqual(['Reply 1', 'Reply 2']);
    const page = await list(story.id, `?chapterId=${chapters[1]!.id}`);
    expect(page.json().items).toEqual([expect.objectContaining({ id: top.id, replyCount: 2 })]);
    // reply to a comment of another story → 404
    const other = await setup();
    expect((await post(a, { storyId: other.story.id, parentId: top.id, body: 'x' })).statusCode).toBe(404);
  });

  it('rejects links; masks banned words (case-insensitive, whole words)', async () => {
    const { story } = await setup();
    const u = await member();
    for (const body of ['đọc ở https://evil.example', 'truyenfree[.]com hay hơn', 'www.abc.net']) {
      const res = await post(u, { storyId: story.id, body });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/Links/);
    }
    await db()
      .insert(bannedWords)
      .values([{ word: 'ngu' }, { word: 'đồ ngốc' }]);
    await app.get(BannedWordsService).invalidate();
    const res = await post(u, { storyId: story.id, body: 'Main NGU quá, đồ ngốc! Nguyên tác hay hơn' });
    expect(res.json().body).toBe('Main *** quá, *******! Nguyên tác hay hơn');
  });

  it('rate limits: new accounts 1/min, others 5/min', async () => {
    const { story } = await setup();
    const fresh = await member('Fresh', 1);
    expect((await post(fresh, { storyId: story.id, body: 'one' })).statusCode).toBe(201);
    expect((await post(fresh, { storyId: story.id, body: 'two' })).statusCode).toBe(429);

    const old = await member('Old');
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post(old, { storyId: story.id, body: `c${i}` })).statusCode);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('muted users cannot post until the mute ends', async () => {
    const { story } = await setup();
    const u = await member();
    const until = new Date(Date.now() + 3600_000);
    await db().update(users).set({ mutedUntil: until }).where(eq(users.id, u.id));
    const res = await post(u, { storyId: story.id, body: 'hello' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.mutedUntil).toBe(until.toISOString());
    await db()
      .update(users)
      .set({ mutedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, u.id));
    expect((await post(u, { storyId: story.id, body: 'hello' })).statusCode).toBe(201);
  });

  it('the cached first page is refreshed on every new comment; keyset pages never repeat', async () => {
    const { story } = await setup();
    const users_ = await Promise.all([member(), member(), member(), member()]);
    expect((await list(story.id)).json().items).toEqual([]); // cached empty page
    for (const [i, u] of users_.entries()) {
      for (let k = 0; k < 5; k++) await post(u, { storyId: story.id, body: `u${i}-c${k}` });
    }
    const first = (await list(story.id)).json();
    expect(first.items).toHaveLength(20);
    expect(first.items[0].body).toBe('u3-c4'); // newest first, not the stale cached empty page
    expect(first.nextCursor).toBeNull();

    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: { id: string }[]; nextCursor: string | null } = (
        await list(story.id, `?limit=7${cursor ? `&cursor=${cursor}` : ''}`)
      ).json();
      for (const c of page.items) seen.add(c.id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(20);
    expect((await list(story.id, '?cursor=bm9wZQ')).statusCode).toBe(400);
  });

  it('authors delete their own comments only; the parent reply count follows', async () => {
    const { story } = await setup();
    const a = await member();
    const b = await member();
    const top = (await post(a, { storyId: story.id, body: 'Top' })).json();
    const reply = (await post(b, { storyId: story.id, parentId: top.id, body: 'Reply' })).json();
    expect((await call(a, 'DELETE', `/v1/comments/${reply.id}`)).statusCode).toBe(404);
    expect((await call(b, 'DELETE', `/v1/comments/${reply.id}`)).statusCode).toBe(204);
    expect((await call(b, 'DELETE', `/v1/comments/${reply.id}`)).statusCode).toBe(404);
    expect((await list(story.id)).json().items[0].replyCount).toBe(0);
    expect((await call(null, 'GET', `/v1/comments/${top.id}/replies`)).json().items).toEqual([]);
  });

  it('likes: counted once per user (write-behind), "liked by me" is a separate call; top sort uses them', async () => {
    const { story } = await setup();
    const a = await member();
    const b = await member();
    const c1 = (await post(a, { storyId: story.id, body: 'first' })).json();
    const c2 = (await post(a, { storyId: story.id, body: 'second' })).json();
    expect((await call(await guest(), 'PUT', `/v1/comments/${c1.id}/like`)).statusCode).toBe(403);
    for (const u of [a, b]) {
      expect((await call(u, 'PUT', `/v1/comments/${c1.id}/like`)).statusCode).toBe(204);
      await call(u, 'PUT', `/v1/comments/${c1.id}/like`); // repeat is a no-op
    }
    await call(b, 'PUT', `/v1/comments/${c2.id}/like`);
    await call(b, 'DELETE', `/v1/comments/${c2.id}/like`);
    expect(await app.get(CommentsService).flushLikes()).toBe(2);

    const liked = await call(b, 'GET', `/v1/me/comment-likes?ids=${c1.id},${c2.id}`);
    expect(liked.json()).toEqual({ liked: [c1.id] });
    const top = (await list(story.id, '?sort=top')).json();
    expect(top.items.map((c: { id: string; likeCount: number }) => [c.id, c.likeCount])).toEqual([
      [c1.id, 2],
      [c2.id, 0],
    ]);
    expect((await call(b, 'GET', '/v1/me/comment-likes?ids=nope')).statusCode).toBe(400);
  });

  it('my comments: includes moderation status, excludes deleted', async () => {
    const { story } = await setup();
    const u = await member();
    const c1 = (await post(u, { storyId: story.id, body: 'one' })).json();
    await post(u, { storyId: story.id, body: 'two' });
    const c3 = (await post(u, { storyId: story.id, body: 'three' })).json();
    await db().update(comments).set({ status: 'hidden' }).where(eq(comments.id, c1.id));
    await call(u, 'DELETE', `/v1/comments/${c3.id}`);
    const mine = (await call(u, 'GET', '/v1/me/comments')).json();
    expect(mine.items.map((c: { body: string; status: string }) => [c.body, c.status])).toEqual([
      ['two', 'visible'],
      ['one', 'hidden'],
    ]);
    expect(mine.items[0].story).toMatchObject({ id: story.id, slug: story.slug });
  });
});

describe('ratings', () => {
  it('one editable rating per account; story average catches up after the worker flush', async () => {
    const { story } = await setup();
    const a = await member();
    const b = await member();
    expect((await call(await guest(), 'PUT', `/v1/me/ratings/${story.id}`, { score: 5 })).statusCode).toBe(403);
    expect((await call(a, 'PUT', `/v1/me/ratings/${story.id}`, { score: 5 })).json()).toEqual({ score: 5 });
    await call(a, 'PUT', `/v1/me/ratings/${story.id}`, { score: 2 }); // edit
    await call(b, 'PUT', `/v1/me/ratings/${story.id}`, { score: 4 });
    expect((await call(a, 'PUT', `/v1/me/ratings/${story.id}`, { score: 6 })).statusCode).toBe(400);

    await app.get(RatingsService).flush();
    const [row] = await db().select().from(stories).where(eq(stories.id, story.id));
    expect(row).toMatchObject({ ratingSum: 6, ratingCount: 2, ratingAvg: 3 });
    expect((await call(a, 'GET', `/v1/me/stories/${story.id}/state`)).json().rating).toBe(2);

    expect((await call(a, 'DELETE', `/v1/me/ratings/${story.id}`)).statusCode).toBe(204);
    await app.get(RatingsService).flush();
    const [after] = await db().select().from(stories).where(eq(stories.id, story.id));
    expect(after).toMatchObject({ ratingSum: 4, ratingCount: 1 });
    expect((await call(a, 'GET', `/v1/me/stories/${story.id}/state`)).json().rating).toBeNull();
  });

  it('concurrent re-rating by the same user never double counts', async () => {
    const { story } = await setup();
    const a = await member();
    await Promise.all([1, 2, 3, 4, 5, 4, 3].map((score) => call(a, 'PUT', `/v1/me/ratings/${story.id}`, { score })));
    await app.get(RatingsService).flush();
    const [row] = await db().select().from(stories).where(eq(stories.id, story.id));
    const final = (await call(a, 'GET', `/v1/me/stories/${story.id}/state`)).json().rating;
    expect(row).toMatchObject({ ratingCount: 1, ratingSum: final });
  });
});

describe('reports', () => {
  it('3 distinct reporters auto-hide a comment pending review; repeats and self-reports do not count', async () => {
    const { story } = await setup();
    const author = await member();
    const c = (await post(author, { storyId: story.id, body: 'spammy' })).json();
    const report = (u: User) =>
      call(u, 'POST', '/v1/me/reports', { targetType: 'comment', targetId: c.id, reason: 'spam' });

    expect((await report(author)).statusCode).toBe(400);
    expect((await report(await guest())).statusCode).toBe(403);
    const r1 = await member();
    const r2 = await member();
    expect((await report(r1)).statusCode).toBe(204);
    expect((await report(r1)).statusCode).toBe(204); // idempotent
    expect((await report(r2)).statusCode).toBe(204);
    expect((await list(story.id)).json().items).toHaveLength(1); // 2 reporters: still visible

    expect((await report(await member())).statusCode).toBe(204);
    expect((await list(story.id)).json().items).toEqual([]); // cache dropped, comment pending
    const [row] = await db().select().from(comments).where(eq(comments.id, c.id));
    expect(row!.status).toBe('pending');
  });

  it('validates targets', async () => {
    const { story, chapters } = await setup();
    const u = await member();
    const other = await member();
    const r = (targetType: string, targetId: string, reason = 'other') =>
      call(u, 'POST', '/v1/me/reports', { targetType, targetId, reason, detail: 'chi tiết' });
    expect((await r('story', story.id, 'copyright')).statusCode).toBe(204);
    expect((await r('chapter', chapters[0]!.id)).statusCode).toBe(204);
    expect((await r('user', other.id, 'harassment')).statusCode).toBe(204);
    expect((await r('user', u.id)).statusCode).toBe(400);
    expect((await r('story', '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await r('story', story.id, 'boring')).statusCode).toBe(400);
  });
});
