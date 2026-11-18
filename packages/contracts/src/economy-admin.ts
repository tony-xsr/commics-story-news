import { z } from 'zod';
import { Reason } from './admin';
import { PremiumPlan } from './payments';

// Admin economy config: store products (coin packs, Premium plans) and versioned pricing settings.

const Points = z.number().int().min(0).max(1_000_000); // hundredths
const Tag = z.object({ label: z.string().trim().min(1).max(12), kind: z.enum(['bonus', 'discount']) });

export const ProductConfigSchema = z
  .object({
    periodPoints: Points.optional(),
    signupPoints: Points.optional(),
    monthlyPoints: Points.optional(),
    taskBonusPercent: z.number().int().min(0).max(500).optional(),
    /** Web (Stripe) free trial days for first-time subscribers; store trials live in the stores. */
    trialDays: z.number().int().min(1).max(90).optional(),
    tag: Tag.optional(),
  })
  .strict();

const Sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._]{2,100}$/, 'Letters, digits, dot, underscore');

export const AdminProduct = z.object({
  id: z.string(),
  kind: z.enum(['coin_pack', 'subscription']),
  title: z.string(),
  coins: z.number().int(),
  bonusCoins: z.number().int(),
  plan: PremiumPlan.nullable(),
  iosSku: z.string().nullable(),
  androidSku: z.string().nullable(),
  androidBasePlan: z.string().nullable(),
  priceUsdMicros: z.number().int(),
  config: ProductConfigSchema,
  sort: z.number().int(),
  active: z.boolean(),
  /** Verified orders so far — a product that has sold can't change its SKUs. */
  orders: z.number().int(),
});
export type AdminProduct = z.infer<typeof AdminProduct>;
export const AdminProductList = z.object({ items: z.array(AdminProduct) });
export type AdminProductList = z.infer<typeof AdminProductList>;

const editable = {
  title: z.string().trim().min(1).max(60),
  coins: z.number().int().min(0).max(1_000_000),
  bonusCoins: z.number().int().min(0).max(1_000_000),
  priceUsdMicros: z.number().int().min(0).max(1_000_000_000),
  config: ProductConfigSchema,
  sort: z.number().int().min(0).max(1000),
  active: z.boolean(),
  iosSku: Sku.nullable(),
  androidSku: Sku.nullable(),
  androidBasePlan: Sku.nullable(),
};

export const ProductCreate = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{3,64}$/, 'a-z, 0-9, _ (3–64)'),
    kind: z.enum(['coin_pack', 'subscription']),
    plan: PremiumPlan.nullable().default(null),
    title: editable.title,
    coins: editable.coins.default(0),
    bonusCoins: editable.bonusCoins.default(0),
    priceUsdMicros: editable.priceUsdMicros,
    config: editable.config.default({}),
    sort: editable.sort.default(0),
    active: editable.active.default(false),
    iosSku: editable.iosSku.default(null),
    androidSku: editable.androidSku.default(null),
    androidBasePlan: editable.androidBasePlan.default(null),
    reason: Reason,
  })
  .strict()
  .refine((p) => (p.kind === 'subscription') === (p.plan !== null), {
    path: ['plan'],
    message: 'Subscriptions need a plan; coin packs must not have one',
  })
  .refine((p) => p.kind === 'subscription' || p.coins > 0, { path: ['coins'], message: 'A coin pack sells coins' });
export type ProductCreate = z.infer<typeof ProductCreate>;

/** SKUs can be filled in once (e.g. after creating them in the store), never changed after a sale. */
export const ProductPatch = z
  .object({ ...editable, reason: Reason })
  .partial()
  .required({ reason: true })
  .strict();
export type ProductPatch = z.infer<typeof ProductPatch>;

// ---- pricing settings (versioned, scheduled) ----

