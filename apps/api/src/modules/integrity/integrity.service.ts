import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AppIntegrityStats,
  IntegrityChallenge,
  IntegrityProofRequest,
  IntegrityResult,
} from '@storyzio/contracts';
import type { AuthContext } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { ENV, type Env } from '../../config/env';
import { CacheService } from '../../infra/cache/cache.service';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { RedisService } from '../../infra/redis/redis.service';
import { ContentProtectionService } from '../content-guard/content-protection.service';
import { AttestError, verifyAssertion, verifyAttestation } from './apple-attest';
import { IntegrityRepo } from './integrity.repo';
import { judgePlayVerdict, PLAY_INTEGRITY, type PlayIntegrity } from './play-integrity';

const CHALLENGE_TTL_SEC = 300;
/** A verified session reads paid chapters without proving again for this long. */
export const PASS_TTL_SEC = 24 * 3600;
const STATS_TTL_SEC = 35 * 86_400;
const APP_PLATFORMS = new Set(['ios', 'android']);

type Stat = 'verified' | 'failed' | 'paidWithPass' | 'paidWithoutPass' | 'blocked';
const challengeKey = (c: string) => `ig:ch:${c}`;
const passKey = (sessionId: string) => `ig:ok:${sessionId}`;
const statsKey = (day: string) => `ig:stat:${day}`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * App integrity (docs/SECURITY.md §1 layer 2): an app session proves it runs the genuine build on a real device
 * (iOS App Attest / Android Play Integrity) and gets a 24 h pass. Paid reads check the pass according to the admin
 * switch (ContentProtection.appIntegrity): off · monitor (count only) · enforce (app sessions without a pass → 403).
 */
@Injectable()
export class IntegrityService {
  private readonly log = new Logger(IntegrityService.name);

  constructor(
    private readonly repo: IntegrityRepo,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    private readonly rateLimit: RateLimitService,
    private readonly protection: ContentProtectionService,
    @Inject(PLAY_INTEGRITY) private readonly play: PlayIntegrity,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async challenge(auth: AuthContext): Promise<IntegrityChallenge> {
    await this.rateLimit.consume('integrity-challenge', auth.userId, 30, 3600);
    const challenge = randomBytes(32).toString('base64url');
    await this.redis.state.set(challengeKey(challenge), auth.sessionId, 'EX', CHALLENGE_TTL_SEC);
    return { challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_SEC * 1000).toISOString() };
  }

  async prove(auth: AuthContext, body: IntegrityProofRequest): Promise<IntegrityResult> {
    // Single use, and only by the session that asked for it
    const owner = await this.redis.state.getdel(challengeKey(body.challenge));
    if (owner !== auth.sessionId) throw new AppError('INTEGRITY_FAILED', 'Challenge expired, ask for a new one');
    try {
      const platform = await this.verify(auth, body);
      await this.redis.state.set(passKey(auth.sessionId), platform, 'EX', PASS_TTL_SEC);
      await this.count('verified');
      return { validUntil: new Date(Date.now() + PASS_TTL_SEC * 1000).toISOString() };
    } catch (err) {
      await this.count('failed');
      if (err instanceof AppError) throw err;
      const reason = err instanceof AttestError ? err.message : 'verification error';
      if (!(err instanceof AttestError)) this.log.error(`integrity check failed: ${String(err)}`);
      this.log.warn(`integrity ${body.kind} refused for user ${auth.userId}: ${reason}`);
      throw new AppError('INTEGRITY_FAILED', 'App integrity could not be verified', { reason });
    }
  }

  private async verify(auth: AuthContext, body: IntegrityProofRequest): Promise<'ios' | 'android'> {
    if (body.kind === 'android') {
      const verdict = await this.play.decode(body.token);
      if (!verdict) throw new AttestError('Play Integrity is not configured on the server');
      const why = judgePlayVerdict(verdict, {
        challenge: body.challenge,
        packageName: this.env.integrity.googlePackageName,
        now: Date.now(),
      });
      if (why) throw new AttestError(why);
      return 'android';
    }

    const appId = this.env.integrity.appleAppId;
    if (!appId) throw new AttestError('App Attest is not configured on the server (APPLE_TEAM_ID)');
    if (body.kind === 'ios-attest') {
      const key = verifyAttestation(body.keyId, body.challenge, body.attestation, {
        appId,
        allowDevelopment: this.env.integrity.allowDevelopment,
      });
      await this.repo.saveKey(key, auth.userId);
      return 'ios';
    }
    const key = await this.repo.key(body.keyId);
    // Unknown key (reinstall, server data reset): the app attests a new key
    if (!key) throw new AppError('INTEGRITY_FAILED', 'Unknown App Attest key', { reattest: true });
    if (key.environment === 'development' && !this.env.integrity.allowDevelopment) {
      throw new AppError('INTEGRITY_FAILED', 'Development key not accepted', { reattest: true });
    }
    const counter = verifyAssertion(key, body.challenge, body.assertion, appId);
    // Conditional on the stored counter: two assertions racing with the same counter → only one wins
    if (!(await this.repo.advanceCounter(key.keyId, key.counter, counter, auth.userId))) {
      throw new AttestError('assertion counter already used');
    }
    return 'ios';
  }

  /**
   * Before a paid chapter is served (after the reader's access is confirmed). Returns `strict` = no pass on a
   * non-app session while enforcing: the caller applies the throttled read limits (web can't attest; a script
   * claiming to be the web still gets only a trickle).
   */
  async checkPaidRead(auth: AuthContext): Promise<{ strict: boolean }> {
    const { appIntegrity: mode } = await this.protection.get();
    if (mode === 'off') return { strict: false };
    const [pass, platform] = await Promise.all([
      this.redis.state.exists(passKey(auth.sessionId)),
      this.sessionPlatform(auth.sessionId),
    ]);
    const app = platform !== null && APP_PLATFORMS.has(platform);
    if (pass) {
      await this.count('paidWithPass');
      return { strict: false };
    }
    if (app) await this.count('paidWithoutPass');
    if (mode !== 'enforce') return { strict: false };
    if (app) {
      await this.count('blocked');
      throw new AppError('INTEGRITY_REQUIRED', 'Verify the app, then retry');
    }
    return { strict: true };
  }

  async stats(days = 14): Promise<AppIntegrityStats> {
    const list = Array.from({ length: days }, (_, i) =>
      new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
    );
    const rows = await Promise.all(list.map((day) => this.redis.state.hgetall(statsKey(day))));
    return {
      days: list.map((day, i) => {
        const r = rows[i] ?? {};
        return {
          day,
          verified: Number(r.verified ?? 0),
          failed: Number(r.failed ?? 0),
          paidWithPass: Number(r.paidWithPass ?? 0),
          paidWithoutPass: Number(r.paidWithoutPass ?? 0),
          blocked: Number(r.blocked ?? 0),
        };
      }),
    };
  }

  /** Platform the session signed in from (sessions.platform), cached: one lookup per session per hour. */
  private sessionPlatform(sessionId: string): Promise<string | null> {
    return this.cache.getOrSet(`c:sess-platform:${sessionId}`, 3600, () => this.repo.sessionPlatform(sessionId));
  }

  private async count(stat: Stat): Promise<void> {
    const key = statsKey(today());
    await this.redis.state.multi().hincrby(key, stat, 1).expire(key, STATS_TTL_SEC).exec();
  }
}
