import { Injectable } from '@nestjs/common';
import type { ChapterListQuery, StoryListQuery } from '@storyzio/contracts';
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, lt, lte, max, min, ne, sql, type SQL } from 'drizzle-orm';
import {
  authors,
  chapterContents,
  chapterUnlocks,
  chapters,
  genres,
  stories,
  storyGenres,
  storyTags,
  type ComicPage,
  type I18nText,
} from '../../db/schema';
import { DbService } from '../../infra/db/db.service';

export const PUBLIC_STATUSES = ['ongoing', 'completed'] as const;

/** Everything needed to render a story card/detail, as cached (genre names kept in every language). */
export type StoryRecord = {
  id: string;
  slug: string;
  title: string;
  altTitles: string[];
  type: 'novel' | 'comic';
  status: 'ongoing' | 'completed';
  accessModel: 'free' | 'premium_or_coins' | 'coins_only';
  ageRating: number;
  coverUrl: string | null;
  bannerUrl: string | null;
  description: string;
  language: string;
  freeChapters: number;
  /** Cached records written before this field existed read as undefined → treated as off. */
  waitForFreeHours: number | null;
  chapterPrice: number;
  ratingAvg: number;
  ratingCount: number;
  viewCount: number;
  likeCount: number;
  chapterCount: number;
  lastChapterAt: string | null;
  publishedAt: string | null;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  genres: { id: string; name: I18nText }[];
  tags: string[];
  /** Admin SEO overrides (missing on records cached before 038 → treated as none). */
  seo?: { title: string | null; description: string | null; noindex: boolean };
  /** Missing on records cached before 040 → everywhere. */
  regions?: { mode: 'allow' | 'block'; countries: string[] } | null;
  /** Other public language versions of the same work (missing on records cached before 051 → none). */
  translations?: { storyId: string; slug: string; language: string; title: string }[];
  /** Missing on records cached before 049 → no schedule shown. */
  releaseDays?: number[];
  nextChapterAt?: string | null;
};

export type ListRow = { id: string; cursor: (string | number)[] };

export type ChapterRecord = {
  id: string;
  storyId: string;
  number: number;
  title: string;
  isFree: boolean;
  price: number | null;
  contentVersion: number;
  publishedAt: string;
  prevChapterId: string | null;
  nextChapterId: string | null;
};

/** Public = visible status AND publish time reached (scheduled items stay hidden until then). */
export const storyIsPublic = () =>
  and(
    inArray(stories.status, [...PUBLIC_STATUSES]),
    isNotNull(stories.publishedAt),
    lte(stories.publishedAt, sql`now()`),
  );

export const chapterIsPublic = () =>
  and(eq(chapters.status, 'published'), isNotNull(chapters.publishedAt), lte(chapters.publishedAt, sql`now()`));

@Injectable()
export class StoriesRepo {
  constructor(private readonly db: DbService) {}

  // ---------- lists (ids only; cards are hydrated from the per-story cache) ----------

