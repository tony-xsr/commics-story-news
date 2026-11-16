import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NEW_GUESTS_PER_IP_HOUR as LIMIT } from '../src/modules/auth/auth.service';
import { createStory } from './factories';
import { bearer, bootApp, device, resetData } from './helpers';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
});

// app.inject connects from 127.0.0.1 = a trusted proxy (as cloudflared / Caddy inside the private network).
const guest = (n: number, forwardedFor: string, remoteAddress = '127.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `ip-test-device-${n}` },
    headers: { ...device(`ip-test-device-${n}`), 'x-forwarded-for': forwardedFor },
    remoteAddress,
  });

describe('client IP behind proxies', () => {
  it('regression: a forged X-Forwarded-For entry cannot dodge per-IP limits (new guest accounts per IP)', async () => {
    // Cloudflare APPENDS the real address to whatever the client sent: "forged, real".
    for (let n = 0; n < LIMIT; n++) expect((await guest(n, `198.51.${n >> 8}.${n & 255}, 203.0.113.9`)).statusCode).toBe(200);
    const blocked = await guest(LIMIT, '198.51.100.250, 203.0.113.9');
    expect(blocked.statusCode).toBe(429);
    // A different real client is not affected.
    expect((await guest(LIMIT + 1, '198.51.100.1, 203.0.113.10')).statusCode).toBe(200);
  });

  it('X-Forwarded-For from an untrusted (public) peer is ignored: the peer address counts', async () => {
    for (let n = 0; n < LIMIT; n++) expect((await guest(n, `198.51.100.${n & 255}`, '203.0.113.50')).statusCode).toBe(200);
    expect((await guest(LIMIT, '198.51.100.99', '203.0.113.50')).statusCode).toBe(429);
  });

  it('regression: reopening the app (same device) never uses up the shared IP limit for new guests', async () => {
    for (let n = 0; n < 25; n++) expect((await guest(0, '203.0.113.60')).statusCode).toBe(200);
    for (let n = 1; n <= LIMIT - 1; n++) expect((await guest(n, '203.0.113.60')).statusCode).toBe(200);
    expect((await guest(LIMIT + 5, '203.0.113.60')).statusCode).toBe(429);
  });

  it('regression: many signed-in readers behind ONE IP (mobile carrier NAT) all get their views counted', async () => {
    const story = await createStory(app);
    const view = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/v1/stories/${story.id}/view`, headers: { 'x-forwarded-for': '203.0.113.77', ...headers } });
    for (let n = 0; n < 125; n++) {
      // Accounts created from different addresses (guest sign-in has its own per-IP limit), reading from one.
      const token = (await guest(1000 + n, `198.51.100.${n}`)).json().accessToken as string;
      expect((await view(bearer(token))).statusCode).toBe(204);
    }
    // Without an account the IP still counts: device ids are written by the client, so they can't be the key.
    for (let n = 0; n < 120; n++) await view({ 'x-device-id': `anon-device-${n}` });
    expect((await view({ 'x-device-id': 'anon-device-x' })).statusCode).toBe(429);
  });
});
