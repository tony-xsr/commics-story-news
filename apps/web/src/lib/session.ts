'use client';

import { useSyncExternalStore } from 'react';

/** “Signed in?” from the readable `sz_in` cookie (the tokens themselves are httpOnly). Server render: false. */
export function useSignedIn(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => /(?:^|;\s*)sz_in=1/.test(document.cookie),
    () => false,
  );
}

/** POST to the BFF auth routes; resolves with the JSON body or throws `{ code, message }`. */
export async function authCall<T>(
  action: 'login' | 'register' | 'verify' | 'resend' | 'forgot' | 'reset' | 'google' | 'apple' | 'nonce' | 'logout',
  body?: object,
): Promise<T> {
  const res = await fetch(`/api/auth/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw json.error ?? { code: 'INTERNAL', message: 'Something went wrong' };
  return json as T;
}

/** Only same-site paths after sign-in (no open redirect). */
export const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
