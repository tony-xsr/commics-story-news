'use client';

import { ApiError, useApi, useWallet } from '@storyzio/api-client';
import type { StoreProduct } from '@storyzio/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { useSignedIn } from '@/lib/session';

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** Coin packs → Stripe Checkout (the API creates the session; coins arrive by webhook after payment). */
export function BuyCoins({ packs }: { packs: StoreProduct[] }) {
  const { t, href, lang } = useI18n();
  const signedIn = useSignedIn();
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key per pack per page view: a double click or retry opens the same Stripe session, never two.
  const keys = useRef(new Map<string, string>());

  const buy = async (pack: StoreProduct) => {
    if (!signedIn) {
      router.push(`${href('/login')}?next=${encodeURIComponent(href('/coins'))}`);
      return;
    }
    setBusy(pack.id);
    setError(null);
    try {
      if (!keys.current.has(pack.id)) keys.current.set(pack.id, crypto.randomUUID());
      const session = await api.payments.stripeCheckout({ productId: pack.id }, keys.current.get(pack.id)!);
      window.location.assign(session.url); // Stripe-hosted page
    } catch (err) {
      setError(
        t(err instanceof ApiError && err.code === 'PAYMENTS_UNAVAILABLE' ? 'pay.unavailable' : 'pay.couldNotOpen'),
      );
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {packs.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={busy !== null}
            onClick={() => void buy(p)}
            className="relative grid gap-1 rounded-2xl bg-white px-4 py-5 text-left hover:ring-2 hover:ring-primary disabled:opacity-60"
          >
            {p.tag ? (
              <span className="absolute right-3 top-3 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-white">{p.tag.label}</span>
            ) : null}
            <span className="text-xl font-bold">🪙 {p.coins.toLocaleString(lang)}</span>
            <span className="text-sm text-text-tertiary">{p.bonusCoins > 0 ? t('coins.bonus', { n: p.bonusCoins.toLocaleString(lang) }) : ' '}</span>
            <span className="mt-2 font-semibold text-primary">{busy === p.id ? t('pay.opening') : usd(p.priceUsdMicros)}</span>
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      {!signedIn ? <p className="text-sm text-text-tertiary">{t('pay.signInFirst')}</p> : null}
    </div>
  );
}

/** After Stripe: the webhook credits the coins within seconds — poll the wallet briefly and show the new balance. */
export function PaymentDone() {
  const { t, href } = useI18n();
  const signedIn = useSignedIn();
  const wallet = useWallet();
  const [initial, setInitial] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const coins = wallet.data?.coins;
  const arrived = coins !== undefined && initial !== null && coins > initial;

  // The balance before the webhook lands (React's “adjust state while rendering” pattern, no effect needed).
  if (coins !== undefined && initial === null) setInitial(coins);

  const { refetch } = wallet;
  useEffect(() => {
    if (arrived || timedOut) return;
    const tick = setInterval(() => void refetch(), 2000);
    const stop = setTimeout(() => setTimedOut(true), 30_000);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [arrived, timedOut, refetch]);

  return (
    <div className="mx-auto grid max-w-md justify-items-center gap-3 py-12 text-center">
      <p className="text-4xl" aria-hidden>
        🎉
      </p>
      <h1 className="text-2xl font-bold">{t('coins.thanks')}</h1>
      <p className="text-text-secondary">
        {t(arrived ? 'coins.arrived' : timedOut ? 'coins.later' : 'coins.adding')}
      </p>
      {signedIn && coins !== undefined ? <p className="text-xl font-semibold text-primary">{t('coins.balance', { n: coins })}</p> : null}
      <Link href={href('/library')} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white">
        {t('coins.back')}
      </Link>
    </div>
  );
}
