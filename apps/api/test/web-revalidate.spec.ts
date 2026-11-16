import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { StoriesService } from '../src/modules/stories/stories.service';
import { adminClient } from './admin-helpers';
import { createStory, seedGenres, seedHomeDefaults } from './factories';
import { bootApp, resetData } from './helpers';

const SECRET = 'revalidate-secret-0123456789';
const calls: { secret: string | undefined; tags: string[] }[] = [];
let web: Server;
let app: NestFastifyApplication;

beforeAll(async () => {
  // Stand-in for the web app's /api/revalidate.
  web = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ secret: req.headers['x-revalidate-secret'] as string | undefined, tags: JSON.parse(body).tags });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => web.listen(0, r));
  Object.assign(process.env, {
    WEB_REVALIDATE_SECRET: SECRET,
    WEB_URL: `http://127.0.0.1:${(web.address() as AddressInfo).port}`,
  });
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
  web.close();
  delete process.env.WEB_REVALIDATE_SECRET;
  delete process.env.WEB_URL;
});
beforeEach(async () => {
  await resetData(app);
  calls.length = 0;
});

describe('web revalidation after admin edits', () => {
  it('story edits refresh its web pages (by id and slug) and the lists; home / catalog edits their pages', async () => {
    const story = await createStory(app, { slug: 'old-slug' });
    await app.get(StoriesService).invalidate(story.id, { slugs: ['old-slug', 'new-slug'] });
    expect(calls.at(-1)).toEqual({
      secret: SECRET,
      tags: [`story:${story.id}`, 'story-slug:old-slug', 'story-slug:new-slug', 'lists'],
    });

    await seedGenres(app);
    await seedHomeDefaults(app);
    const cm = await adminClient(app, 'content_manager');
    await cm.call('PUT', '/v1/admin/home-sections/popular', {
      title: { en: 'Hot' },
      kind: 'query',
      layout: 'grid',
      query: { sort: 'popular' },
      reason: 'Đổi tên khối',
    });
    expect(calls.map((c) => c.tags)).toContainEqual(['home']);

    await app.get(CatalogService).invalidate();
    expect(calls.at(-1)!.tags).toEqual(['catalog']);
  });

  it('a web outage never fails the edit', async () => {
    const before = process.env.WEB_URL;
    web.close();
    const story = await createStory(app);
    await expect(app.get(StoriesService).invalidate(story.id)).resolves.toBeUndefined();
    process.env.WEB_URL = before;
  });
});
