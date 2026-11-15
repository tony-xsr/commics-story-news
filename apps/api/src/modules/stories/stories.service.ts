import { Injectable } from '@nestjs/common';
import type {
  AuthorProfile,
  ChapterContent,
  ChapterListQuery,
  ChapterPage,
  Lang,
  StoryCard,
  StoryDetail,
  StoryListQuery,
  StoryPage,
} from '@storyzio/contracts';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, encodeCursor, splitPage } from '../../common/http/cursor';
import type { I18nText } from '../../db/schema';
import { CacheService } from '../../infra/cache/cache.service';
import { RedisService } from '../../infra/redis/redis.service';
import { EntitlementsService } from '../premium/entitlements.service';
import { enqueueSearchSync } from '../search/sync-queue';
import { ContentProtectionService } from '../content-guard/content-protection.service';
import { ReadGuardService } from '../content-guard/read-guard.service';
import { IntegrityService } from '../integrity/integrity.service';
import { StorageService } from '../../infra/storage/storage.service';
import { WebRevalidator } from '../../infra/cdn/cdn-purge';
import { StoriesRepo, type ChapterRecord, type StoryRecord } from './stories.repo';
import { storyCache, TTL } from './stories.cache';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Uuid = z.uuid();
const Iso = z.iso.datetime({ offset: true });
const CURSORS = {
  new: z.tuple([Iso, Uuid]),
  updated: z.tuple([Iso, Uuid]),
  popular: z.tuple([z.number().int().nonnegative(), Uuid]),
  rating: z.tuple([z.number(), z.number().int().nonnegative(), Uuid]),
} as const;

/** Signed comic page URLs outlive the app's 10-minute content cache a little. */
const SIGNED_PAGE_TTL_SEC = 15 * 60;
/** S3 presigned URLs live at most 7 days. */
const SIGNED_PAGE_LONG_TTL_SEC = 7 * 86_400;

@Injectable()
export class StoriesService {
  constructor(
    private readonly repo: StoriesRepo,
    private readonly cache: CacheService,
    private readonly entitlements: EntitlementsService,
    private readonly redis: RedisService,
    private readonly guard: ReadGuardService,
    private readonly integrity: IntegrityService,
    private readonly protection: ContentProtectionService,
    private readonly storage: StorageService,
    private readonly web: WebRevalidator,
  ) {}

  // ---------- stories ----------

  async list(q: StoryListQuery): Promise<StoryPage> {
    const after = q.cursor ? (decodeCursor(q.cursor, CURSORS[q.sort]) as (string | number)[]) : null;
    const { lang, ...key } = q; // the id list is the same in every language
    const page = await this.cache.getOrSet(
      storyCache.list(key),
      TTL.list,
      async () => {
        const { items, hasMore } = splitPage(await this.repo.listIds(q, after), q.limit);
        const last = items.at(-1);
        return { ids: items.map((r) => r.id), nextCursor: hasMore && last ? encodeCursor(last.cursor) : null };
      },
      { swr: TTL.listSwr },
    );
    return { items: await this.cards(page.ids, lang), nextCursor: page.nextCursor };
  }

  /** Cards for ids, in order, from the per-story cache (stories that stopped being public are dropped). */
  async cards(ids: string[], lang: Lang): Promise<StoryCard[]> {
    const records = await Promise.all(ids.map((id) => this.record(id)));
    return records.filter((r): r is StoryRecord => r !== null).map((r) => toCard(r, lang));
  }

  async detail(idOrSlug: string, lang: Lang): Promise<StoryDetail> {
    const record = await this.record(await this.resolveId(idOrSlug));
    if (!record) throw notFound();
    return toDetail(record, lang);
  }

  async author(id: string): Promise<AuthorProfile> {
    const author = await this.cache.getOrSet(storyCache.author(id), TTL.author, () => this.repo.findAuthor(id));
    if (!author) throw new AppError('NOT_FOUND', 'Author not found');
    return author;
  }

  /** Cached public story (null = missing or not public; the null is cached too). */
  async record(storyId: string): Promise<StoryRecord | null> {
    const ver = await this.cache.version(storyCache.versionNs(storyId));
    return this.cache.getOrSet(storyCache.detail(storyId, ver), TTL.detail, () => this.repo.findStory(storyId), {
      swr: TTL.detailSwr,
    });
  }

