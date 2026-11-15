import { createHash, createPublicKey, verify, X509Certificate, type KeyObject } from 'node:crypto';

/**
 * iOS App Attest verification (Apple: “Validating apps that connect to your server”), on node:crypto only.
 * attestation = once per install: Apple-signed certificate for a Secure Enclave key → we keep its public key.
 * assertion = afterwards: that key's signature over (authenticatorData ‖ SHA256(challenge)), with a growing counter.
 * The app hashes the challenge itself (@expo/app-integrity: clientDataHash = SHA256(UTF-8 challenge)).
 */

/** https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem (SHA-256 1C:B9:82:3B:…:42:C9:32, valid to 2045). */
export const APPLE_APP_ATTEST_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

// 1.2.840.113635.100.8.2 (App Attest nonce extension), DER-encoded OID
const NONCE_OID = Buffer.from('06092a864886f763640802', 'hex');
const AAGUID = { production: Buffer.from('appattest\0\0\0\0\0\0\0'), development: Buffer.from('appattestdevelop') };
export type AttestEnvironment = keyof typeof AAGUID;

export class AttestError extends Error {}
const fail = (message: string): never => {
  throw new AttestError(message);
};

export type AttestedKey = { keyId: string; publicKeyPem: string; counter: number; environment: AttestEnvironment };

export type AttestOptions = {
  /** `<Team ID>.<bundle id>` — the App ID the key must belong to. */
  appId: string;
  /** Test builds (Xcode) attest in `development`; store / TestFlight builds in `production`. */
  allowDevelopment: boolean;
  rootPem?: string;
  now?: Date;
};

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();

/** Attestation (base64 CBOR) for `keyId` made with `challenge` → the key to remember. */
export function verifyAttestation(
  keyId: string,
  challenge: string,
  attestationB64: string,
  opts: AttestOptions,
): AttestedKey {
  const att = decodeCbor(Buffer.from(attestationB64, 'base64')) as {
    fmt?: string;
    attStmt?: { x5c?: Buffer[]; receipt?: Buffer };
    authData?: Buffer;
  };
  if (att?.fmt !== 'apple-appattest') fail('not an App Attest attestation');
  const x5c = att.attStmt?.x5c;
  const authData = att.authData;
  if (!Array.isArray(x5c) || x5c.length < 2 || !Buffer.isBuffer(authData)) fail('malformed attestation');

  // 1. certificate chain: credential cert → intermediate → Apple App Attest root, all valid now
  const now = opts.now ?? new Date();
  const chain = [
    ...x5c!.map((der) => new X509Certificate(der)),
    new X509Certificate(opts.rootPem ?? APPLE_APP_ATTEST_ROOT_CA),
  ];
  for (let i = 0; i < chain.length - 1; i++) {
    const [cert, issuer] = [chain[i]!, chain[i + 1]!];
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey))
      fail('certificate chain does not lead to the Apple root');
  }
  for (const cert of chain) {
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) fail('certificate expired or not yet valid');
  }
  const cred = chain[0]!;

  // 2–4. nonce = SHA256(authData ‖ SHA256(challenge)) must be the one Apple put in the credential certificate
  const nonce = sha256(authData!, sha256(Buffer.from(challenge, 'utf8')));
  if (!nonce.equals(certNonce(cred.raw))) fail('nonce mismatch');

  // 5. key id = SHA256 of the credential public key (uncompressed EC point)
  const point = ecPoint(cred.publicKey);
  if (sha256(point).toString('base64') !== keyId) fail('key id does not match the certificate');

  // 6–9. authenticator data: App ID, counter 0, App Attest environment, credential id = key id
  const auth = parseAuthData(authData!);
  if (!auth.rpIdHash.equals(sha256(Buffer.from(opts.appId)))) fail('attestation is for another app');
  if (auth.counter !== 0) fail('counter must be 0');
  const environment = auth.aaguid?.equals(AAGUID.production)
    ? 'production'
    : auth.aaguid?.equals(AAGUID.development)
      ? 'development'
      : fail('unknown App Attest environment');
  if (environment === 'development' && !opts.allowDevelopment) fail('development attestation not accepted');
  if (!auth.credentialId?.equals(sha256(point))) fail('credential id does not match the key');

  return {
    keyId,
    publicKeyPem: cred.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    counter: 0,
    environment,
  };
}

