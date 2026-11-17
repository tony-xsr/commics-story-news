'use client';

import { useWallet } from '@storyzio/api-client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/i18n/client';
import { authCall, useSignedIn } from '@/lib/session';

export function UserMenu() {
  const { t, href } = useI18n();
  const signedIn = useSignedIn();
  const pathname = usePathname();
  if (!signedIn) {
    return (
      <Link href={`${href('/login')}?next=${encodeURIComponent(pathname)}`} className="font-semibold text-primary">
        {t('nav.signIn')}
      </Link>
    );
  }
  return <SignedInMenu />;
}

function SignedInMenu() {
  const { t, href } = useI18n();
  const wallet = useWallet();
  return (
    <>
      <Link href={href('/library')}>{t('nav.library')}</Link>
      <Link href={href('/premium')}>{t('nav.premium')}</Link>
      {wallet.data ? (
        <Link href={href('/coins')} title={t('nav.buyCoins')} className="font-semibold text-primary">
          🪙 {wallet.data.coins}
        </Link>
      ) : null}
      <button
        type="button"
        className="hover:text-primary"
        onClick={async () => {
          await authCall('logout').catch(() => {});
          // Full reload on purpose: drops every cached per-user query along with the session.
          window.location.assign(href('/'));
        }}
      >
        {t('nav.signOut')}
      </button>
    </>
  );
}
