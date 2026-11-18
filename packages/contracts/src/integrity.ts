import { z } from 'zod';

// App integrity (046b, docs/SECURITY.md §1 layer 2): the app proves it is the genuine build on a real device —
// iOS App Attest, Android Play Integrity — and the session gets a 24 h pass that paid chapter reads may require.

/** POST /v1/me/integrity/challenge — single-use value (5 min) the app signs / embeds in its integrity request. */
export const IntegrityChallenge = z.object({ challenge: z.string(), expiresAt: z.iso.datetime() });
export type IntegrityChallenge = z.infer<typeof IntegrityChallenge>;

const challenge = z.string().min(20).max(100);
const base64 = z
  .string()
  .min(16)
  .max(20_000)
  .regex(/^[A-Za-z0-9+/=_.-]+$/);

/** POST /v1/me/integrity */
export const IntegrityProofRequest = z.discriminatedUnion('kind', [
  /** iOS, once per install: Apple's attestation of a new Secure Enclave key (`attestKeyAsync(keyId, challenge)`). */
  z.object({ kind: z.literal('ios-attest'), challenge, keyId: base64.max(100), attestation: base64 }).strict(),
  /** iOS afterwards: an assertion signed by that attested key (`generateAssertionAsync(keyId, challenge)`). */
  z.object({ kind: z.literal('ios-assert'), challenge, keyId: base64.max(100), assertion: base64 }).strict(),
  /** Android: Play Integrity token whose requestHash is the challenge (`requestIntegrityCheckAsync(challenge)`). */
  z.object({ kind: z.literal('android'), challenge, token: base64 }).strict(),
]);
export type IntegrityProofRequest = z.infer<typeof IntegrityProofRequest>;

export const IntegrityResult = z.object({ validUntil: z.iso.datetime() });
export type IntegrityResult = z.infer<typeof IntegrityResult>;

/** Admin switch: off · monitor (count paid reads without a pass, block nothing) · enforce (app sessions need a pass). */
export const AppIntegrityMode = z.enum(['off', 'monitor', 'enforce']);
export type AppIntegrityMode = z.infer<typeof AppIntegrityMode>;

/** GET /v1/admin/app-integrity/stats — last days, to see what enforcing would block before switching it on. */
export const AppIntegrityStats = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      verified: z.number().int(),
      failed: z.number().int(),
      paidWithPass: z.number().int(),
      paidWithoutPass: z.number().int(),
      blocked: z.number().int(),
    }),
  ),
});
export type AppIntegrityStats = z.infer<typeof AppIntegrityStats>;
