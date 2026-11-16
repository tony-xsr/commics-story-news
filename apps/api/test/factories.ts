import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  authors,
  chapterContents,
  chapters,
  genres,
  stories,
  storyGenres,
  storyTags,
  tags,
  type I18nText,
} from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { sql } from 'drizzle-orm';

const db = (app: NestFastifyApplication) => app.get(DbService).write;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

export async function seedGenres(app: NestFastifyApplication) {
  const rows: { id: string; name: I18nText; sort: number; color: string }[] = [
    { id: 'romance', name: { en: 'Romance', vi: 'Lãng mạn' }, sort: 1, color: '#FF8CC0' },
    { id: 'fantasy', name: { en: 'Fantasy', vi: 'Kỳ ảo' }, sort: 2, color: '#8F7DE8' },
    { id: 'drama', name: { en: 'Drama' }, sort: 3, color: '#F58B66' },
  ];
  await db(app).insert(genres).values(rows);
  await db(app)
    .insert(genres)
    .values({ id: 'hidden-genre', name: { en: 'Hidden' }, active: false });
  await db(app)
    .insert(tags)
    .values([
      { id: 'slow-burn', name: 'Slow Burn' },
      { id: 'isekai', name: 'Isekai' },
    ]);
}

type StoryInput = Partial<typeof stories.$inferInsert> & { genreIds?: string[]; tagIds?: string[]; author?: string };

export async function createStory(app: NestFastifyApplication, input: StoryInput = {}) {
  const { genreIds = [], tagIds = [], author, ...values } = input;
  const authorId = author ? (await db(app).insert(authors).values({ name: author }).returning())[0]!.id : null;
  const slug = values.slug ?? `story-${randomUUID().slice(0, 8)}`;
  const [story] = await db(app)
    .insert(stories)
    .values({
      title: `Story ${slug}`,
      type: 'novel',
      status: 'ongoing',
      publishedAt: ago(60),
      ...values,
      slug,
      authorId,
    })
    .returning();
  if (genreIds.length) {
    await db(app)
      .insert(storyGenres)
      .values(genreIds.map((genreId, sort) => ({ storyId: story!.id, genreId, sort })));
  }
  if (tagIds.length)
    await db(app)
      .insert(storyTags)
      .values(tagIds.map((tagId) => ({ storyId: story!.id, tagId })));
  return story!;
}

/** Publishes `count` chapters (1..count) with content; updates the story's denormalized counters. */
export async function createChapters(
  app: NestFastifyApplication,
  story: { id: string; type: 'novel' | 'comic' },
  count: number,
  overrides: (n: number) => Partial<typeof chapters.$inferInsert> = () => ({}),
) {
  const rows = await db(app)
    .insert(chapters)
    .values(
      Array.from({ length: count }, (_, i) => ({
        storyId: story.id,
        number: i + 1,
        title: `Chapter ${i + 1}`,
        status: 'published' as const,
        publishedAt: ago(count - i),
        ...overrides(i + 1),
      })),
    )
    .returning();
  await db(app)
    .insert(chapterContents)
    .values(
      rows.map((c) =>
        story.type === 'comic'
          ? {
              chapterId: c.id,
              version: 1,
              pages: [{ url: `https://cdn.test/${c.id}/1.avif`, width: 720, height: 1280 }],
            }
          : { chapterId: c.id, version: 1, body: `Body of chapter ${c.number}` },
      ),
    );
  return rows.sort((a, b) => a.number - b.number);
}

/** Rewards defaults = the same SQL migration production runs (tests truncate every table between cases). */
/** Default home sections (custom migration 0024). */
/** Default home sections (0024) + home tabs (0040, custom migrations). */
export async function seedHomeDefaults(app: NestFastifyApplication) {
  for (const name of ['0024_home_sections_defaults', '0040_home_tabs_defaults']) {
    await db(app).execute(sql.raw(readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8')));
  }
}

/** Default documents + app config (custom migration 0022) — the test DB is truncated between tests. */
export async function seedDocumentDefaults(app: NestFastifyApplication) {
  const file = readFileSync(new URL('../drizzle/0022_documents_defaults.sql', import.meta.url), 'utf8');
  for (const statement of file.split('--> statement-breakpoint')) {
    if (statement.trim()) await db(app).execute(sql.raw(statement));
  }
}

export async function seedRewardDefaults(app: NestFastifyApplication) {
  for (const name of ['0014_reward_defaults', '0017_shop_ads_defaults', '0026_badge_translations']) {
    const file = readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8');
    for (const statement of file.split('--> statement-breakpoint')) {
      if (statement.trim()) await db(app).execute(sql.raw(statement));
    }
  }
}
