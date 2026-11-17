'use client';

import { ApiError, useApi, useEntitlements } from '@storyzio/api-client';
import type { Entitlements, StoreProduct } from '@storyzio/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { StringKey } from '@/i18n';
import { useI18n } from '@/i18n/client';
import { useSignedIn } from '@/lib/session';

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const planKey = (plan: string | null, kind: 'plan' | 'per') => `premium.${kind}.${plan ?? 'monthly'}` as StringKey;

/** Plans → Stripe Checkout (subscription), or the current Premium with “Manage subscription” (Customer Portal). */
export function PremiumPlans({ plans }: { plans: StoreProduct[] }) {
  const signedIn = useSignedIn();
  return signedIn ? <SignedIn plans={plans} /> : <Choose plans={plans} signedIn={false} />;
}

function SignedIn({ plans }: { plans: StoreProduct[] }) {
  const { t } = useI18n();
  const entitlements = useEntitlements();
  if (entitlements.isPending) return <p className="text-text-tertiary">{t('common.loading')}</p>;
  const premium = entitlements.data?.premium;
  return premium?.active ? <Current premium={premium} /> : <Choose plans={plans} signedIn />;
}

function Current({ premium }: { premium: NonNullable<Entitlements['premium']> }) {
  const { t, lang } = useI18n();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = new Date(premium.expiresAt).toLocaleDateString(lang, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return (
    <div className="grid gap-3 rounded-2xl bg-white px-6 py-6">
      <p className="text-lg font-semibold">
        {t('premium.have')}{' '}
        {premium.plan ? (
          <span className="text-sm font-normal text-text-tertiary">({t(planKey(premium.plan, 'plan'))})</span>
        ) : null}
      </p>
      <p className="text-sm text-text-secondary">
        {t(premium.willRenew ? 'premium.renews' : 'premium.ends', { date })}
      </p>
      {premium.source === 'web' ? (
        <div>
          <button
            type="button"
            disabled={busy}
            className="rounded-full border border-primary px-5 py-2 font-semibold text-primary hover:bg-container disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                window.location.assign((await api.payments.stripePortal()).url); // Stripe-hosted
              } catch {
                setError(t('premium.portalError'));
                setBusy(false);
              }
            }}
          >
            {busy ? t('pay.opening') : t('premium.manage')}
          </button>
          <p className="mt-2 text-xs text-text-tertiary">{t('premium.manageHint')}</p>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">
          {t(premium.source === 'android' ? 'premium.managedAndroid' : 'premium.managedIos')}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Choose({ plans, signedIn }: { plans: StoreProduct[]; signedIn: boolean }) {
  const { t, href } = useI18n();
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key per plan per page view: a double click opens the same Stripe session.
  const keys = useRef(new Map<string, string>());
  if (plans.length === 0) {
    return (
      <p className="rounded-2xl bg-white px-6 py-10 text-center text-text-secondary">{t('premium.unavailable')}</p>
    );
  }
  const subscribe = async (plan: StoreProduct) => {
    if (!signedIn) {
      router.push(`${href('/login')}?next=${encodeURIComponent(href('/premium'))}`);
      return;
    }
    setBusy(plan.id);
    setError(null);
    try {
      if (!keys.current.has(plan.id)) keys.current.set(plan.id, crypto.randomUUID());
      window.location.assign(
        (await api.payments.stripeCheckout({ productId: plan.id }, keys.current.get(plan.id)!)).url,
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setError(
        t(
          code === 'ALREADY_SUBSCRIBED_ON_OTHER_PLATFORM' || code === 'CONFLICT'
            ? 'premium.already'
            : code === 'PAYMENTS_UNAVAILABLE'
              ? 'pay.unavailable'
              : 'pay.couldNotOpen',
        ),
      );
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {plans.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={busy !== null}
            onClick={() => void subscribe(p)}
            className="grid gap-1 rounded-2xl bg-white px-5 py-6 text-left hover:ring-2 hover:ring-primary disabled:opacity-60"
          >
            <span className="text-lg font-bold">{t(planKey(p.plan, 'plan'))}</span>
            <span className="text-2xl font-bold text-primary">
              {usd(p.priceUsdMicros)}
              <span className="text-sm font-normal text-text-tertiary"> / {t(planKey(p.plan, 'per'))}</span>
            </span>
            {p.trialDays ? (
              <span className="text-sm text-text-secondary">
                {t('premium.trial', { n: p.trialDays, period: t(planKey(p.plan, 'per')) })}
              </span>
            ) : null}
            <span className="mt-2 text-sm font-semibold text-primary">
              {busy === p.id ? t('pay.opening') : t(p.trialDays ? 'premium.startTrial' : 'premium.subscribe')}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-text-tertiary">
        {t('premium.terms')}
        {plans.some((p) => p.trialDays) ? ` ${t('premium.trialTerms')}` : ''}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {!signedIn ? <p className="text-sm text-text-tertiary">{t('pay.signInFirst')}</p> : null}
    </div>
  );
}

/** After Stripe: Premium is switched on by the webhook within seconds — poll entitlements briefly. */
export function PremiumDone() {
  const { t, href } = useI18n();
  const entitlements = useEntitlements();
  const [timedOut, setTimedOut] = useState(false);
  const active = entitlements.data?.premium?.active === true;
  const { refetch } = entitlements;
  useEffect(() => {
    if (active || timedOut) return;
    const tick = setInterval(() => void refetch(), 2000);
    const stop = setTimeout(() => setTimedOut(true), 30_000);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [active, timedOut, refetch]);
  return (
    <div className="mx-auto grid max-w-md justify-items-center gap-3 py-12 text-center">
      <p className="text-4xl" aria-hidden>
        ✨
      </p>
      <h1 className="text-2xl font-bold">{t(active ? 'premium.welcome' : 'coins.thanks')}</h1>
      <p className="text-text-secondary">
        {t(active ? 'premium.welcomeText' : timedOut ? 'premium.later' : 'premium.switching')}
      </p>
      <Link href={href('/library')} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white">
        {t('premium.start')}
      </Link>
    </div>
  );
}
