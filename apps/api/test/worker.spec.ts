import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chapters, stories } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { PublishingService } from '../src/modules/stories/publishing.service';
import { ViewsService } from '../src/modules/stories/views.service';
import { WorkerModule } from '../src/worker/worker.module';
import { createChapters, createStory } from './factories';
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
});

const db = () => app.get(DbService).write;
const get = (url: string) => app.inject({ method: 'GET', url });
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

describe('scheduled publishing', () => {
  it('publishes due chapters, updates story counters, and readers see them immediately', async () => {
    const story = await createStory(app, { chapterCount: 2 });
    await createChapters(app, story, 4, (n) =>
      n <= 2
        ? {}
        : n === 3
          ? { status: 'scheduled', publishAt: minutes(-1), publishedAt: null }
          : { status: 'scheduled', publishAt: minutes(60), publishedAt: null },
    );
    // warm the caches with the old state
    expect((await get(`/v1/stories/${story.id}/chapters`)).json().items).toHaveLength(2);
    expect((await get(`/v1/stories/${story.id}`)).json().chapterCount).toBe(2);

    const result = await app.get(PublishingService).publishDue();
    expect(result).toEqual({ chapters: 1, stories: [story.id] });

    const list = (await get(`/v1/stories/${story.id}/chapters`)).json().items;
    expect(list.map((c: { number: number }) => c.number)).toEqual([1, 2, 3]); // ch.4 still in the future
    const detail = (await get(`/v1/stories/${story.id}`)).json();
    expect(detail.chapterCount).toBe(3);
    expect(detail.lastChapterAt).not.toBeNull();
  });

  it('chapter 2 → next link points to the newly published chapter 3', async () => {
    const story = await createStory(app);
    const [, c2, c3] = await createChapters(app, story, 3, (n) =>
      n === 3 ? { status: 'scheduled', publishAt: minutes(-1), publishedAt: null } : {},
    );
    expect((await get(`/v1/chapters/${c2!.id}/content`)).json().nextChapterId).toBeNull();
    await app.get(PublishingService).publishDue();
    expect((await get(`/v1/chapters/${c2!.id}/content`)).json().nextChapterId).toBe(c3!.id);
  });

  it('is safe to run twice / concurrently (no double publish)', async () => {
    const story = await createStory(app);
    await createChapters(app, story, 2, () => ({ status: 'scheduled', publishAt: minutes(-1), publishedAt: null }));
    const [a, b] = await Promise.all([
      app.get(PublishingService).publishDue(),
      app.get(PublishingService).publishDue(),
    ]);
    expect(a.chapters + b.chapters).toBe(2);
    expect((await app.get(PublishingService).publishDue()).chapters).toBe(0);
    const [row] = await db().select({ n: stories.chapterCount }).from(stories).where(eq(stories.id, story.id));
    expect(row!.n).toBe(2);
  });

  it('keeps the scheduled time as the publish time', async () => {
    const story = await createStory(app);
    const at = minutes(-5);
    const [c1] = await createChapters(app, story, 1, () => ({ status: 'scheduled', publishAt: at, publishedAt: null }));
    await app.get(PublishingService).publishDue();
    const [row] = await db().select().from(chapters).where(eq(chapters.id, c1!.id));
    expect(row!.status).toBe('published');
    expect(row!.publishedAt?.getTime()).toBe(at.getTime());
  });
});

describe('worker process (BullMQ)', () => {
  it('runs the scheduled jobs: views get flushed and due chapters get published without any manual call', async () => {
    const story = await createStory(app, { viewCount: 0 });
    await createChapters(app, story, 2, (n) =>
      n === 2 ? { status: 'scheduled', publishAt: minutes(-1), publishedAt: null } : {},
    );
    await app.get(ViewsService).record(story.id, 'u:someone');

    // Same bootstrap as src/worker.ts, with fast intervals. Started after resetData() so its schedulers survive.
    vi.stubEnv('WORKER_FLUSH_INTERVAL_MS', '200');
    vi.stubEnv('WORKER_PUBLISH_INTERVAL_MS', '200');
    const worker: INestApplicationContext = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    try {
      await vi.waitFor(
        async () => {
          const [row] = await db()
            .select({ views: stories.viewCount, chapters: stories.chapterCount })
            .from(stories)
            .where(eq(stories.id, story.id));
          expect(row).toEqual({ views: 1, chapters: 2 });
        },
        { timeout: 8000, interval: 200 },
      );
    } finally {
      await worker.close();
      vi.unstubAllEnvs();
    }
  });
});
