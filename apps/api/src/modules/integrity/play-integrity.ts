import { auth } from '@googleapis/androidpublisher';
import type { Env } from '../../config/env';

/** Decoded Play Integrity verdict (standard request) — the fields we judge on. */
export type PlayVerdict = {
  requestHash: string | null;
  requestPackageName: string | null;
  timestampMs: number;
  /** PLAY_RECOGNIZED = the exact build from Play; UNRECOGNIZED_VERSION = modified / sideloaded; UNEVALUATED. */
  appRecognition: string | null;
  /** e.g. MEETS_DEVICE_INTEGRITY (real certified device), MEETS_BASIC_INTEGRITY, MEETS_STRONG_INTEGRITY; empty = emulator / rooted. */
  device: string[];
};

export interface PlayIntegrity {
  /** null when Play Integrity is not configured (no service account). */
  decode(token: string): Promise<PlayVerdict | null>;
}
export const PLAY_INTEGRITY = Symbol('PLAY_INTEGRITY');

const MAX_AGE_MS = 5 * 60_000;

/** Why the verdict is refused, or null when it proves a genuine Play build on a real device asked for `challenge`. */
export function judgePlayVerdict(
  v: PlayVerdict,
  expected: { challenge: string; packageName: string; now: number },
): string | null {
  if (v.requestHash !== expected.challenge) return 'request hash is not our challenge';
  if (v.requestPackageName !== expected.packageName) return 'other package';
  if (Math.abs(expected.now - v.timestampMs) > MAX_AGE_MS) return 'stale verdict';
  if (v.appRecognition !== 'PLAY_RECOGNIZED') return `app not recognized by Play (${v.appRecognition ?? 'none'})`;
  if (!v.device.includes('MEETS_DEVICE_INTEGRITY') && !v.device.includes('MEETS_STRONG_INTEGRITY')) {
    return `device integrity not met (${v.device.join(',') || 'none'})`;
  }
  return null;
}

/** Google's decodeIntegrityToken with the service account of the Play integration (its Cloud project must be linked
 *  in Play Console → App integrity, with the Play Integrity API enabled). */
export class LivePlayIntegrity implements PlayIntegrity {
  private readonly client?: InstanceType<typeof auth.GoogleAuth>;

  constructor(private readonly env: Env) {
    if (!env.integrity.serviceAccountJson) return;
    const credentials = JSON.parse(env.integrity.serviceAccountJson) as Record<string, string>;
    this.client = new auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/playintegrity'] });
  }

  async decode(token: string): Promise<PlayVerdict | null> {
    if (!this.client) return null;
    const pkg = encodeURIComponent(this.env.integrity.googlePackageName);
    const { data } = await this.client.request<{ tokenPayloadExternal?: Record<string, Record<string, unknown>> }>({
      url: `https://playintegrity.googleapis.com/v1/${pkg}:decodeIntegrityToken`,
      method: 'POST',
      data: { integrity_token: token },
      timeout: 5000,
    });
    const p = data.tokenPayloadExternal ?? {};
    return {
      requestHash: (p.requestDetails?.requestHash as string) ?? null,
      requestPackageName: (p.requestDetails?.requestPackageName as string) ?? null,
      timestampMs: Number(p.requestDetails?.timestampMillis ?? 0),
      appRecognition: (p.appIntegrity?.appRecognitionVerdict as string) ?? null,
      device: (p.deviceIntegrity?.deviceRecognitionVerdict as string[]) ?? [],
    };
  }
}