/** Assertion (base64 CBOR) for `challenge` by a known key → its new counter (must be stored). */
export function verifyAssertion(key: AttestedKey, challenge: string, assertionB64: string, appId: string): number {
  const a = decodeCbor(Buffer.from(assertionB64, 'base64')) as { signature?: Buffer; authenticatorData?: Buffer };
  if (!Buffer.isBuffer(a?.signature) || !Buffer.isBuffer(a?.authenticatorData)) fail('malformed assertion');
  const nonce = sha256(a.authenticatorData!, sha256(Buffer.from(challenge, 'utf8')));
  if (!verify('sha256', nonce, createPublicKey(key.publicKeyPem), a.signature!)) fail('bad assertion signature');
  const auth = parseAuthData(a.authenticatorData!);
  if (!auth.rpIdHash.equals(sha256(Buffer.from(appId)))) fail('assertion is for another app');
  if (auth.counter <= key.counter) fail('assertion counter did not increase (replay?)');
  return auth.counter;
}

function parseAuthData(d: Buffer) {
  if (d.length < 37) fail('authenticator data too short');
  const rpIdHash = d.subarray(0, 32);
  const counter = d.readUInt32BE(33);
  // Attested credential data (attestation only): aaguid(16) ‖ idLength(2) ‖ credentialId
  if (d.length < 55) return { rpIdHash, counter, aaguid: null, credentialId: null };
  const aaguid = d.subarray(37, 53);
  const len = d.readUInt16BE(53);
  return { rpIdHash, counter, aaguid, credentialId: d.subarray(55, 55 + len) };
}

/** 65-byte uncompressed P-256 point of an EC public key. */
function ecPoint(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || !jwk.x || !jwk.y) fail('credential key is not EC');
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
}

/** The 32-byte nonce in extension 1.2.840.113635.100.8.2: OCTET STRING { SEQUENCE { [1] { OCTET STRING nonce } } }. */
function certNonce(der: Buffer): Buffer {
  const at = der.indexOf(NONCE_OID);
  if (at < 0) fail('certificate has no App Attest nonce');
  let r = new Der(der, at + NONCE_OID.length);
  if (der[r.pos] === 0x01) r.read(0x01); // critical flag
  r = new Der(r.read(0x04), 0); // extnValue
  r = new Der(r.read(0x30), 0);
  r = new Der(r.read(0xa1), 0);
  const nonce = r.read(0x04);
  if (nonce.length !== 32) fail('bad nonce length');
  return nonce;
}

class Der {
  constructor(
    private readonly buf: Buffer,
    public pos: number,
  ) {}
  read(tag: number): Buffer {
    if (this.pos + 2 > this.buf.length || this.buf[this.pos] !== tag) fail('unexpected certificate structure');
    let len = this.buf[this.pos + 1]!;
    let start = this.pos + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = this.buf.readUIntBE(start, n);
      start += n;
    }
    this.pos = start + len;
    if (this.pos > this.buf.length) fail('truncated certificate');
    return this.buf.subarray(start, start + len);
  }
}

/** Minimal CBOR decoder for App Attest objects: maps, arrays, text / byte strings, integers. */
export function decodeCbor(buf: Buffer): unknown {
  let pos = 0;
  const length = (info: number): number => {
    if (info < 24) return info;
    const size =
      info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : fail('unsupported CBOR length');
    if (pos + size > buf.length) fail('truncated CBOR');
    const value = size === 8 ? Number(buf.readBigUInt64BE(pos)) : buf.readUIntBE(pos, size);
    pos += size;
    return value;
  };
  const item = (depth: number): unknown => {
    if (depth > 16 || pos >= buf.length) fail('malformed CBOR');
    const byte = buf[pos++]!;
    const major = byte >> 5;
    const n = length(byte & 0x1f);
    // every element takes ≥ 1 byte: a bigger count is a forged object (and would allocate huge arrays)
    if (major >= 2 && major <= 5 && n > buf.length - pos) fail('truncated CBOR');
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2:
      case 3: {
        if (pos + n > buf.length) fail('truncated CBOR');
        const bytes = buf.subarray(pos, (pos += n));
        return major === 2 ? Buffer.from(bytes) : bytes.toString('utf8');
      }
      case 4:
        return Array.from({ length: n }, () => item(depth + 1));
      case 5: {
        const map: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) map[String(item(depth + 1))] = item(depth + 1);
        return map;
      }
      default:
        return fail('unsupported CBOR type');
    }
  };
  return item(0);
}
