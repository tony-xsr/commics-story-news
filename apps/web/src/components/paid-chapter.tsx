'use client';

import { ApiError, qk, useChapterContent, useOffers, useSaveProgress, useUnlockChapters } from '@storyzio/api-client';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/client';
import type { T } from '@/i18n';
import { useSignedIn } from '@/lib/session';
import { ChapterBody } from './chapter-body';

type Props = {
  storyId: string;
  chapterId: string;
  number: number;
  price: number;
  /** `premium_or_coins` story: Premium opens it too (suggested next to the coin price). */
  premiumIncluded: boolean;
  fallback: React.ReactNode;
};

/**
 * A paid chapter on the web. Anonymous visitors see the server-rendered `fallback` (price + “open in app”);
 * signed-in readers get the content if they own it, otherwise a one-tap coin unlock. Nothing of it is in the HTML.
 */
export function PaidChapter(props: Props) {
  const { t, href } = useI18n();
  const signedIn = useSignedIn();
  const pathname = usePathname();
  if (!signedIn) {
    return (
      <div className="grid gap-3">
        {props.fallback}
        <p className="text-center text-sm text-text-secondary">
          {t('paid.haveCoins')}{' '}
          <Link href={`${href('/login')}?next=${encodeURIComponent(pathname)}`} className="font-semibold text-primary">
            {t('paid.signInToUnlock')}
          </Link>
        </p>
      </div>
    );
  }
  return <SignedInChapter {...props} />;
}

function SignedInChapter({ storyId, chapterId, number, premiumIncluded, fallback }: Props) {
  const { t } = useI18n();
  const content = useChapterContent(chapterId);
  const locked = content.error instanceof ApiError && content.error.code === 'CHAPTER_LOCKED';
  if (content.data) return <ChapterBody content={content.data} />;
  if (content.isPending) return <p className="py-10 text-center text-text-tertiary">{t('common.loading')}</p>;
  if (locked) {
    return <Unlock storyId={storyId} chapterId={chapterId} number={number} premiumIncluded={premiumIncluded} fallback={fallback} />;
  }
  return <p className="rounded-2xl bg-white px-6 py-10 text-center text-text-secondary">{errorText(t, content.error)}</p>;
}

function Unlock({ storyId, chapterId, number, premiumIncluded, fallback }: Omit<Props, 'price'>) {
  const { t, href } = useI18n();
  const offers = useOffers(storyId, number);
  const unlock = useUnlockChapters();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // One key per tap: a retry of the same tap can never charge twice.
  const key = useRef<string | null>(null);
  const single = offers.data?.offers.find((o) => o.key === 'single' && o.chapters.includes(number));

  if (offers.isPending) return <p className="py-10 text-center text-text-tertiary">{t('common.loading')}</p>;
  if (!offers.data || !single) return <>{fallback}</>;
  const balance = offers.data.balance;
  const enough = balance >= single.price;

  return (
    <div className="grid justify-items-center gap-3 rounded-2xl bg-white px-6 py-10 text-center">
      <p className="text-4xl" aria-hidden>
        🔒
      </p>
      <p className="font-semibold">{t('paid.unlockTitle', { n: number, price: single.price })}</p>
      <p className="text-sm text-text-secondary">{t('paid.balance', { n: balance })}</p>
      {enough ? (
        <button
          type="button"
          disabled={unlock.isPending}
          className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
          onClick={() => {
            key.current ??= crypto.randomUUID();
            setError(null);
            unlock.mutate(
              { body: { storyId, offerKey: 'single', fromChapter: number, expectedPrice: single.price }, idempotencyKey: key.current },
              {
                onSuccess: () => {
                  key.current = null;
                  void qc.invalidateQueries({ queryKey: qk.chapter(chapterId) });
                },
                onError: (err) => {
                  // A changed price means a new purchase decision: next tap gets a new key.
                  if (err instanceof ApiError && err.code === 'PRICE_CHANGED') key.current = null;
                  setError(errorText(t, err));
                },
              },
            );
          }}
        >
          {unlock.isPending ? t('paid.unlocking') : t('paid.unlock', { price: single.price })}
        </button>
      ) : (
        <p className="text-sm text-text-secondary">
          {t('paid.notEnough')}{' '}
          <Link href={href('/coins')} className="font-semibold text-primary">
            {t('nav.buyCoins')}
          </Link>{' '}
          {t('paid.comeBack')}
        </p>
      )}
      {premiumIncluded ? (
        <p className="text-sm text-text-secondary">
          {t('paid.orPremium')}{' '}
          <Link href={href('/premium')} className="font-semibold text-primary">
            {t('nav.premium')}
          </Link>
          .
        </p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

/** Marks the chapter as read for the library / “continue reading” (once per page view). */
export function ReadingProgress({ storyId, chapterId }: { storyId: string; chapterId: string }) {
  const signedIn = useSignedIn();
  const save = useSaveProgress();
  const sent = useRef(false);
  useEffect(() => {
    if (!signedIn || sent.current) return;
    sent.current = true;
    save.mutate({ storyId, chapterId, position: 0 });
  }, [signedIn, storyId, chapterId, save]);
  return null;
}

function errorText(t: T, err: unknown): string {
  if (!(err instanceof ApiError)) return t('common.error');
  switch (err.code) {
    case 'INSUFFICIENT_COINS':
      return t('err.insufficientCoins');
    case 'PRICE_CHANGED':
      return t('err.priceChanged');
    case 'READING_RESTRICTED':
      return t('err.readingRestricted');
    case 'GEO_BLOCKED':
      return t('err.geoBlocked');
    case 'RATE_LIMITED':
      return (err.details as { reason?: string } | undefined)?.reason === 'daily_limit' ? t('err.dailyLimit') : t('err.rateLimited');
    default:
      return t('common.error');
  }
}
