import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { chapterUnlocks, favorites, ratings, readingProgress, stories } from '../../db/schema';
import { DbService } from '../../infra/db/db.service';

export type ProgressRow = {
  userId: string;
  storyId: string;
  chapterId: string;
  chapterNumber: number;
  position: number;
  updatedAt: Date;
};

/** Per-user library tables. Every query is scoped by userId (taken from the access token, never from input). */
@Injectable()
export class LibraryRepo {
  constructor(private readonly db: DbService) {}

  // ---------- favorites ----------

  /** True when the row was created (false = already a favorite) — counters move only on real changes. */
  async addFavorite(userId: string, storyId: string): Promise<boolean> {
    const rows = await this.db.write
      .insert(favorites)
      .values({ userId, storyId })
      .onConflictDoNothing()
      .returning({ storyId: favorites.storyId });
    return rows.length > 0;
  }

  async removeFavorite(userId: string, storyId: string): Promise<boolean> {
    const rows = await this.db.write
      .delete(favorites)
      .where(and(eq(favorites.userId, userId), eq(favorites.storyId, storyId)))
      .returning({ storyId: favorites.storyId });
    return rows.length > 0;
  }

  async isFavorite(userId: string, storyId: string): Promise<boolean> {
    // Primary, not replica: the user expects to see their own tap immediately.
    const [row] = await this.db.write
      .select({ one: sql`1` })
      .from(favorites)
      .where(and(eq(favorites.userId, userId), eq(favorites.storyId, storyId)))
      .limit(1);
    return Boolean(row);
  }

  async listFavorites(userId: string, limit: number, after: [string, string] | null) {
    const filters = [eq(favorites.userId, userId)];
    if (after) {
      filters.push(sql`(${favorites.createdAt}, ${favorites.storyId}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`);
    }
    return this.db.write
      .select({ storyId: favorites.storyId, createdAt: favorites.createdAt })
      .from(favorites)
      .where(and(...filters))
      .orderBy(desc(favorites.createdAt), desc(favorites.storyId))
      .limit(limit + 1);
  }

  async addLikes(counts: [storyId: string, delta: number][]): Promise<void> {
    if (!counts.length) return;
    const values = sql.join(
      counts.map(([id, n]) => sql`(${id}::uuid, ${n}::int)`),
      sql`, `,
    );
    await this.db.write.execute(
      sql`update ${stories} set like_count = greatest(${stories.likeCount} + v.n, 0) from (values ${values}) as v(id, n) where ${stories.id} = v.id`,
    );
  }

  async rating(userId: string, storyId: string): Promise<number | null> {
    const [row] = await this.db.write
      .select({ score: ratings.score })
      .from(ratings)
      .where(and(eq(ratings.userId, userId), eq(ratings.storyId, storyId)))
      .limit(1);
    return row?.score ?? null;
  }

  // ---------- reading progress ----------

  async findProgress(userId: string, storyId: string): Promise<ProgressRow | undefined> {
    const [row] = await this.db.write
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, userId), eq(readingProgress.storyId, storyId)))
      .limit(1);
    return row;
  }

  async listHistory(userId: string, limit: number, after: [string, string] | null): Promise<ProgressRow[]> {
    const filters = [eq(readingProgress.userId, userId), isNull(readingProgress.hiddenAt)];
    if (after) {
      filters.push(
        sql`(${readingProgress.updatedAt}, ${readingProgress.storyId}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`,
      );
    }
    return this.db.write
      .select()
      .from(readingProgress)
      .where(and(...filters))
      .orderBy(desc(readingProgress.updatedAt), desc(readingProgress.storyId))
      .limit(limit + 1);
  }

  /**
   * Batch upsert from the worker. Last write wins by `updatedAt`: an older entry never overwrites a newer one
   * (two devices, retries, out-of-order flushes). Reading again un-hides a story removed from history.
   */
  async upsertProgress(rows: ProgressRow[]): Promise<void> {
    if (!rows.length) return;
    await this.db.write
      .insert(readingProgress)
      .values(rows.map((r) => ({ ...r, hiddenAt: null })))
      .onConflictDoUpdate({
        target: [readingProgress.userId, readingProgress.storyId],
        set: {
          chapterId: sql`excluded.chapter_id`,
          chapterNumber: sql`excluded.chapter_number`,
          position: sql`excluded.position`,
          updatedAt: sql`excluded.updated_at`,
          hiddenAt: sql`null`,
        },
        setWhere: sql`${readingProgress.updatedAt} < excluded.updated_at`,
      });
  }

  async hideHistory(userId: string, storyIds: string[] | 'all'): Promise<void> {
    const filters = [eq(readingProgress.userId, userId), isNull(readingProgress.hiddenAt)];
    if (storyIds !== 'all') filters.push(inArray(readingProgress.storyId, storyIds));
    await this.db.write
      .update(readingProgress)
      .set({ hiddenAt: new Date() })
      .where(and(...filters));
  }

  // ---------- unlocks (read-only here; written by the unlocks module) ----------

  async unlockedNumbers(userId: string, storyId: string): Promise<number[]> {
    const rows = await this.db.write
      .select({ n: chapterUnlocks.chapterNumber })
      .from(chapterUnlocks)
      .where(and(eq(chapterUnlocks.userId, userId), eq(chapterUnlocks.storyId, storyId)))
      .orderBy(asc(chapterUnlocks.chapterNumber));
    return rows.map((r) => r.n);
  }
}

/** Postgres foreign_key_violation (row points at a deleted user/story/chapter). */
export const isForeignKeyViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23503' || e?.cause?.code === '23503';
};