export const EconomySettingsValue = z
  .object({
    /** Bulk unlock discounts. Stored highest `from` first. */
    discounts: z
      .array(z.object({ from: z.number().int().min(2).max(1000), percent: z.number().int().min(1).max(90) }))
      .max(6)
      .transform((d) => [...d].sort((a, b) => b.from - a.from))
      .refine((d) => new Set(d.map((t) => t.from)).size === d.length, 'Each `from` once')
      .refine(
        (d) => d.every((t, i) => i === 0 || t.percent <= d[i - 1]!.percent),
        'Bigger bundles must not get a smaller discount',
      ),
    /** Bundle sizes offered besides "single" and "all". */
    bundleSizes: z
      .array(z.number().int().min(2).max(1000))
      .max(5)
      .transform((s) => [...new Set(s)].sort((a, b) => a - b)),
    /** Purchase bonus coins expire after N days (null = never). */
    purchaseBonusExpiryDays: z.number().int().min(1).max(3650).nullable(),
  })
  .strict();
export type EconomySettingsValue = z.infer<typeof EconomySettingsValue>;

export const EconomySettingsVersion = z.object({
  id: z.uuid(),
  value: EconomySettingsValue,
  effectiveFrom: z.iso.datetime(),
  createdBy: z.string().nullable(),
  reason: z.string(),
  createdAt: z.iso.datetime(),
});
export type EconomySettingsVersion = z.infer<typeof EconomySettingsVersion>;

export const EconomySettingsState = z.object({
  /** null = built-in defaults (nothing configured yet). */
  current: EconomySettingsVersion.nullable(),
  effective: EconomySettingsValue,
  scheduled: z.array(EconomySettingsVersion),
  history: z.array(EconomySettingsVersion),
});
export type EconomySettingsState = z.infer<typeof EconomySettingsState>;

export const EconomySettingsRequest = z
  .object({
    value: EconomySettingsValue,
    /** Omit = right now. Future = scheduled (cancel it before it starts). */
    effectiveFrom: z.iso.datetime().optional(),
    reason: Reason,
  })
  .strict();
export type EconomySettingsRequest = z.infer<typeof EconomySettingsRequest>;

// ---- payment settings (admin → Cấu hình thanh toán) ----

/** Who may buy with a store SANDBOX account (App Review, TestFlight, internal testers). */
export const SandboxMode = z.enum(['off', 'testers', 'all']);
export type SandboxMode = z.infer<typeof SandboxMode>;
/** iOS bundle id / Android application id, e.g. com.storyzio.app */
const AppId = z
  .string()
  .trim()
  .max(155)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/, 'like com.storyzio.app');

export const PaymentTester = z.object({ id: z.uuid(), username: z.string().nullable(), displayName: z.string() });
export type PaymentTester = z.infer<typeof PaymentTester>;

export const PaymentSettings = z.object({
  sandbox: SandboxMode,
  testers: z.array(PaymentTester),
  /** Overrides of the server env (null = use APPLE_BUNDLE_ID / GOOGLE_PACKAGE_NAME). */
  appleBundleId: z.string().nullable(),
  googlePackageName: z.string().nullable(),
  /** What the server actually uses right now. */
  effective: z.object({
    appleBundleId: z.string(),
    googlePackageName: z.string(),
    /** PAYMENTS_ALLOW_SANDBOX in the server env: false = sandbox is off whatever the mode says (production lock). */
    sandboxAllowedByServer: z.boolean(),
  }),
  updatedAt: z.iso.datetime().nullable(),
});
export type PaymentSettings = z.infer<typeof PaymentSettings>;

export const PaymentSettingsInput = z
  .object({
    sandbox: SandboxMode,
    /** User ids, usernames or emails of the testers (resolved by the API; unknown ones are rejected). */
    testers: z.array(z.string().trim().min(1).max(254)).max(200).default([]),
    appleBundleId: AppId.nullable().default(null),
    googlePackageName: AppId.nullable().default(null),
    reason: Reason,
  })
  .strict();
export type PaymentSettingsInput = z.infer<typeof PaymentSettingsInput>;