  /**
   * Call after any change to a story or its chapters (admin edits, publishing jobs). Bumping the version retires
   * every story-scoped key at once; slugs and edited chapters' metadata are deleted explicitly. The search index
   * picks the change up on the next `search-sync` run.
   */
  async invalidate(storyId: string, opts: { slugs?: string[]; chapterIds?: string[] } = {}): Promise<void> {
    await this.cache.bumpVersion(storyCache.versionNs(storyId));
    // The other language versions list this one (title / slug / public or not) in their `translations`
    const group = (await this.repo.groupIds(storyId)).filter((id) => id !== storyId);
    await Promise.all(group.map((id) => this.cache.bumpVersion(storyCache.versionNs(id))));
    await enqueueSearchSync(this.redis.state, storyId);
    const keys = [...(opts.slugs ?? []).map(storyCache.slug), ...(opts.chapterIds ?? []).map(storyCache.chapterMeta)];
    await this.cache.del(...keys);
    // Web reader pages for this story (and the lists showing its card) refresh now, not on their timer.
    await this.web.tags([`story:${storyId}`, ...(opts.slugs ?? []).map((s) => `story-slug:${s}`), 'lists']);
  }

  private async resolveId(idOrSlug: string): Promise<string> {
    if (UUID.test(idOrSlug)) return idOrSlug.toLowerCase();
    const id = await this.cache.getOrSet(storyCache.slug(idOrSlug), TTL.slug, () => this.repo.findIdBySlug(idOrSlug));
    if (!id) throw notFound();
    return id;
  }

  // ---------- chapters ----------

  async chapters(storyId: string, q: ChapterListQuery): Promise<ChapterPage> {
    const story = await this.record(storyId);
    if (!story) throw notFound();
    const after = q.cursor ? decodeCursor(q.cursor, z.tuple([z.number().int()]))[0] : null;
    const ver = await this.cache.version(storyCache.versionNs(storyId));

    return this.cache.getOrSet(
      storyCache.chapters(storyId, ver, q.order, q.cursor, q.limit),
      TTL.chapters,
      async () => {
        const { items, hasMore } = splitPage(await this.repo.listChapters(storyId, q, after), q.limit);
        const last = items.at(-1);
        return {
          items: items.map((c) => {
            const free = isFreeChapter(story, c);
            return {
              id: c.id,
              number: c.number,
              title: c.title,
              isFree: free,
              price: free ? 0 : (c.price ?? story.chapterPrice),
              publishedAt: c.publishedAt!.toISOString(),
            };
          }),
          nextCursor: hasMore && last ? encodeCursor([last.number]) : null,
        };
      },
    );
  }

  /**
   * Chapter content. Free chapters are returned to anyone (and are CDN-cacheable); paid chapters only to users who
   * own them (private response). Otherwise CHAPTER_LOCKED (402) with the price. Premium access joins here in 006.
   */
  /**
   * `checkRegion` (controller → GeoService) runs before anything is read or counted; `restricted` tells the controller
   * not to put even a free chapter of a geo-restricted story on the CDN (it would serve every country).
   */
  async content(
    chapterId: string,
    auth?: AuthContext,
    checkRegion?: (regions: StoryRecord['regions']) => void,
  ): Promise<{ content: ChapterContent; free: boolean; restricted: boolean }> {
    await this.guard.trap(chapterId, auth?.userId);
    const chapter = await this.chapter(chapterId);
    const story = chapter ? await this.record(chapter.storyId) : null;
    if (!chapter || !story) throw new AppError('NOT_FOUND', 'Chapter not found');
    checkRegion?.(story.regions);

    const free = isFreeChapter(story, chapter);
    const owned = !free && auth ? await this.canRead(auth.userId, story, chapter.id) : false;
    if (!free && !owned) {
      throw new AppError('CHAPTER_LOCKED', 'This chapter is locked', {
        storyId: story.id,
        chapterId: chapter.id,
        price: chapter.price ?? story.chapterPrice,
      });
    }
    // Paid content: genuine-app check (admin switch), per-account limits + bot signals (free chapters are public on the CDN anyway).
    if (!free) {
      const { strict } = await this.integrity.checkPaidRead(auth!);
      await this.guard.checkPaidRead(auth!.userId, { strict });
    }

    const body = await this.cache.getOrSet(
      storyCache.chapterContent(chapter.id, chapter.contentVersion),
      TTL.content,
      () => this.repo.findContent(chapter.id, chapter.contentVersion),
    );
    if (!body) throw new AppError('NOT_FOUND', 'Chapter content not found');
    const comic = story.type === 'comic';
    // Page images are always signed (the edge refuses unsigned media/pages/* — TestPlan SEC-16). Paid comics with the
    // admin switch on: links die after 15 min. Otherwise one URL per day, valid 7 days (> CDN cache + stale window).
    const switches = comic && !free ? await this.protection.get() : null;
    const short = !!switches?.comicSignedUrls;
    const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
    const pages = comic
      ? await Promise.all(
          (body.pages ?? []).map(async (p) => ({
            ...p,
            url: short
              ? await this.storage.signedGet(p.url, SIGNED_PAGE_TTL_SEC)
              : await this.storage.signedGet(p.url, SIGNED_PAGE_LONG_TTL_SEC, day),
          })),
        )
      : null;
    return {
      restricted: !!story.regions,
      free,
      content: {
        id: chapter.id,
        storyId: story.id,
        number: chapter.number,
        title: chapter.title,
        kind: story.type === 'comic' ? 'images' : 'text',
        // Paid text carries the reader's invisible watermark; free text stays identical for the CDN.
        body:
          story.type === 'comic'
            ? null
            : free || !body.body
              ? body.body
              : this.guard.watermark(auth!.userId, body.body),
        pages,
        prevChapterId: chapter.prevChapterId,
        nextChapterId: chapter.nextChapterId,
        watermark: switches?.comicWatermark ? this.guard.comicCode(auth!.userId) : null,
      },
    };
  }