  async listIds(q: StoryListQuery, after: (string | number)[] | null): Promise<ListRow[]> {
    const db = this.db.read;
    const filters: (SQL | undefined)[] = [storyIsPublic()];
    if (q.type) filters.push(eq(stories.type, q.type));
    if (q.status) filters.push(eq(stories.status, q.status));
    if (q.author) filters.push(eq(stories.authorId, q.author));
    if (q.language) filters.push(eq(stories.language, q.language));
    if (q.genre) {
      filters.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(storyGenres)
            .where(and(eq(storyGenres.storyId, stories.id), eq(storyGenres.genreId, q.genre))),
        ),
      );
    }
    if (q.tag) {
      filters.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(storyTags)
            .where(and(eq(storyTags.storyId, stories.id), eq(storyTags.tagId, q.tag))),
        ),
      );
    }

    // Each sort: ORDER BY matching an index + a row-value comparison for the cursor (stable with ties on `id`).
    const sort = SORTS[q.sort];
    if (sort.requireNotNull) filters.push(isNotNull(sort.requireNotNull));
    if (after) filters.push(sort.after(after));

    const rows = await db
      .select({ id: stories.id, ...sort.select })
      .from(stories)
      .where(and(...filters))
      .orderBy(...sort.orderBy)
      .limit(q.limit + 1);
    return rows.map((row) => ({ id: row.id, cursor: sort.cursorOf(row as Record<string, unknown>) }));
  }

  // ---------- detail ----------

  async findIdBySlug(slug: string): Promise<string | null> {
    const [row] = await this.db.read.select({ id: stories.id }).from(stories).where(eq(stories.slug, slug)).limit(1);
    return row?.id ?? null;
  }

  /** Public story with author, genres and tags — or null when missing / not public. */
  async findStory(id: string): Promise<StoryRecord | null> {
    const db = this.db.read;
    const [row] = await db
      .select({ story: stories, author: { id: authors.id, name: authors.name, avatarUrl: authors.avatarUrl } })
      .from(stories)
      .leftJoin(authors, eq(authors.id, stories.authorId))
      .where(and(eq(stories.id, id), storyIsPublic()))
      .limit(1);
    if (!row) return null;

    const group = row.story.translationOf ?? row.story.id;
    const [genreRows, tagRows, [next], versions] = await Promise.all([
      db
        .select({ id: genres.id, name: genres.name })
        .from(storyGenres)
        .innerJoin(genres, eq(genres.id, storyGenres.genreId))
        .where(and(eq(storyGenres.storyId, id), eq(genres.active, true)))
        .orderBy(asc(storyGenres.sort), asc(genres.sort)),
      db.select({ id: storyTags.tagId }).from(storyTags).where(eq(storyTags.storyId, id)).orderBy(asc(storyTags.tagId)),
      // Next chapter the admin scheduled (the publishing job invalidates this record when it goes out)
      db
        .select({ at: sql<Date | null>`min(${chapters.publishAt})` })
        .from(chapters)
        .where(and(eq(chapters.storyId, id), eq(chapters.status, 'scheduled'), gt(chapters.publishAt, sql`now()`))),
      // The other language versions readers can switch to (public ones only)
      db
        .select({ storyId: stories.id, slug: stories.slug, language: stories.language, title: stories.title })
        .from(stories)
        .where(
          and(sql`coalesce(${stories.translationOf}, ${stories.id}) = ${group}`, ne(stories.id, id), storyIsPublic()),
        )
        .orderBy(asc(stories.language)),
    ]);

    const s = row.story;
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      altTitles: s.altTitles,
      type: s.type,
      status: s.status as StoryRecord['status'],
      accessModel: s.accessModel,
      ageRating: s.ageRating,
      coverUrl: s.coverUrl,
      bannerUrl: s.bannerUrl,
      description: s.description,
      language: s.language,
      freeChapters: s.freeChapters,
      waitForFreeHours: s.waitForFreeHours,
      chapterPrice: s.chapterPrice,
      ratingAvg: Math.round((s.ratingAvg ?? 0) * 10) / 10,
      ratingCount: s.ratingCount,
      viewCount: s.viewCount,
      likeCount: s.likeCount,
      chapterCount: s.chapterCount,
      lastChapterAt: s.lastChapterAt?.toISOString() ?? null,
      publishedAt: s.publishedAt?.toISOString() ?? null,
      author: row.author?.id ? row.author : null,
      genres: genreRows,
      tags: tagRows.map((t) => t.id),
      seo: { title: s.seoTitle, description: s.seoDescription, noindex: s.seoNoindex },
      regions: s.regionMode && s.regionCountries.length ? { mode: s.regionMode, countries: s.regionCountries } : null,
      releaseDays: [...new Set(s.releaseDays)].sort(),
      nextChapterAt: next?.at ? new Date(next.at).toISOString() : null,
      translations: versions,
    };
  }

  /** Every story of the same work (all language versions, any status), this one included. */
  async groupIds(id: string): Promise<string[]> {
    const [row] = await this.db.write
      .select({ group: sql<string>`coalesce(${stories.translationOf}, ${stories.id})` })
      .from(stories)
      .where(eq(stories.id, id));
    if (!row) return [id];
    const rows = await this.db.write
      .select({ id: stories.id })
      .from(stories)
      .where(sql`coalesce(${stories.translationOf}, ${stories.id}) = ${row.group}`);
    return rows.map((r) => r.id);
  }

  /** Author page header: the author and how many public stories they have (null = unknown author). */
  async findAuthor(id: string) {
    const [row] = await this.db.read.select().from(authors).where(eq(authors.id, id)).limit(1);
    if (!row) return null;
    const [count] = await this.db.read
      .select({ n: sql<number>`count(*)::int` })
      .from(stories)
      .where(and(eq(stories.authorId, id), storyIsPublic()));
    return { id: row.id, name: row.name, avatarUrl: row.avatarUrl, bio: row.bio, storyCount: count?.n ?? 0 };
  }

  // ---------- chapters ----------

  async listChapters(storyId: string, q: ChapterListQuery, afterNumber: number | null) {
    const filters = [eq(chapters.storyId, storyId), chapterIsPublic()];
    if (afterNumber !== null)
      filters.push(q.order === 'asc' ? gt(chapters.number, afterNumber) : lt(chapters.number, afterNumber));
    return this.db.read
      .select({
        id: chapters.id,
        number: chapters.number,
        title: chapters.title,
        isFree: chapters.isFree,
        price: chapters.price,
        publishedAt: chapters.publishedAt,
      })
      .from(chapters)
      .where(and(...filters))
      .orderBy(q.order === 'asc' ? asc(chapters.number) : desc(chapters.number))
      .limit(q.limit + 1);
  }

  /** Public chapter of a public story, with its neighbours for prev/next navigation. */
  async findChapter(id: string): Promise<ChapterRecord | null> {
    const db = this.db.read;
    const [row] = await db
      .select({
        id: chapters.id,
        storyId: chapters.storyId,
        number: chapters.number,
        title: chapters.title,
        isFree: chapters.isFree,
        price: chapters.price,
        contentVersion: chapters.contentVersion,
        publishedAt: chapters.publishedAt,
      })
      .from(chapters)
      .innerJoin(stories, eq(stories.id, chapters.storyId))
      .where(and(eq(chapters.id, id), chapterIsPublic(), storyIsPublic()))
      .limit(1);
    if (!row) return null;

    const sibling = (op: typeof lt | typeof gt) =>
      db
        .select({ id: chapters.id })
        .from(chapters)
        .where(and(eq(chapters.storyId, row.storyId), op(chapters.number, row.number), chapterIsPublic()))
        .orderBy(op === lt ? desc(chapters.number) : asc(chapters.number))
        .limit(1);
    const [[prev], [next]] = await Promise.all([sibling(lt), sibling(gt)]);
    return {
      ...row,
      publishedAt: row.publishedAt!.toISOString(),
      prevChapterId: prev?.id ?? null,
      nextChapterId: next?.id ?? null,
    };
  }

  async findContent(
    chapterId: string,
    version: number,
  ): Promise<{ body: string | null; pages: ComicPage[] | null } | null> {
    const [row] = await this.db.read
      .select({ body: chapterContents.body, pages: chapterContents.pages })
      .from(chapterContents)
      .where(and(eq(chapterContents.chapterId, chapterId), eq(chapterContents.version, version)))
      .limit(1);
    return row ?? null;
  }

  /** Read-only check of ownership (chapter_unlocks is written by the unlocks module). Primary: right after a purchase. */
  async hasUnlock(userId: string, chapterId: string): Promise<boolean> {
    const [row] = await this.db.write
      .select({ one: sql`1` })
      .from(chapterUnlocks)
      .where(and(eq(chapterUnlocks.userId, userId), eq(chapterUnlocks.chapterId, chapterId)))
      .limit(1);
    return Boolean(row);
  }

  // ---------- counters ----------

  /** Adds batched view counts in one statement. */
  async addViews(counts: [storyId: string, views: number][]): Promise<void> {
    if (!counts.length) return;
    const values = sql.join(
      counts.map(([storyId, n]) => sql`(${storyId}::uuid, ${n}::bigint)`),
      sql`, `,
    );
    await this.db.write.execute(
      sql`update ${stories} set view_count = ${stories.viewCount} + v.n from (values ${values}) as v(id, n) where ${stories.id} = v.id`,
    );
  }

  /** First/last public chapter numbers (used by tests and the reader's "continue"). */
  async chapterRange(storyId: string) {
    const [row] = await this.db.read
      .select({ first: min(chapters.number), last: max(chapters.number) })
      .from(chapters)
      .where(and(eq(chapters.storyId, storyId), chapterIsPublic()));
    return row;
  }
}

