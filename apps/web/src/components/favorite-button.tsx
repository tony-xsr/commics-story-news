'use client';

import { useStoryState, useToggleFavorite } from '@storyzio/api-client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/i18n/client';
import { useSignedIn } from '@/lib/session';

const cls = 'rounded-full border border-primary px-5 py-2 font-semibold text-primary hover:bg-container disabled:opacity-50';

/** Per-user bit on a cached public page: loaded in the browser (`/v1/me/stories/:id/state`). */
export function FavoriteButton({ storyId }: { storyId: string }) {
  const { t, href } = useI18n();
  const signedIn = useSignedIn();
  const pathname = usePathname();
  if (!signedIn) {
    return (
      <Link href={`${href('/login')}?next=${encodeURIComponent(pathname)}`} className={cls}>
        {t('fav.add')}
      </Link>
    );
  }
  return <Toggle storyId={storyId} />;
}

function Toggle({ storyId }: { storyId: string }) {
  const { t } = useI18n();
  const state = useStoryState(storyId);
  const toggle = useToggleFavorite();
  const liked = (toggle.isPending ? toggle.variables?.liked : undefined) ?? state.data?.liked ?? false;
  return (
    <button
      type="button"
      disabled={!state.data || toggle.isPending}
      aria-pressed={liked}
      className={cls}
      onClick={() => toggle.mutate({ storyId, liked: !liked })}
    >
      {t(liked ? 'fav.in' : 'fav.add')}
    </button>
  );
}