  /** For unlock flows (ads, events): the public chapter, its story, and whether the user can already read it. */
  async access(userId: string, chapterId: string) {
    const chapter = await this.chapter(chapterId);
    const story = chapter ? await this.record(chapter.storyId) : null;
    if (!chapter || !story) throw new AppError('NOT_FOUND', 'Chapter not found');
    const readable = isFreeChapter(story, chapter) || (await this.canRead(userId, story, chapter.id));
    return { chapter, story, readable };
  }

  /** Paid chapter access: bought with coins, or included in Premium (only for `premium_or_coins` stories). */
  private async canRead(userId: string, story: StoryRecord, chapterId: string): Promise<boolean> {
    if (story.accessModel === 'premium_or_coins' && (await this.entitlements.hasPremium(userId))) return true;
    return this.repo.hasUnlock(userId, chapterId);
  }

  /** Cached public chapter (with prev/next ids) — null when missing or not public. */
  async chapter(chapterId: string): Promise<ChapterRecord | null> {
    // The cached entry remembers the story version it was built under. Any story invalidation (edit, publish of a
    // neighbour → prev/next links change) bumps that version, so stale chapter metadata is rebuilt on the next read.
    const key = storyCache.chapterMeta(chapterId);
    const load = async (): Promise<CachedChapter | null> => {
      const chapter = await this.repo.findChapter(chapterId);
      return chapter && { ...chapter, storyVer: await this.cache.version(storyCache.versionNs(chapter.storyId)) };
    };
    let meta = await this.cache.getOrSet(key, TTL.chapterMeta, load);
    if (meta && meta.storyVer !== (await this.cache.version(storyCache.versionNs(meta.storyId)))) {
      await this.cache.del(key);
      meta = await this.cache.getOrSet(key, TTL.chapterMeta, load);
    }
    if (!meta) return null;
    const { storyVer: _ver, ...chapter } = meta;
    return chapter;
  }
}

// ---------- mapping ----------

export const isFreeChapter = (
  story: Pick<StoryRecord, 'accessModel' | 'freeChapters'>,
  chapter: { number: number; isFree: boolean },
) => story.accessModel === 'free' || chapter.isFree || chapter.number <= story.freeChapters;

const localize = (text: I18nText, lang: Lang) => text[lang] ?? text.en;

export function toCard(r: StoryRecord, lang: Lang): StoryCard {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    type: r.type,
    status: r.status,
    coverUrl: r.coverUrl,
    author: r.author?.name ?? null,
    genres: r.genres.map((g) => ({ id: g.id, name: localize(g.name, lang) })),
    tags: r.tags,
    description: r.description,
    chapterCount: r.chapterCount,
    views: r.viewCount,
    rating: r.ratingAvg,
    lastChapterAt: r.lastChapterAt,
    ageRating: r.ageRating,
    regions: r.regions ?? null,
    language: r.language,
  };
}

export function toDetail(r: StoryRecord, lang: Lang): StoryDetail {
  return {
    ...toCard(r, lang),
    altTitles: r.altTitles,
    authorInfo: r.author,
    bannerUrl: r.bannerUrl,
    language: r.language,
    accessModel: r.accessModel,
    freeChapters: r.freeChapters,
    waitForFreeHours: r.waitForFreeHours ?? null,
    chapterPrice: r.chapterPrice,
    ratingCount: r.ratingCount,
    likes: r.likeCount,
    publishedAt: r.publishedAt,
    seo: r.seo ?? { title: null, description: null, noindex: false },
    releaseDays: r.releaseDays ?? [],
    // A scheduled time already past (record cached before the job ran) is not "next" any more
    nextChapterAt: r.nextChapterAt && Date.parse(r.nextChapterAt) > Date.now() ? r.nextChapterAt : null,
    translations: r.translations ?? [],
  };
}

type CachedChapter = ChapterRecord & { storyVer: number };

const notFound = () => new AppError('NOT_FOUND', 'Story not found');