type SortSpec = {
  select: Record<string, SQL | typeof stories.publishedAt | typeof stories.viewCount | typeof stories.lastChapterAt>;
  orderBy: SQL[];
  requireNotNull?: typeof stories.publishedAt | typeof stories.lastChapterAt;
  after: (cursor: (string | number)[]) => SQL;
  cursorOf: (row: Record<string, unknown>) => (string | number)[];
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

const SORTS: Record<StoryListQuery['sort'], SortSpec> = {
  new: {
    select: { k1: stories.publishedAt },
    orderBy: [desc(stories.publishedAt), desc(stories.id)],
    after: ([at, id]) => sql`(${stories.publishedAt}, ${stories.id}) < (${at}::timestamptz, ${id}::uuid)`,
    cursorOf: (r) => [iso(r.k1), String(r.id)],
  },
  updated: {
    select: { k1: stories.lastChapterAt },
    orderBy: [desc(stories.lastChapterAt), desc(stories.id)],
    requireNotNull: stories.lastChapterAt,
    after: ([at, id]) => sql`(${stories.lastChapterAt}, ${stories.id}) < (${at}::timestamptz, ${id}::uuid)`,
    cursorOf: (r) => [iso(r.k1), String(r.id)],
  },
  popular: {
    select: { k1: stories.viewCount },
    orderBy: [desc(stories.viewCount), desc(stories.id)],
    after: ([views, id]) => sql`(${stories.viewCount}, ${stories.id}) < (${views}::bigint, ${id}::uuid)`,
    cursorOf: (r) => [Number(r.k1), String(r.id)],
  },
  rating: {
    select: { k1: sql<number>`${stories.ratingAvg}`, k2: stories.ratingCount as unknown as SQL },
    orderBy: [desc(stories.ratingAvg), desc(stories.ratingCount), desc(stories.id)],
    after: ([avg, count, id]) =>
      sql`(${stories.ratingAvg}, ${stories.ratingCount}, ${stories.id}) < (${avg}::real, ${count}::int, ${id}::uuid)`,
    cursorOf: (r) => [Number(r.k1), Number(r.k2), String(r.id)],
  },
};
