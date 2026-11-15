import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { appAttestKeys, sessions } from '../../db/schema';
import { DbService } from '../../infra/db/db.service';
import type { AttestedKey, AttestEnvironment } from './apple-attest';

/** Drizzle queries for app integrity. No business rules here. */
@Injectable()
export class IntegrityRepo {
  constructor(private readonly db: DbService) {}

  async saveKey(key: AttestedKey, userId: string): Promise<void> {
    // A key id is the hash of a fresh Secure Enclave key: an existing row means the same key attested again → keep its counter
    await this.db.write
      .insert(appAttestKeys)
      .values({
        keyId: key.keyId,
        publicKeyPem: key.publicKeyPem,
        counter: key.counter,
        environment: key.environment,
        userId,
      })
      .onConflictDoUpdate({ target: appAttestKeys.keyId, set: { userId, lastUsedAt: new Date() } });
  }

  async key(keyId: string): Promise<AttestedKey | null> {
    // Primary: the key may have been attested a moment ago
    const [row] = await this.db.write.select().from(appAttestKeys).where(eq(appAttestKeys.keyId, keyId));
    return row
      ? {
          keyId: row.keyId,
          publicKeyPem: row.publicKeyPem,
          counter: row.counter,
          environment: row.environment as AttestEnvironment,
        }
      : null;
  }

  /** Moves the counter forward only if nobody else did since it was read. */
  async advanceCounter(keyId: string, from: number, to: number, userId: string): Promise<boolean> {
    const rows = await this.db.write
      .update(appAttestKeys)
      .set({ counter: to, userId, lastUsedAt: new Date() })
      .where(and(eq(appAttestKeys.keyId, keyId), eq(appAttestKeys.counter, from)))
      .returning({ keyId: appAttestKeys.keyId });
    return rows.length === 1;
  }

  async sessionPlatform(sessionId: string): Promise<string | null> {
    const [row] = await this.db.read
      .select({ platform: sessions.platform })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row?.platform ?? null;
  }
}
