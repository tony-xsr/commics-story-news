import { z } from 'zod';
import { Reason } from './admin';
import { Cursor, limit, page } from './common';

// Gift codes: users redeem a code for coins / points (prototype GiftCodeModal); admins create them singly or in batches.

/** Codes are stored upper-case without spaces; users may type them any way. */
export const RedeemGiftCodeRequest = z
  .object({ code: z.string().trim().min(4).max(40) })
  .strict();
export type RedeemGiftCodeRequest = z.infer<typeof RedeemGiftCodeRequest>;

export const GiftCodeResult = z.object({
  /** Whole coins / whole points received. */
  coins: z.number().int(),
  points: z.number().int(),
  balance: z.object({ coins: z.number().int(), points: z.number().int() }),
});
export type GiftCodeResult = z.infer<typeof GiftCodeResult>;

// ---- admin ----

const CodeText = z.string().regex(/^[A-Z0-9-]{4,32}$/, 'A–Z, 0–9 and "-", 4–32 characters');

export const GiftCodeReward = z
  .object({
    coins: z.number().int().min(0).max(100_000).default(0),
    points: z.number().int().min(0).max(100_000).default(0),
    /** Gifted coins expire after N days (null = never). */
    coinExpiryDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .strict()
  .refine((r) => r.coins + r.points > 0, { message: 'A code must give coins or points' });
export type GiftCodeReward = z.infer<typeof GiftCodeReward>;

export const CreateGiftCodesRequest = z
  .object({
    /** One named code (e.g. "TET2027")… */
    code: CodeText.optional(),
    /** …or a batch of random codes, each usable once by default. */
    count: z.number().int().min(1).max(1000).optional(),
    prefix: z
      .string()
      .regex(/^[A-Z0-9]{1,8}$/)
      .optional(),
    reward: GiftCodeReward,
    /** Total redemptions across all users (null = unlimited). Each user redeems a code once. */
    maxUses: z.number().int().min(1).max(10_000_000).nullable(),
    startsAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime().optional(),
    note: z.string().trim().max(200).optional(),
    reason: Reason,
  })
  .strict()
  .refine((r) => !!r.code !== !!r.count, { message: 'Give either `code` or `count`' })
  .refine((r) => !r.startsAt || !r.expiresAt || r.startsAt < r.expiresAt, { message: 'startsAt must be before expiresAt' });
export type CreateGiftCodesRequest = z.infer<typeof CreateGiftCodesRequest>;

export const GiftCodeStatus = z.enum(['active', 'disabled']);

export const AdminGiftCode = z.object({
  id: z.uuid(),
  code: z.string(),
  batchId: z.uuid().nullable(),
  reward: z.object({ coins: z.number().int(), points: z.number().int(), coinExpiryDays: z.number().int().nullable() }),
  maxUses: z.number().int().nullable(),
  usedCount: z.number().int(),
  status: GiftCodeStatus,
  startsAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminGiftCode = z.infer<typeof AdminGiftCode>;
export const AdminGiftCodePage = page(AdminGiftCode);
export type AdminGiftCodePage = z.infer<typeof AdminGiftCodePage>;
export const CreateGiftCodesResult = z.object({ batchId: z.uuid().nullable(), items: z.array(AdminGiftCode) });
export type CreateGiftCodesResult = z.infer<typeof CreateGiftCodesResult>;

export const AdminGiftCodeQuery = z
  .object({
    q: z.string().trim().max(40).optional(),
    batchId: z.uuid().optional(),
    cursor: Cursor.optional(),
    limit: limit(200, 50),
  })
  .strict();
export type AdminGiftCodeQuery = z.infer<typeof AdminGiftCodeQuery>;

export const UpdateGiftCodeRequest = z.object({ status: GiftCodeStatus, reason: Reason }).strict();
export type UpdateGiftCodeRequest = z.infer<typeof UpdateGiftCodeRequest>;
