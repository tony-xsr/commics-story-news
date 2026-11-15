import { Injectable } from '@nestjs/common';
import type { UnlockOffers, UnlockRequest, UnlockResult, WaitFreeUnlockRequest } from '@storyzio/contracts';
import { allocatePrice, unlockOptions } from '@storyzio/shared';
import { createHash } from 'node:crypto';
import { AppError } from '../../common/errors/app-error';
import { DbService, type Tx } from '../../infra/db/db.service';
import { PricingSettingsService } from '../pricing/pricing-settings.service';
import { EntitlementsService } from '../premium/entitlements.service';
import { StoriesService } from '../stories/stories.service';
import type { StoryRecord } from '../stories/stories.repo';
import { WalletService } from '../wallet/wallet.service';
import { UnlocksRepo } from './unlocks.repo';

/**
 * Pay-per-chapter with coins. Prices always come from `@storyzio/shared/pricing` evaluated HERE, on current data;
 * the client only echoes the price it showed (`expectedPrice`) so a stale screen can never charge something else.
 */
@Injectable()
export class UnlocksService {
  constructor(
    private readonly repo: UnlocksRepo,
    private readonly stories: StoriesService,
    private readonly wallet: WalletService,
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
    private readonly pricing: PricingSettingsService,
  ) {}

  async offers(userId: string, storyId: string, fromChapter?: number): Promise<UnlockOffers> {
    const story = await this.requireStory(storyId);
    if (await this.coveredByPremium(userId, story)) {
      return {
        storyId,
        balance: Math.max(await this.wallet.spendable(userId, 'coins'), 0),
        lockedCount: 0,
        offers: [],
        coveredByPremium: true,
        waitForFree: null,
      };
    }
    const [locked, balance, waitForFree] = await Promise.all([
      this.repo.lockedChapters(this.db.write, userId, story, fromChapter),
      this.wallet.spendable(userId, 'coins'),
      this.waitFreeStatus(userId, story),
    ]);
    return {
      storyId,
      balance: Math.max(balance, 0),
      lockedCount: locked.length,
      offers: unlockOptions(locked, await this.pricing.pricing(story.chapterPrice)),
      coveredByPremium: false,
      waitForFree: locked.length ? waitForFree : null,
    };
  }

  /**
   * Wait-for-free: one locked chapter opens for free (permanently) every `waitForFreeHours`. Serialized on the
   * wallet lock, so two taps / devices at once can't both pass the timer. No coins move.
   */
  async unlockWaitFree(userId: string, req: WaitFreeUnlockRequest): Promise<UnlockResult> {
    const story = await this.requireStory(req.storyId);
    const hours = waitFreeHours(story);
    if (!hours) throw new AppError('NOT_FOUND', 'This story has no wait-for-free');
    if (await this.coveredByPremium(userId, story)) {
      throw new AppError('ALREADY_UNLOCKED', 'These chapters are included in your Premium');
    }
    return this.wallet.transaction(async (tx) => {
      await this.wallet.lock(tx, userId);
      const chapter = (await this.repo.lockedChapters(tx, userId, story)).find((c) => c.id === req.chapterId);
      if (!chapter) throw new AppError('ALREADY_UNLOCKED', 'This chapter is already readable');
      const availableAt = nextWaitFree(await this.repo.lastWaitFree(tx, userId, story.id), hours);
      if (availableAt && availableAt > new Date()) {
        throw new AppError('WAIT_FOR_FREE_NOT_READY', 'The next free chapter is not ready yet', {
          availableAt: availableAt.toISOString(),
        });
      }
      await this.repo.insertUnlocks(tx, [
        { userId, chapterId: chapter.id, storyId: story.id, chapterNumber: chapter.number, method: 'wait_for_free', price: 0 },
      ]);
      return this.result(tx, userId, story.id, [chapter.number], 0);
    });
  }

  private async waitFreeStatus(userId: string, story: StoryRecord): Promise<UnlockOffers['waitForFree']> {
    const hours = waitFreeHours(story);
    if (!hours) return null;
    const availableAt = nextWaitFree(await this.repo.lastWaitFree(this.db.write, userId, story.id), hours);
    return { hours, availableAt: availableAt && availableAt > new Date() ? availableAt.toISOString() : null };
  }

