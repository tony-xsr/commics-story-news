'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { authCall, safeNext } from '@/lib/session';

/** Web client id (must also be in the API's GOOGLE_CLIENT_IDS). Empty → no Google button. */
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
/** Apple Services ID (in the API's APPLE_CLIENT_IDS) + its registered return URL. Empty → no Apple button. */
const APPLE_SERVICE_ID = process.env.NEXT_PUBLIC_APPLE_SERVICE_ID ?? '';
const APPLE_REDIRECT_URI = process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? '';

type GoogleId = {
  accounts: {
    id: {
      initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode: 'popup' }): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
    };
  };
};
type AppleId = {
  auth: {
    init(o: { clientId: string; scope: string; redirectURI: string; usePopup: boolean; nonce: string }): void;
    signIn(): Promise<{ authorization: { id_token: string }; user?: { name?: { firstName?: string; lastName?: string } } }>;
  };
};
declare global {
  interface Window {
    google?: GoogleId;
    AppleID?: AppleId;
  }
}

export const socialSignInEnabled = Boolean(GOOGLE_CLIENT_ID || (APPLE_SERVICE_ID && APPLE_REDIRECT_URI));

/** Google + Apple on the web. Tokens go to the BFF (httpOnly cookies), never kept in the page. */
export function SocialSignIn({ next }: { next: string | null }) {
  const { t, href } = useI18n();
  const [error, setError] = useState<string | null>(null);
  if (!socialSignInEnabled) return null;
  const done = () => window.location.assign(next ? safeNext(next) : href('/'));
  const fail = (err: unknown) =>
    setError(t((err as { code?: string }).code === 'SOCIAL_TOKEN_INVALID' ? 'auth.err.social' : 'common.error'));

  return (
    <div className="grid gap-2">
      {GOOGLE_CLIENT_ID ? <GoogleButton onToken={(idToken) => authCall('google', { idToken }).then(done, fail)} /> : null}
      {APPLE_SERVICE_ID && APPLE_REDIRECT_URI ? <AppleButton onDone={done} onError={fail} /> : null}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <div className="flex items-center gap-2 text-xs text-text-tertiary">
        <span className="h-px flex-1 bg-container" /> {t('common.or')} <span className="h-px flex-1 bg-container" />
      </div>
    </div>
  );
}

function GoogleButton({ onToken }: { onToken: (idToken: string) => void }) {
  const { lang } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!loaded || !window.google || !box.current) return;
    window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (r) => onToken(r.credential), ux_mode: 'popup' });
    window.google.accounts.id.renderButton(box.current, { theme: 'outline', size: 'large', shape: 'pill', width: 320, text: 'continue_with', locale: lang });
  }, [loaded, onToken, lang]);
  return (
    <>
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setLoaded(true)} />
      <div ref={box} className="flex justify-center" />
    </>
  );
}

function AppleButton({ onDone, onError }: { onDone: () => void; onError: (err: unknown) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js" strategy="afterInteractive" />
      <button
        type="button"
        disabled={busy}
        className="rounded-full bg-black px-6 py-2.5 font-semibold text-white disabled:opacity-50"
        onClick={async () => {
          if (!window.AppleID) return onError(new Error('Apple script not loaded'));
          setBusy(true);
          try {
            const { nonce } = await authCall<{ nonce: string }>('nonce');
            window.AppleID.auth.init({ clientId: APPLE_SERVICE_ID, scope: 'name email', redirectURI: APPLE_REDIRECT_URI, usePopup: true, nonce });
            const res = await window.AppleID.auth.signIn();
            const name = res.user?.name;
            await authCall('apple', {
              identityToken: res.authorization.id_token,
              nonce,
              // Apple sends the name on the first authorization only.
              fullName: name?.firstName || name?.lastName ? { givenName: name.firstName, familyName: name.lastName } : undefined,
            });
            onDone();
          } catch (err) {
            // Closing Apple's popup is not an error worth showing.
            if ((err as { error?: string }).error !== 'popup_closed_by_user') onError(err);
            setBusy(false);
          }
        }}
      >
         {t('auth.continueApple')}
      </button>
    </>
  );
}
