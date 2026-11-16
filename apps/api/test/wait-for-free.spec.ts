import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chapterUnlocks } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { createChapters, createStory } from './factories';
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
  await app.get(RedisService).cache.flushdb();
});

let seq = 0;
async function reader() {
  const id = `wff-device-${++seq}-xx`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: id },
    headers: device(id),
  });
  const { user, accessToken } = res.json();
  const headers = bearer(accessToken);
  return {
    id: user.id as string,
    offers: async (storyId: string) =>
      (await app.inject({ method: 'GET', url: `/v1/me/stories/${storyId}/offers`, headers })).json(),
    waitFree: (storyId: string, chapterId: string) =>
      app.inject({ method: 'POST', url: '/v1/me/unlocks/wait-free', headers, payload: { storyId, chapterId } }),
    content: (chapterId: string) => app.inject({ method: 'GET', url: `/v1/chapters/${chapterId}/content`, headers }),
  };
}

async function wffStory(overrides: Parameters<typeof createStory>[1] = {}) {
  const story = await createStory(app, {
    accessModel: 'premium_or_coins',
    freeChapters: 1,
    waitForFreeHours: 24,
    ...overrides,
  });
  return { story, chapters: await createChapters(app, story, 5) };
}

/** Pretend the reader's last wait-for-free unlock happened `hours` ago. */
const rewind = (userId: string, hours: number) =>
  app
    .get(DbService)
    .write.update(chapterUnlocks)
    .set({ createdAt: new Date(Date.now() - hours * 3_600_000) })
    .where(and(eq(chapterUnlocks.userId, userId), eq(chapterUnlocks.method, 'wait_for_free')));

describe('wait-for-free', () => {
  it('one locked chapter free per interval, kept forever; the timer is shown in the offers', async () => {
    const { story, chapters } = await wffStory();
    const me = await reader();
    expect((await me.offers(story.id)).waitForFree).toEqual({ hours: 24, availableAt: null });
    expect((await me.content(chapters[2]!.id)).statusCode).toBe(402);

    const opened = await me.waitFree(story.id, chapters[2]!.id);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ chapters: [3], spent: 0 });
    expect((await me.content(chapters[2]!.id)).statusCode).toBe(200);

    // Next one only after the interval.
    const early = await me.waitFree(story.id, chapters[3]!.id);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('WAIT_FOR_FREE_NOT_READY');
    const at = new Date(early.json().error.details.availableAt).getTime();
    expect(at).toBeGreaterThan(Date.now() + 23.9 * 3_600_000);
    expect((await me.offers(story.id)).waitForFree.availableAt).toBe(early.json().error.details.availableAt);

    await rewind(me.id, 25);
    expect((await me.waitFree(story.id, chapters[3]!.id)).statusCode).toBe(200);
    // Earlier free chapter is still readable (permanent unlock).
    expect((await me.content(chapters[2]!.id)).statusCode).toBe(200);
  });

  it('two taps at the same time open only one chapter', async () => {
    const { story, chapters } = await wffStory();
    const me = await reader();
    const results = await Promise.all([me.waitFree(story.id, chapters[2]!.id), me.waitFree(story.id, chapters[3]!.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('timers are per reader and per story', async () => {
    const a = await wffStory();
    const b = await wffStory();
    const me = await reader();
    const other = await reader();
    expect((await me.waitFree(a.story.id, a.chapters[2]!.id)).statusCode).toBe(200);
    expect((await me.waitFree(b.story.id, b.chapters[2]!.id)).statusCode).toBe(200);
    expect((await other.waitFree(a.story.id, a.chapters[2]!.id)).statusCode).toBe(200);
  });

  it('not offered on coins-only / disabled stories; free or owned chapters are refused', async () => {
    const blockbuster = await wffStory({ accessModel: 'coins_only' });
    const off = await wffStory({ waitForFreeHours: null });
    const me = await reader();
    expect((await me.offers(blockbuster.story.id)).waitForFree).toBeNull();
    expect((await me.waitFree(blockbuster.story.id, blockbuster.chapters[2]!.id)).statusCode).toBe(404);
    expect((await me.waitFree(off.story.id, off.chapters[2]!.id)).statusCode).toBe(404);

    const { story, chapters } = await wffStory();
    const free = await me.waitFree(story.id, chapters[0]!.id); // chapter 1 is free already
    expect(free.json().error.code).toBe('ALREADY_UNLOCKED');
    // A refused attempt does not start the timer.
    expect((await me.waitFree(story.id, chapters[2]!.id)).statusCode).toBe(200);
  });
});
