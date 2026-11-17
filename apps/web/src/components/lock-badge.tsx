'use client';

import { useStoryState } from '@storyzio/api-client';
import { useI18n } from '@/i18n/client';
import { useSignedIn } from '@/lib/session';

/**
 * 🔒 + price on a paid chapter in the (cached, same-for-everyone) chapter list; hidden once the signed-in reader
 * owns it. Every badge shares one `/v1/me/stories/:id/state` query.
 */
export function LockBadge({ storyId, number, price }: { storyId: string; number: number; price: number }) {
  const signedIn = useSignedIn();
  return signedIn ? <OwnedAware storyId={storyId} number={number} price={price} /> : <Badge price={price} />;
}

function OwnedAware({ storyId, number, price }: { storyId: string; number: number; price: number }) {
  const state = useStoryState(storyId);
  const { t } = useI18n();
  const owned = state.data?.unlocked.some(([from, to]) => number >= from && number <= to);
  return owned ? <span className="shrink-0 text-xs text-primary">{t('story.unlocked')}</span> : <Badge price={price} />;
}

function Badge({ price }: { price: number }) {
  const { t } = useI18n();
  return <span className="shrink-0 text-xs text-text-tertiary">🔒 {t('story.price', { price })}</span>;
}
