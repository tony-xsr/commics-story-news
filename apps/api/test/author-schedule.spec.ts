import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '../src/infra/redis/redis.service';
import { adminClient } from './admin-helpers';
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
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('release schedule + author page', () => {
  it('story shows its release days and the next scheduled chapter; author page lists their public stories', async () => {
    const admin = await adminClient(app, 'content_manager');
    const created = await admin.call('POST', '/v1/admin/stories', {
      title: 'Weekly Tales',
      type: 'novel',
      status: 'ongoing',
      authorName: 'Ana Writer',
      releaseDays: [5, 2],
    });
    expect(created.statusCode).toBe(201);
    const story = created.json();
    expect(story.releaseDays).toEqual([5, 2]);
    await admin.call('POST', `/v1/admin/stories/${story.id}/chapters`, { title: 'One', body: 'Text', isFree: true, status: 'published' });
    const at = new Date(Date.now() + 3 * 86_400_000);
    at.setUTCMilliseconds(0);
    const scheduled = await admin.call('POST', `/v1/admin/stories/${story.id}/chapters`, {
      title: 'Two',
      body: 'Text',
      status: 'scheduled',
      publishAt: at.toISOString(),
    });
    expect(scheduled.statusCode).toBe(201);
    // a draft story of the same author: not public, not counted
    await admin.call('POST', '/v1/admin/stories', { title: 'Draft One', type: 'novel', authorName: 'Ana Writer' });

    const detail = (await get(`/v1/stories/${story.id}`)).json();
    expect(detail.releaseDays).toEqual([2, 5]);
    expect(detail.nextChapterAt).toBe(at.toISOString());
    expect(detail.authorInfo).toMatchObject({ name: 'Ana Writer' });

    const authorId = detail.authorInfo.id as string;
    const author = await get(`/v1/authors/${authorId}`);
    expect(author.statusCode).toBe(200);
    expect(author.headers['cache-control']).toContain('public');
    expect(author.json()).toMatchObject({ id: authorId, name: 'Ana Writer', storyCount: 1 });
    const list = (await get(`/v1/stories?author=${authorId}`)).json();
    expect(list.items.map((s: { id: string }) => s.id)).toEqual([story.id]);

    expect((await get('/v1/authors/01a1a6ac-0000-7000-8000-000000000000')).statusCode).toBe(404);
    expect((await get('/v1/authors/not-a-uuid')).statusCode).toBe(400);
    expect((await get('/v1/stories?author=nope')).statusCode).toBe(400);
  });

  it('release days are validated (0–6, at most 7)', async () => {
    const admin = await adminClient(app, 'content_manager');
    for (const releaseDays of [[7], [-1], [0, 1, 2, 3, 4, 5, 6, 0]]) {
      expect((await admin.call('POST', '/v1/admin/stories', { title: 'Bad', type: 'novel', releaseDays })).statusCode).toBe(400);
    }
  });
});
