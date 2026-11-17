'use client';

import Script from 'next/script';
import { useEffect, useRef } from 'react';

/** Cloudflare Turnstile site key (build time). Empty = no challenge (the API only asks when it has the secret). */
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; language?: string }) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};
const api = () => (window as { turnstile?: TurnstileApi }).turnstile;

/**
 * Bot check on the sign-up / sign-in / forgot-password forms. The widget puts its token in a hidden
 * `cf-turnstile-response` field of the surrounding form → read it with `captchaOf(form)`.
 */
export function Turnstile({ lang }: { lang: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!SITE_KEY) return;
    let id: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The script loads async: render once it is there (also after client-side navigation).
    const mount = () => {
      const ts = api();
      if (!ts || !ref.current) {
        timer = setTimeout(mount, 200);
        return;
      }
      id = ts.render(ref.current, { sitekey: SITE_KEY, language: lang });
    };
    mount();
    return () => {
      clearTimeout(timer);
      if (id) api()?.remove(id);
    };
  }, [lang]);
  if (!SITE_KEY) return null;
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" />
      <div ref={ref} className="min-h-[65px]" />
    </>
  );
}

/** `{ captchaToken }` for the API body when the widget produced one. */
export function captchaOf(form: FormData): { captchaToken?: string } {
  const token = form.get('cf-turnstile-response');
  return typeof token === 'string' && token ? { captchaToken: token } : {};
}

/** Tokens are single-use: get a fresh one after a failed submit. */
export const resetCaptcha = () => api()?.reset();
