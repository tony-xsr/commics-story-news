import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chapterContents, chapterUnlocks } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { adminClient } from './admin-helpers';
import { createChapters, createStory } from './factories';
import { bearer, bootApp, resetData } from './helpers';
import { TEST_S3_ENDPOINT } from './test-env';

let app: NestFastifyApplication;
const CDN = `${TEST_S3_ENDPOINT}/storyzio-test`;

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

/** A comic with chapter 1 free and chapter 2 owned by the reader; pages live on our CDN. */
async function setup() {
  const story = await createStory(app, { type: 'comic', freeChapters: 1, chapterPrice: 10 });
  const chapters = await createChapters(app, story, 2);
  const db = app.get(DbService).write;
  for (const c of chapters) {
    await db
      .update(chapterContents)
      .set({ pages: [{ url: `${CDN}/media/${c.id}/1.webp`, width: 720, height: 1280 }] })
      .where(eq(chapterContents.chapterId, c.id));
  }
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: 'device-comic-protect-1' },
  });
  const { user, accessToken } = res.json();
  await db
    .insert(chapterUnlocks)
    .values({ userId: user.id, chapterId: chapters[1]!.id, storyId: story.id, chapterNumber: 2, method: 'coins' });
  const read = (id: string) =>
    app.inject({ method: 'GET', url: `/v1/chapters/${id}/content`, headers: bearer(accessToken) });
  return { userId: user.id as string, free: chapters[0]!.id, paid: chapters[1]!.id, read };
}

describe('paid-comic protection switches', () => {
  it('off by default: page URLs still signed (7 days, same URL all day → caches hit), no watermark', async () => {
    const s = await setup();
    const body = (await s.read(s.paid)).json();
    const url = new URL(body.pages[0].url);
    expect(`${url.origin}${url.pathname}`).toMatch(new RegExp(`^${CDN}/media/.+/1\\.webp$`));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect((await s.read(s.paid)).json().pages[0].url).toBe(body.pages[0].url);
    expect(body.watermark).toBeNull();
  });

  it('on: paid pages are signed + expire, carry the reader code (traceable); free chapters untouched', async () => {
    const s = await setup();
    const sa = await adminClient(app, 'super_admin');
    const saved = await sa.call('PUT', '/v1/admin/content-protection', {
      comicSignedUrls: true,
      comicWatermark: true,
      appIntegrity: 'off',
      reason: 'Bật bảo vệ comic',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ comicSignedUrls: true, comicWatermark: true, appIntegrity: 'off' });

    const paid = (await s.read(s.paid)).json();
    const url = new URL(paid.pages[0].url);
    expect(url.pathname).toMatch(/\/storyzio-test\/media\/.+\/1\.webp$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(paid.watermark).toMatch(/^SZ-[A-Z2-7]{29}$/);

    // A leaked page: support types the code they see on it → the reader.
    const support = await adminClient(app, 'support');
    const found = await support.call('POST', '/v1/admin/watermark/find', {
      text: paid.watermark,
      reason: 'Leak report #7',
    });
    expect(found.json().matches).toEqual([expect.objectContaining({ userId: s.userId })]);

    const free = await s.read(s.free);
    expect(free.json().pages[0].url).toMatch(new RegExp(`^${CDN}/.+X-Amz-Expires=604800`));
    expect(free.json().watermark).toBeNull();
    expect(free.headers['cache-control']).toContain('public');

    // Each switch on its own.
    await sa.call('PUT', '/v1/admin/content-protection', {
      comicSignedUrls: false,
      comicWatermark: true,
      appIntegrity: 'off',
      reason: 'Chỉ watermark',
    });
    const only = (await s.read(s.paid)).json();
    expect(only.pages[0].url).toContain('X-Amz-Expires=604800');
    expect(only.watermark).toMatch(/^SZ-/);
  });

  it('super admin only; the change is audited', async () => {
    const cm = await adminClient(app, 'content_manager');
    expect(
      (
        await cm.call('PUT', '/v1/admin/content-protection', {
          comicSignedUrls: true,
          comicWatermark: true,
          appIntegrity: 'off',
          reason: 'thử quyền',
        })
      ).statusCode,
    ).toBe(403);
    expect((await cm.call('GET', '/v1/admin/content-protection')).statusCode).toBe(403);
    const sa = await adminClient(app, 'super_admin');
    expect(
      (await sa.call('PUT', '/v1/admin/content-protection', { comicSignedUrls: true, comicWatermark: false }))
        .statusCode,
    ).toBe(400); // reason
    await sa.call('PUT', '/v1/admin/content-protection', {
      comicSignedUrls: true,
      comicWatermark: false,
      appIntegrity: 'off',
      reason: 'Bật link ký',
    });
    const audit = (await sa.call('GET', '/v1/admin/audit-logs?entity=app_settings')).json();
    expect(audit.items[0]).toMatchObject({ action: 'content_protection.save' });
  });
});
