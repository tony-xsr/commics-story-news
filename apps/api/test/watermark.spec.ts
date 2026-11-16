import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chapterUnlocks } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { stripWatermarks } from '../src/modules/content-guard/watermark';
import { adminClient } from './admin-helpers';
import { createChapters, createStory } from './factories';
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
});

let seq = 0;
async function setup() {
  const story = await createStory(app, { type: 'novel', freeChapters: 1, chapterPrice: 10 });
  const chapters = await createChapters(app, story, 2);
  const reader = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: { deviceId: `device-wm-${++seq}-x` },
    });
    const { user, accessToken } = res.json();
    await app
      .get(DbService)
      .write.insert(chapterUnlocks)
      .values({ userId: user.id, chapterId: chapters[1]!.id, storyId: story.id, chapterNumber: 2, method: 'coins' });
    return {
      id: user.id as string,
      read: (chapterId: string) =>
        app.inject({ method: 'GET', url: `/v1/chapters/${chapterId}/content`, headers: bearer(accessToken) }),
    };
  };
  return { free: chapters[0]!.id, paid: chapters[1]!.id, reader };
}

describe('paid-text watermark', () => {
  it('each reader gets their own invisible mark on paid text; free text is unmarked and CDN-cacheable', async () => {
    const s = await setup();
    const [a, b] = [await s.reader(), await s.reader()];
    const bodyA = (await a.read(s.paid)).json().body as string;
    const bodyB = (await b.read(s.paid)).json().body as string;
    expect(bodyA).not.toBe(bodyB);
    expect(stripWatermarks(bodyA)).toBe('Body of chapter 2');
    expect(stripWatermarks(bodyB)).toBe('Body of chapter 2');

    const free = await a.read(s.free);
    expect(free.json().body).toBe('Body of chapter 1');
    expect(free.headers['cache-control']).toContain('public');
  });

  it('admin pastes leaked text → the reader who leaked it (audited); needs users.moderate', async () => {
    const s = await setup();
    const a = await s.reader();
    const leaked = `Read free at pirate.example!\n${(await a.read(s.paid)).json().body}\n— end`;

    const support = await adminClient(app, 'support');
    const res = await support.call('POST', '/v1/admin/watermark/find', { text: leaked, reason: 'DMCA ticket #12' });
    expect(res.statusCode).toBe(200);
    expect(res.json().matches).toEqual([
      { userId: a.id, marks: 1, user: expect.objectContaining({ status: 'active' }) },
    ]);
    const clean = await support.call('POST', '/v1/admin/watermark/find', {
      text: 'no marks here',
      reason: 'DMCA ticket #13',
    });
    expect(clean.json().matches).toEqual([]);
    expect((await support.call('POST', '/v1/admin/watermark/find', { text: leaked })).statusCode).toBe(400); // reason

    const audit = (
      await (await adminClient(app, 'super_admin')).call('GET', '/v1/admin/audit-logs?entity=watermark')
    ).json();
    expect(audit.items[0]).toMatchObject({ action: 'watermark.find' });

    const cm = await adminClient(app, 'content_manager');
    expect((await cm.call('POST', '/v1/admin/watermark/find', { text: leaked, reason: 'x-test' })).statusCode).toBe(
      403,
    );
  });
});
