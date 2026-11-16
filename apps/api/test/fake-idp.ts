import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import { OidcVerifier, type SocialProvider } from '../src/modules/auth/social-verifier';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_AUDIENCE = 'test-google-client.apps.googleusercontent.com';
export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_AUDIENCE = 'com.storyzio.app';
export const FIREBASE_PROJECT = 'storyzio-test';
export const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT}`;

const SETTINGS: Record<SocialProvider, { issuer: string; audience: string }> = {
  google: { issuer: GOOGLE_ISSUER, audience: GOOGLE_AUDIENCE },
  apple: { issuer: APPLE_ISSUER, audience: APPLE_AUDIENCE },
  phone: { issuer: FIREBASE_ISSUER, audience: FIREBASE_PROJECT },
};

export type SignOptions = { iss?: string; aud?: string; exp?: string | number; key?: CryptoKey; alg?: string };

/**
 * A local stand-in for Google / Apple: its own RSA key + JWKS, so tests exercise the real verification code
 * (signature, issuer, audience, expiry, nonce) without network calls.
 */
export async function createFakeIdp(provider: SocialProvider) {
  const { issuer, audience } = SETTINGS[provider];
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const attacker = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: `${provider}-test`, alg: 'RS256', use: 'sig' };

  const verifier = new OidcVerifier({
    provider,
    issuers: [issuer],
    audiences: [audience],
    keys: createLocalJWKSet({ keys: [jwk] }),
    phone: provider === 'phone',
  });

  const sign = (claims: JWTPayload & { sub: string }, opts: SignOptions = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: `${provider}-test` })
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '10m')
      .sign(opts.key ?? privateKey);

  return { verifier, sign, attackerKey: attacker.privateKey };
}
