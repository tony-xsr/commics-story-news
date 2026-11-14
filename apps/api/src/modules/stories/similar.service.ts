import { Injectable } from '@nestjs/common';
import type { Lang, StoryCard } from '@storyzio/contracts';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import { stories, storyGenres, storySimilar, storyTags } from '../../db/schema';
import { CacheService } from '../../infra/cache/cache.service';
import { DbService } from '../../infra/db/db.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StoriesService } from './stories.service';

const BATCH = 300;
const KEEP = 12;
const CURSOR = 'similar:cursor';
const PUBLIC = inArray(stories.status, ['ongoing', 'completed']);
export const similarCacheKey = (storyId: string, lang: string) => `c:similar:${storyId}:${lang}`;

/**
 * “You may also like” (admin F5). Scores from data every story already has — shared genres (×2), shared tags (×1),
 * a little popularity — never from per-reader logs. The worker refreshes a rolling batch of stories per run
 * (bounded work, read replica for scoring), and admin `pinned` / `hidden` rows always survive a refresh.
 */
@Injectable()
export class SimilarService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    private readonly stories: StoriesService,
  ) {}

  /** Worker: next BATCH stories (by id, wrapping around). Returns how many stories were refreshed. */
  async refreshBatch(): Promise<number> {
    const after = (await this.redis.state.get(CURSOR)) ?? '00000000-0000-0000-0000-000000000000';
    let batch = await this.publicIds(after);
    if (!batch.length) batch = await this.publicIds('00000000-0000-0000-0000-000000000000'); // wrap around
    for (const id of batch) await this.refresh(id);
    if (batch.length) await this.redis.state.set(CURSOR, batch.at(-1)!);
    return batch.length;
  }

  private async publicIds(after: string) {
    const rows = await this.db.read
      .select({ id: stories.id })
      .from(stories)
      .where(and(PUBLIC, isNotNull(stories.publishedAt), lte(stories.publishedAt, new Date()), gt(stories.id, after)))
      .orderBy(asc(stories.id))
      .limit(BATCH);
    return rows.map((r) => r.id);
  }

  /** Recomputes the automatic rows of one story. */
  async refresh(storyId: string): Promise<void> {
    const r = this.db.read;
    const [me] = await r.select({ age: stories.ageRating }).from(stories).where(eq(stories.id, storyId));
    if (!me) return;
    const [genreRows, tagRows] = await Promise.all([
      r.select({ id: storyGenres.genreId }).from(storyGenres).where(eq(storyGenres.storyId, storyId)),
      r.select({ id: storyTags.tagId }).from(storyTags).where(eq(storyTags.storyId, storyId)),
    ]);
    const g = genreRows.map((x) => x.id);
    const t = tagRows.map((x) => x.id);
    let candidates: { id: string; score: number }[] = [];
    if (g.length || t.length) {
      const sharedGenres = g.length
        ? sql`(select count(*) from ${storyGenres} where ${storyGenres.storyId} = ${stories.id} and ${inArray(storyGenres.genreId, g)})`
        : sql`0`;
      const sharedTags = t.length
        ? sql`(select count(*) from ${storyTags} where ${storyTags.storyId} = ${stories.id} and ${inArray(storyTags.tagId, t)})`
        : sql`0`;
      const score = sql<number>`(2 * ${sharedGenres} + ${sharedTags})::real + ln(1 + ${stories.viewCount}) / 20`;
      const candidateIds = [
        ...(g.length
          ? [r.select({ id: storyGenres.storyId }).from(storyGenres).where(inArray(storyGenres.genreId, g))]
          : []),
        ...(t.length ? [r.select({ id: storyTags.storyId }).from(storyTags).where(inArray(storyTags.tagId, t))] : []),
      ];
      candidates = await r
        .select({ id: stories.id, score })
        .from(stories)
        .where(
          and(
            ne(stories.id, storyId),
            PUBLIC,
            lte(stories.publishedAt, new Date()),
            // Never recommend adult stories from a non-adult one.
            me.age >= 18 ? undefined : sql`${stories.ageRating} < 18`,
            sql`${stories.id} in (${sql.join(
              candidateIds.map((q) => sql`(${q})`),
              sql` union `,
            )})`,
          ),
        )
        .orderBy(desc(score))
        .limit(KEEP);
    }
    await this.db.write.transaction(async (tx) => {
      const overrides = await tx
        .select({ id: storySimilar.similarId })
        .from(storySimilar)
        .where(and(eq(storySimilar.storyId, storyId), ne(storySimilar.source, 'auto')));
      const keep = overrides.map((o) => o.id);
      await tx.delete(storySimilar).where(and(eq(storySimilar.storyId, storyId), eq(storySimilar.source, 'auto')));
      const rows = candidates
        .filter((c) => !keep.includes(c.id))
        .map((c) => ({ storyId, similarId: c.id, score: Number(c.score), source: 'auto' as const }));
      if (rows.length) await tx.insert(storySimilar).values(rows).onConflictDoNothing();
    });
  }

  /** Public list: pinned first, then by score; hidden never. Cached; empty until the worker has computed it. */
  async forStory(storyId: string, lang: Lang): Promise<StoryCard[]> {
    const ids = await this.cache.getOrSet(similarCacheKey(storyId, lang), 3600, async () => {
      const rows = await this.db.read
        .select({ id: storySimilar.similarId })
        .from(storySimilar)
        .where(and(eq(storySimilar.storyId, storyId), notInArray(storySimilar.source, ['hidden'])))
        .orderBy(sql`${storySimilar.source} = 'pinned' desc`, desc(storySimilar.score))
        .limit(KEEP);
      return rows.map((r) => r.id);
    });
    // Suggestions in the language of the story being read (the other versions of it are listed on the story itself)
    const [story, cards] = await Promise.all([this.stories.record(storyId), this.stories.cards(ids, lang)]);
    return story ? cards.filter((c) => c.language === story.language) : cards;
  }

  async invalidate(storyId: string): Promise<void> {
    await this.cache.del(...['en', 'vi', 'ja', 'ko', 'zh', 'es', 'fr'].map((l) => similarCacheKey(storyId, l)));
  }
}
