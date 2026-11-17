'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { T } from '@/i18n';
import { useI18n } from '@/i18n/client';
import { authCall, safeNext } from '@/lib/session';
import { SocialSignIn } from './social-sign-in';
import { captchaOf, resetCaptcha, Turnstile } from './turnstile';

const input = 'w-full rounded-xl border border-container bg-white px-4 py-2.5 outline-none focus:border-primary';
const button = 'rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-dark disabled:opacity-50';

/** User-facing text for an auth error (switch on the API's stable code). */
function message(t: T, err: unknown): string {
  switch ((err as { code?: string }).code) {
    case 'INVALID_CREDENTIALS':
      return t('auth.err.credentials');
    case 'EMAIL_NOT_VERIFIED':
      return t('auth.err.notVerified');
    case 'USERNAME_TAKEN':
      return t('auth.err.usernameTaken');
    case 'INVALID_OTP':
      return t('auth.err.otp');
    case 'RATE_LIMITED':
      return t('err.rateLimited');
    case 'ACCOUNT_DISABLED':
      return t('auth.err.disabled');
    case 'VALIDATION':
      return t('auth.err.validation');
    case 'CAPTCHA_FAILED':
      return t('auth.err.captcha');
    default:
      return t('common.error');
  }
}

/** After sign-in: a full navigation so every page (server + client) renders signed in. */
const done = (next: string | null, home: string) => window.location.assign(next ? safeNext(next) : home);

/** Shared busy / error handling for the multi-step forms. */
function useRunner(t: T) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(t, err));
      resetCaptcha();
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

const Error = ({ text }: { text: string | null }) =>
  text ? (
    <p role="alert" className="text-sm text-red-600">
      {text}
    </p>
  ) : null;

export function LoginForm() {
  const { t, href, lang } = useI18n();
  const next = useSearchParams().get('next');
  const { error, busy, run } = useRunner(t);
  const keepNext = next ? `?next=${encodeURIComponent(next)}` : '';
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        void run(async () => {
          await authCall('login', {
            login: String(form.get('login')).trim(),
            password: String(form.get('password')),
            ...captchaOf(form),
          });
          done(next, href('/'));
        });
      }}
    >
      <SocialSignIn next={next} />
      <input name="login" aria-label={t('auth.login')} placeholder={t('auth.login')} autoComplete="username" required className={input} />
      <input name="password" aria-label={t('auth.password')} type="password" placeholder={t('auth.password')} autoComplete="current-password" required className={input} />
      <Link href={href('/forgot-password')} className="justify-self-start text-sm text-text-tertiary hover:text-primary">
        {t('auth.forgot')}
      </Link>
      <Turnstile lang={lang} />
      <Error text={error} />
      <button type="submit" disabled={busy} className={button}>
        {t('nav.signIn')}
      </button>
      <p className="text-center text-sm text-text-tertiary">
        {t('auth.newHere')}{' '}
        <Link href={`${href('/register')}${keepNext}`} className="text-primary">
          {t('auth.createAccount')}
        </Link>
      </p>
    </form>
  );
}

export function RegisterForm() {
  const { t, href, lang } = useI18n();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState<string | null>(null);
  const { error, busy, run } = useRunner(t);
  const keepNext = next ? `?next=${encodeURIComponent(next)}` : '';

  if (email) {
    return (
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get('code')).trim();
          void run(async () => {
            await authCall('verify', { email, code });
            done(next, href('/'));
          });
        }}
      >
        <p className="text-sm text-text-secondary">{t('auth.codeSent', { email })}</p>
        <input name="code" aria-label={t('auth.code')} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required pattern="\d{6}" className={input} />
        <Error text={error} />
        <button type="submit" disabled={busy} className={button}>
          {t('auth.verify')}
        </button>
        <button type="button" disabled={busy} className="text-sm text-primary" onClick={() => void run(() => authCall('resend', { email, locale: lang }))}>
          {t('auth.resend')}
        </button>
      </form>
    );
  }

  return (
    <form
      className="grid gap-3"
      lang={lang}
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const value = String(form.get('email')).trim().toLowerCase();
        void run(async () => {
          await authCall('register', {
            email: value,
            username: String(form.get('username')).trim(),
            password: String(form.get('password')),
            locale: lang,
            ...captchaOf(form),
          });
          setEmail(value);
        });
      }}
    >
      <SocialSignIn next={next} />
      <input name="email" type="email" aria-label={t('auth.email')} placeholder={t('auth.email')} autoComplete="email" required className={input} />
      <input name="username" aria-label={t('auth.username')} placeholder={t('auth.username')} autoComplete="username" required minLength={3} maxLength={30} className={input} />
      <input name="password" type="password" aria-label={t('auth.password')} placeholder={t('auth.newPassword')} autoComplete="new-password" required minLength={8} className={input} />
      <Turnstile lang={lang} />
      <Error text={error} />
      <button type="submit" disabled={busy} className={button}>
        {t('auth.createAccount')}
      </button>
      <p className="text-center text-sm text-text-tertiary">
        {t('auth.haveAccount')}{' '}
        <Link href={`${href('/login')}${keepNext}`} className="text-primary">
          {t('nav.signIn')}
        </Link>
      </p>
    </form>
  );
}

/** Email → 6-digit code + new password → signed in with the new password (every other session was signed out). */
export function ForgotPasswordForm() {
  const { t, href, lang } = useI18n();
  const [email, setEmail] = useState<string | null>(null);
  const { error, busy, run } = useRunner(t);

  if (!email) {
    return (
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const value = String(form.get('email')).trim().toLowerCase();
          void run(async () => {
            await authCall('forgot', { email: value, locale: lang, ...captchaOf(form) });
            setEmail(value);
          });
        }}
      >
        <input name="email" type="email" aria-label={t('auth.email')} placeholder={t('auth.accountEmail')} autoComplete="email" required className={input} />
        <Turnstile lang={lang} />
        <Error text={error} />
        <button type="submit" disabled={busy} className={button}>
          {t('auth.sendCode')}
        </button>
      </form>
    );
  }
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const newPassword = String(form.get('password'));
        void run(async () => {
          await authCall('reset', { email, code: String(form.get('code')).trim(), newPassword });
          await authCall('login', { login: email, password: newPassword });
          done(null, href('/'));
        });
      }}
    >
      <p className="text-sm text-text-secondary">{t('auth.resetSent', { email })}</p>
      <input name="code" aria-label={t('auth.code')} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required pattern="\d{6}" className={input} />
      <input name="password" type="password" aria-label={t('auth.newPasswordLabel')} placeholder={t('auth.newPasswordLabel')} autoComplete="new-password" required minLength={8} className={input} />
      <Error text={error} />
      <button type="submit" disabled={busy} className={button}>
        {t('auth.setPassword')}
      </button>
      <button type="button" disabled={busy} className="text-sm text-primary" onClick={() => void run(() => authCall('forgot', { email, locale: lang }))}>
        {t('auth.resend')}
      </button>
    </form>
  );
}
