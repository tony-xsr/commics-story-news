import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootApp, device, resetData } from './helpers';

let app: NestFastifyApplication;
const verified: URLSearchParams[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'turnstile-test-secret');
  // Cloudflare siteverify: token "good" passes, anything else fails. Other requests go out unchanged.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).startsWith('https://challenges.cloudflare.com/')) {
      const form = new URLSearchParams(String(init?.body));
      verified.push(form);
      return new Response(JSON.stringify({ success: form.get('response') === 'good' }), { status: 200 });
    }
    return realFetch(input, init);
  });
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await resetData(app);
  verified.length = 0;
});

const post = (url: string, payload: object, platform: 'web' | 'ios') =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { ...device('captcha-device-01', platform), 'x-forwarded-for': '198.51.100.7' },
  });
const account = { email: 'cap@example.com', username: 'cap.user', password: 'correct-horse-1' };

describe('Turnstile on web forms (TURNSTILE_SECRET_KEY set)', () => {
  it('web sign-up / sign-in / forgot-password need a valid token', async () => {
    expect((await post('/v1/auth/register', account, 'web')).json().error.code).toBe('CAPTCHA_FAILED');
    expect((await post('/v1/auth/register', { ...account, captchaToken: 'bad' }, 'web')).statusCode).toBe(403);
    expect((await post('/v1/auth/register', { ...account, captchaToken: 'good' }, 'web')).statusCode).toBe(202);
    // Secret and the caller's IP go to Cloudflare.
    expect(verified.at(-1)?.get('secret')).toBe('turnstile-test-secret');
    expect(verified.at(-1)?.get('remoteip')).toBe('198.51.100.7');

    const login = { login: account.email, password: account.password };
    expect((await post('/v1/auth/login', login, 'web')).statusCode).toBe(403);
    // Valid token → normal flow (here: email not verified yet).
    expect((await post('/v1/auth/login', { ...login, captchaToken: 'good' }, 'web')).json().error.code).not.toBe(
      'CAPTCHA_FAILED',
    );
    expect((await post('/v1/auth/password/forgot', { email: account.email }, 'web')).statusCode).toBe(403);
    expect(
      (await post('/v1/auth/password/forgot', { email: account.email, captchaToken: 'good' }, 'web')).statusCode,
    ).toBe(202);
  });

  it('the apps are not asked for a token', async () => {
    expect((await post('/v1/auth/register', account, 'ios')).statusCode).toBe(202);
    expect(verified).toHaveLength(0);
  });
});