  /**
   * One transaction: lock wallet → replay check → recompute offer on fresh data → debit → record unlocks.
   * Concurrent taps / devices serialize on the wallet lock; the second one sees the chapters as owned and gets
   * PRICE_CHANGED (or ALREADY_UNLOCKED) instead of paying twice.
   */
  async unlock(userId: string, req: UnlockRequest, idempotencyKey: string): Promise<UnlockResult> {
    const story = await this.requireStory(req.storyId);
    if (await this.coveredByPremium(userId, story)) {
      throw new AppError('ALREADY_UNLOCKED', 'These chapters are included in your Premium');
    }
    // Read before the transaction: no cache round-trips while holding the wallet lock.
    const pricing = await this.pricing.pricing(story.chapterPrice);
    const key = `unlock:${idempotencyKey}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([req.storyId, req.offerKey, req.fromChapter, req.expectedPrice]))
      .digest('hex');

    return this.wallet.transaction(async (tx) => {
      await this.wallet.lock(tx, userId);

      const previous = await this.wallet.findOperation(tx, userId, key);
      if (previous) {
        if (previous.meta?.fingerprint !== fingerprint) {
          throw new AppError('CONFLICT', 'Idempotency-Key was already used for a different request');
        }
        return this.result(tx, userId, story.id, previous.meta.chapters as number[], -previous.delta);
      }

      const locked = await this.repo.lockedChapters(tx, userId, story, req.fromChapter);
      if (!locked.length) throw new AppError('ALREADY_UNLOCKED', 'These chapters are already unlocked');
      const offers = unlockOptions(locked, pricing);
      const offer = offers.find((o) => o.key === req.offerKey);
      const stale = !offer || offer.price !== req.expectedPrice || locked[0]!.number !== req.fromChapter;
      if (stale) {
        throw new AppError('PRICE_CHANGED', 'The offer changed, please review it again', {
          offers,
          lockedFrom: locked[0]!.number,
        });
      }

      const bought = locked.filter((c) => offer.chapters.includes(c.number));
      const { entry } = await this.wallet.debit(tx, userId, {
        currency: 'coins',
        amount: offer.price,
        reason: 'unlock',
        idempotencyKey: key,
        refType: 'story',
        refId: story.id,
        meta: { fingerprint, chapters: offer.chapters, offerKey: offer.key },
      });

      const shares = allocatePrice(bought, offer.price);
      await this.repo.insertUnlocks(
        tx,
        bought.map((c, i) => ({
          userId,
          chapterId: c.id,
          storyId: story.id,
          chapterNumber: c.number,
          method: 'coins' as const,
          price: shares[i]!,
          ledgerId: entry.id,
        })),
      );
      return this.result(tx, userId, story.id, offer.chapters, offer.price);
    });
  }

  private async result(
    tx: Tx,
    userId: string,
    storyId: string,
    chapters: number[],
    spent: number,
  ): Promise<UnlockResult> {
    const balance = await this.wallet.spendable(userId, 'coins', new Date(), tx);
    return { storyId, chapters, spent, balance: Math.max(balance, 0) };
  }

  /**
   * Support gives back the coins of one coin unlock: the unlock row goes and the coins come back as non-expiring bonus
   * coins (no cash value, so revenue reports stay right), in one wallet transaction. `inTx` = the admin audit row.
   */
  async refundUnlock(
    userId: string,
    chapterId: string,
    inTx: (tx: Tx, refund: { coins: number; storyId: string; chapter: number }) => Promise<void>,
  ): Promise<{ coins: number; balance: number }> {
    return this.wallet.transaction(async (tx) => {
      await this.wallet.lock(tx, userId);
      const unlock = await this.repo.findUnlock(tx, userId, chapterId);
      if (!unlock) throw new AppError('NOT_FOUND', 'This chapter is not unlocked');
      if (unlock.method !== 'coins' || unlock.price <= 0) {
        throw new AppError('CONFLICT', 'Only chapters bought with coins can be refunded');
      }
      await this.repo.deleteUnlock(tx, userId, chapterId);
      const { balance } = await this.wallet.credit(tx, userId, {
        currency: 'coins',
        amount: unlock.price,
        kind: 'bonus',
        reason: 'unlock_refund',
        idempotencyKey: `unlock_refund:${chapterId}:${unlock.createdAt.getTime()}`,
        sourceType: 'chapter_unlock',
        sourceId: chapterId,
        expiresAt: null,
        refType: 'chapter',
        refId: chapterId,
      });
      await inTx(tx, { coins: unlock.price, storyId: unlock.storyId, chapter: unlock.chapterNumber });
      return { coins: unlock.price, balance };
    });
  }

  /** A chapter unlocked by a verified rewarded ad (ads module, after AdMob SSV). Idempotent. */
  async unlockByAd(tx: Tx, userId: string, chapter: { id: string; storyId: string; number: number }) {
    return this.repo.insertUnlocks(tx, [
      {
        userId,
        chapterId: chapter.id,
        storyId: chapter.storyId,
        chapterNumber: chapter.number,
        method: 'ad',
        price: 0,
      },
    ]);
  }

  private async coveredByPremium(userId: string, story: StoryRecord): Promise<boolean> {
    return story.accessModel === 'premium_or_coins' && (await this.entitlements.hasPremium(userId));
  }

  private async requireStory(storyId: string): Promise<StoryRecord> {
    const story = await this.stories.record(storyId);
    if (!story) throw new AppError('NOT_FOUND', 'Story not found');
    return story;
  }
}

/** Wait-for-free applies to premium_or_coins stories only (never to free or coins-only blockbusters). */
const waitFreeHours = (story: StoryRecord) =>
  story.accessModel === 'premium_or_coins' && story.waitForFreeHours ? story.waitForFreeHours : null;

const nextWaitFree = (last: Date | null, hours: number) => (last ? new Date(last.getTime() + hours * 3_600_000) : null);
