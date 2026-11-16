import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chapterUnlocks } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { RateLimitService } from '../src/infra/rate-limit/rate-limit.service';
import { ReadGuardService } from '../src/modules/content-guard/read-guard.service';
import { adminClient } from './admin-helpers';
import { createChapters, createStory } from './factories';
import { bearer, bootApp, resetData } from './helpers';

const HONEYPOT = '01900000-0000-7000-8000-00000000beef';
let app: NestFastifyApplication;

beforeAll(async () => {
  Object.assign(process.env, { READ_LIMIT_PER_MINUTE: '5', READ_LIMIT_PER_DAY: '8', HONEYPOT_CHAPTER_IDS: HONEYPOT });
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
  for (const k of ['READ_LIMIT_PER_MINUTE', 'READ_LIMIT_PER_DAY', 'HONEYPOT_CHAPTER_IDS']) delete process.env[k];
});
beforeEach(async () => {
  await resetData(app);
});

let seq = 0;
/** A reader who owns chapter 4 (paid) of a story whose first 3 chapters are free. */
async function setup() {
  const story = await createStory(app, { freeChapters: 3, chapterPrice: 10 });
  const chapters = await createChapters(app, story, 4);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `device-guard-${++seq}-x` },
  });
  const { user, accessToken } = res.json();
  await app
    .get(DbService)
    .write.insert(chapterUnlocks)
    .values({ userId: user.id, chapterId: chapters[3]!.id, storyId: story.id, chapterNumber: 4, method: 'coins' });
  const read = (chapterId: string) =>
    app.inject({ method: 'GET', url: `/v1/chapters/${chapterId}/content`, headers: bearer(accessToken) });
  return { userId: user.id as string, free: chapters[0]!.id, paid: chapters[3]!.id, read };
}

describe('paid-content read guard', () => {
  it('per-minute limit on paid chapters only; free chapters stay unlimited', async () => {
    const r = await setup();
    for (let i = 0; i < 5; i++) expect((await r.read(r.paid)).statusCode).toBe(200);
    const limited = await r.read(r.paid);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    for (let i = 0; i < 10; i++) expect((await r.read(r.free)).statusCode).toBe(200);
  });

  it('daily limit (once-per-day risk) and script-like fast reading raise the risk score → throttled', async () => {
    const { userId } = await setup();
    const guard = app.get(ReadGuardService);
    const rl = app.get(RateLimitService);
    const start = Date.UTC(2026, 10, 3, 1);
    const outcomes: string[] = [];
    // 51 paid reads one second apart: the 9th is over the daily limit, the 51st completes a 50-read fast streak.
    for (let i = 0; i <= 50; i++) {
      await rl.reset('read', userId); // isolate from the per-minute limit
      outcomes.push(
        await guard.checkPaidRead(userId, { now: start + i * 1000 }).then(
          () => 'ok',
          (e: { details?: { reason?: string; retryAfterSec?: number } }) => {
            if (i === 8) expect(e.details?.retryAfterSec).toBe(23 * 3600 - 8); // until UTC midnight
            return e.details?.reason ?? 'error';
          },
        ),
      );
    }
    expect(outcomes.slice(0, 8)).toEqual(Array(8).fill('ok'));
    expect(new Set(outcomes.slice(8))).toEqual(new Set(['daily_limit']));
    expect(await guard.risk(userId)).toMatchObject({ score: 80, level: 'throttled', reason: 'fast_reading' });

    // A slow reader the next day is fine again (streak resets after a 5 s+ pause; new UTC day).
    const other = (await setup()).userId;
    await guard.checkPaidRead(other, { now: start });
    await guard.checkPaidRead(other, { now: start + 60_000 });
    expect((await guard.risk(other)).score).toBe(0);
  });

  it('honeypot → blocked from paid chapters (free still readable); support lifts it with an audited reason', async () => {
    const r = await setup();
    const trap = await r.read(HONEYPOT);
    expect(trap.statusCode).toBe(404); // looks like any missing chapter
    const blocked = await r.read(r.paid);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('READING_RESTRICTED');
    expect((await r.read(r.free)).statusCode).toBe(200);

    const support = await adminClient(app, 'support');
    const detail = (await support.call('GET', `/v1/admin/users/${r.userId}`)).json();
    expect(detail.readRisk).toMatchObject({ score: 100, level: 'blocked', reason: 'honeypot' });

    expect(
      (await support.call('POST', `/v1/admin/users/${r.userId}/read-risk/reset`, { reason: 'x' })).statusCode,
    ).toBe(400);
    const reset = await support.call('POST', `/v1/admin/users/${r.userId}/read-risk/reset`, {
      reason: 'Nhầm lẫn, đã xác minh',
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ score: 0, level: 'normal' });
    expect((await r.read(r.paid)).statusCode).toBe(200);

    const auditor = await adminClient(app, 'super_admin'); // support can't read the audit log
    const audit = (await auditor.call('GET', `/v1/admin/audit-logs?entity=user&entityId=${r.userId}`)).json();
    expect(audit.items[0]).toMatchObject({ action: 'user.read_risk_reset' });

    const finance = await adminClient(app, 'finance'); // no users.moderate
    expect(
      (await finance.call('POST', `/v1/admin/users/${r.userId}/read-risk/reset`, { reason: 'Thử quyền' })).statusCode,
    ).toBe(403);
  });

  it('anonymous honeypot hits are 404 without side effects', async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/chapters/${HONEYPOT}/content` })).statusCode).toBe(404);
  });
});
