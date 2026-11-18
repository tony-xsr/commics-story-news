import { z } from 'zod';
import { Platform } from './auth';

export const PremiumPlan = z.enum(['weekly', 'monthly', 'yearly']);
export type PremiumPlan = z.infer<typeof PremiumPlan>;

export const SubscriptionStatus = z.enum([
  'trial',
  'active',
  'grace_period',
  'billing_retry',
  'on_hold',
  'paused',
  'canceled',
  'expired',
  'revoked',
  'replaced',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

// ---- catalog (public, per platform) ----

export const StoreProduct = z.object({
  id: z.string(),
  kind: z.enum(['coin_pack', 'subscription']),
  title: z.string(),
  /** The store SKU to pass to StoreKit / Play Billing. Show the store's localized price, never a hardcoded one. */
  sku: z.string(),
  /** Google subscriptions: base plan id inside the `premium` subscription. */
  basePlanId: z.string().nullable(),
  coins: z.number().int(),
  bonusCoins: z.number().int(),
  plan: PremiumPlan.nullable(),
  /** Reference USD price (micros) — fallback display only. */
  priceUsdMicros: z.number().int(),
  tag: z.object({ label: z.string(), kind: z.enum(['bonus', 'discount']) }).nullable(),
  /** Web Premium: free days before the first charge (first-time subscribers only); null elsewhere / none. */
  trialDays: z.number().int().nullable(),
});
export type StoreProduct = z.infer<typeof StoreProduct>;

export const CatalogQuery = z.object({ platform: Platform }).strict();
export const StoreCatalog = z.object({ coinPacks: z.array(StoreProduct), plans: z.array(StoreProduct) });
export type StoreCatalog = z.infer<typeof StoreCatalog>;

// ---- purchase flow ----

export const CreateIntentRequest = z.object({ productId: z.string().min(1).max(64), platform: Platform }).strict();
export type CreateIntentRequest = z.infer<typeof CreateIntentRequest>;

/** Web top-up: a Stripe Checkout page for one coin pack; coins arrive by webhook after payment. */
export const StripeCheckoutRequest = z.object({ productId: z.string().min(1).max(64) }).strict();
export type StripeCheckoutRequest = z.infer<typeof StripeCheckoutRequest>;
export const StripeCheckoutSession = z.object({ sessionId: z.string(), url: z.url() });
export type StripeCheckoutSession = z.infer<typeof StripeCheckoutSession>;

export const PaymentIntent = z.object({
  intentId: z.uuid(),
  /** iOS: pass as `appAccountToken` to StoreKit. */
  appAccountToken: z.uuid(),
  /** Android: pass as `obfuscatedAccountId` (and `intentId` as `obfuscatedProfileId`) to Play Billing. */
  obfuscatedAccountId: z.string(),
  sku: z.string(),
  expiresAt: z.iso.datetime(),
  /**
   * Android, switching Premium plan: pass to Play Billing as the replaced purchase (otherwise both plans bill).
   * `immediate` = longer plan, starts now (time left is carried over) · `deferred` = shorter plan, from the next renewal.
   * Apple does this itself inside the subscription group → always null on iOS.
   */
  replace: z.object({ purchaseToken: z.string(), mode: z.enum(['immediate', 'deferred']) }).nullable(),
});
export type PaymentIntent = z.infer<typeof PaymentIntent>;

/** StoreKit 2 `Transaction.jwsRepresentation`. */
export const IosVerifyRequest = z.object({ signedTransaction: z.string().min(50).max(20_000) }).strict();
export type IosVerifyRequest = z.infer<typeof IosVerifyRequest>;

export const AndroidVerifyRequest = z
  .object({
    productId: z.string().min(1).max(200),
    purchaseToken: z.string().min(10).max(4096),
    subscription: z.boolean(),
  })
  .strict();
export type AndroidVerifyRequest = z.infer<typeof AndroidVerifyRequest>;

export const Entitlements = z.object({
  premium: z
    .object({
      active: z.boolean(),
      plan: PremiumPlan.nullable(),
      status: SubscriptionStatus.nullable(),
      source: z.string(),
      expiresAt: z.iso.datetime(),
      willRenew: z.boolean(),
    })
    .nullable(),
});
export type Entitlements = z.infer<typeof Entitlements>;

export const PurchaseResult = z.object({
  kind: z.enum(['coin_pack', 'subscription']),
  productId: z.string(),
  /** True when this transaction had already been processed (safe retry / restore). */
  alreadyProcessed: z.boolean(),
  coins: z.number().int(),
  entitlements: Entitlements,
});
export type PurchaseResult = z.infer<typeof PurchaseResult>;

/** Restore purchases (required by Apple): resend every transaction / token the device still has. */
export const RestoreRequest = z
  .object({
    ios: z.array(z.string().min(50).max(20_000)).max(50).optional(),
    android: z.array(AndroidVerifyRequest).max(50).optional(),
  })
  .strict();
export type RestoreRequest = z.infer<typeof RestoreRequest>;

export const RestoreResult = z.object({
  restored: z.number().int(),
  failed: z.number().int(),
  entitlements: Entitlements,
});
export type RestoreResult = z.infer<typeof RestoreResult>;
