import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chapterUnlocks } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { PLAY_INTEGRITY, type PlayIntegrity, type PlayVerdict } from '../src/modules/integrity/play-integrity';
import { adminClient } from './admin-helpers';
import { createChapters, createStory } from './factories';
import { bearer, bootApp, resetData } from './helpers';

// Play Integrity is faked: the "token" is the JSON verdict Google would return. iOS App Attest crypto is covered by
// src/modules/integrity/apple-attest.spec.ts (real certificate chains); here: the session pass and the switch.
const play: PlayIntegrity = {
  decode: async (token) => JSON.parse(Buffer.from(token, 'base64url').toString()) as PlayVerdict,
};
const verdict = (challenge: string, over: Partial<PlayVerdict> = {}) =>
  Buffer.from(
    JSON.stringify({
      requestHash: challenge,
      requestPackageName: 'com.storyzio.app',
      timestampMs: Date.now(),
      appRecognition: 'PLAY_RECOGNIZED',
      device: ['MEETS_DEVICE_INTEGRITY'],
      ...over,
    }),
  ).toString('base64url');

let app: NestFastifyApplication;
beforeAll(async () => {
  app = await bootApp({ overrides: [[PLAY_INTEGRITY, play]] });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
  await app.get(RedisService).cache.flushdb();
});

/** A reader signed in from `platform` who owns paid chapter 2. */
async function reader(platform: 'android' | 'ios' | 'web', deviceId = `dev-${platform}-${Math.random().toString(36).slice(2)}`) {
  const story = await createStory(app, { type: 'novel', freeChapters: 1, chapterPrice: 10 });
  const chapters = await createChapters(app, story, 2);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    headers: { 'x-platform': platform },
    payload: { deviceId },
  });
  const { user, accessToken } = res.json();
  if (!user) throw new Error(`guest: ${res.statusCode} ${res.body}`);
  await app
    .get(DbService)
    .write.insert(chapterUnlocks)
    .values({ userId: user.id, chapterId: chapters[1]!.id, storyId: story.id, chapterNumber: 2, method: 'coins' });
  const h = { ...bearer(accessToken), 'x-platform': platform };
  return {
    readPaid: () => app.inject({ method: 'GET', url: `/v1/chapters/${chapters[1]!.id}/content`, headers: h }),
    readFree: () => app.inject({ method: 'GET', url: `/v1/chapters/${chapters[0]!.id}/content`, headers: h }),
    challenge: async () =>
      (await app.inject({ method: 'POST', url: '/v1/me/integrity/challenge', headers: h })).json().challenge as string,
    prove: (payload: object) => app.inject({ method: 'POST', url: '/v1/me/integrity', headers: h, payload }),
  };
}

async function setMode(appIntegrity: 'off' | 'monitor' | 'enforce') {
  const sa = await adminClient(app, 'super_admin');
  const res = await sa.call('PUT', '/v1/admin/content-protection', {
    comicSignedUrls: false,
    comicWatermark: false,
    appIntegrity,
    reason: `App integrity ${appIntegrity}`,
  });
  expect(res.statusCode).toBe(200);
  return sa;
}

describe('app integrity', () => {
  it('Play Integrity proof → 24 h pass; challenges are single-use and bound to the session', async () => {
    const r = await reader('android');
    const c = await r.challenge();
    const ok = await r.prove({ kind: 'android', challenge: c, token: verdict(c) });
    expect(ok.statusCode).toBe(200);
    expect(Date.parse(ok.json().validUntil) - Date.now()).toBeGreaterThan(23 * 3600_000);
    // replayed challenge
    expect((await r.prove({ kind: 'android', challenge: c, token: verdict(c) })).json().error.code).toBe(
      'INTEGRITY_FAILED',
    );
    // another session cannot use my challenge
    const other = await reader('android');
    const mine = await r.challenge();
    expect((await other.prove({ kind: 'android', challenge: mine, token: verdict(mine) })).statusCode).toBe(403);
  });

  it('refuses modified apps, emulators / rooted devices, foreign challenges', async () => {
    const r = await reader('android');
    for (const bad of [
      { appRecognition: 'UNRECOGNIZED_VERSION' },
      { device: [] },
      { device: ['MEETS_BASIC_INTEGRITY'] },
      { requestPackageName: 'com.evil.clone' },
      { timestampMs: Date.now() - 3_600_000 },
    ]) {
      const c = await r.challenge();
      const res = await r.prove({ kind: 'android', challenge: c, token: verdict(c, bad) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INTEGRITY_FAILED');
    }
    const c = await r.challenge();
    expect(
      (await r.prove({ kind: 'android', challenge: c, token: verdict('another-challenge-value') })).statusCode,
    ).toBe(403);
  });

  it('iOS: App Attest needs APPLE_TEAM_ID; an unknown key asks the app to attest again', async () => {
    const r = await reader('ios');
    const c = await r.challenge();
    const res = await r.prove({ kind: 'ios-assert', challenge: c, keyId: 'a'.repeat(44), assertion: 'b'.repeat(40) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INTEGRITY_FAILED');
  });

  it('off (default): nothing checked · monitor: counted, not blocked · enforce: app sessions need the pass', async () => {
    const r = await reader('android');
    expect((await r.readPaid()).statusCode).toBe(200);

    const sa = await setMode('monitor');
    expect((await r.readPaid()).statusCode).toBe(200);

    await setMode('enforce');
    const blocked = await r.readPaid();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('INTEGRITY_REQUIRED');
    expect((await r.readFree()).statusCode).toBe(200); // free chapters never need it

    const c = await r.challenge();
    await r.prove({ kind: 'android', challenge: c, token: verdict(c) });
    expect((await r.readPaid()).statusCode).toBe(200);

    const today = (await sa.call('GET', '/v1/admin/app-integrity/stats')).json().days[0];
    expect(today).toMatchObject({ verified: 1, paidWithoutPass: 2, blocked: 1, paidWithPass: 1 });
  });

  it('enforce: web sessions (cannot attest) still read, under the throttled per-minute limit', async () => {
    await setMode('enforce');
    const web = await reader('web');
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await web.readPaid()).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.at(-1)).toBe(429);
  });
});
