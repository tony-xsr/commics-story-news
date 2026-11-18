import { z } from 'zod';
import { Platform } from './auth';
import { Cursor, limit, page } from './common';
import { PremiumPlan, SubscriptionStatus } from './payments';

// Admin finance (/v1/admin/orders, /subscriptions, /store-notifications, /revenue). Read-only except webhook replay.

const StorePlatform = Platform;
const Environment = z.enum(['production', 'sandbox']);
const UserRef = z.object({ id: z.uuid(), displayName: z.string() });
const Day = z.iso.date();

export const AdminOrderQuery = z
  .object({
    platform: StorePlatform.optional(),
    status: z.enum(['verified', 'refunded']).optional(),
    environment: Environment.optional(),
    productId: z.string().max(64).optional(),
    /** Store transaction id, original id / purchase token, or user id. */
    q: z.string().trim().min(1).max(512).optional(),
    from: Day.optional(),
    to: Day.optional(),
    cursor: Cursor.optional(),
    limit: limit(100, 50),
  })
  .strict();
export type AdminOrderQuery = z.infer<typeof AdminOrderQuery>;

export const AdminOrder = z.object({
  id: z.uuid(),
  user: UserRef,
  productId: z.string(),
  productTitle: z.string(),
  platform: StorePlatform,
  environment: Environment,
  storeTxnId: z.string(),
  originalId: z.string().nullable(),
  status: z.enum(['verified', 'refunded']),
  /** In the store's currency (see `currency`) — never sum across currencies. */
  priceMicros: z.number().int().nullable(),
  currency: z.string().nullable(),
  createdAt: z.iso.datetime(),
  refundedAt: z.iso.datetime().nullable(),
});
export type AdminOrder = z.infer<typeof AdminOrder>;
export const AdminOrderPage = page(AdminOrder);
export type AdminOrderPage = z.infer<typeof AdminOrderPage>;
export const AdminOrderDetail = AdminOrder.extend({ raw: z.unknown() });
export type AdminOrderDetail = z.infer<typeof AdminOrderDetail>;

export const AdminSubscriptionQuery = z
  .object({
    status: SubscriptionStatus.optional(),
    platform: StorePlatform.optional(),
    plan: PremiumPlan.optional(),
    environment: Environment.optional(),
    cursor: Cursor.optional(),
    limit: limit(100, 50),
  })
  .strict();
export type AdminSubscriptionQuery = z.infer<typeof AdminSubscriptionQuery>;

export const AdminSubscription = z.object({
  id: z.uuid(),
  user: UserRef,
  productId: z.string(),
  plan: PremiumPlan,
  platform: StorePlatform,
  status: SubscriptionStatus,
  environment: Environment,
  originalId: z.string(),
  currentPeriodStart: z.iso.datetime().nullable(),
  currentPeriodEnd: z.iso.datetime(),
  willRenew: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminSubscription = z.infer<typeof AdminSubscription>;
export const AdminSubscriptionPage = page(AdminSubscription);
export type AdminSubscriptionPage = z.infer<typeof AdminSubscriptionPage>;
/** The subscription and every billing period (order) under its original id, newest first. */
export const AdminSubscriptionDetail = AdminSubscription.extend({ orders: z.array(AdminOrder) });
export type AdminSubscriptionDetail = z.infer<typeof AdminSubscriptionDetail>;

export const StoreNotificationState = z.enum(['failed', 'pending', 'processed', 'all']);
export const StoreNotificationQuery = z
  .object({
    state: StoreNotificationState.default('failed'),
    provider: z.enum(['apple', 'google']).optional(),
    cursor: Cursor.optional(),
    limit: limit(100, 50),
  })
  .strict();
export type StoreNotificationQuery = z.infer<typeof StoreNotificationQuery>;

export const StoreNotificationItem = z.object({
  id: z.uuid(),
  provider: z.string(),
  notificationId: z.string(),
  type: z.string(),
  subtype: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});
export type StoreNotificationItem = z.infer<typeof StoreNotificationItem>;
export const StoreNotificationPage = page(StoreNotificationItem);
export type StoreNotificationPage = z.infer<typeof StoreNotificationPage>;
export const StoreNotificationDetail = StoreNotificationItem.extend({ payload: z.unknown() });
export type StoreNotificationDetail = z.infer<typeof StoreNotificationDetail>;
export const ReplayResult = z.object({ ok: z.boolean(), error: z.string().nullable() });
export type ReplayResult = z.infer<typeof ReplayResult>;

// ---- revenue report ----

export const RevenueQuery = z
  .object({ from: Day, to: Day, environment: Environment.default('production') })
  .strict()
  .refine((q) => q.from <= q.to, { path: ['to'], message: '`to` must be on or after `from`' })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, {
    path: ['to'],
    message: 'At most 366 days',
  });
export type RevenueQuery = z.infer<typeof RevenueQuery>;

const Money = z.object({ currency: z.string(), grossMicros: z.number().int(), refundedMicros: z.number().int() });

/**
 * Store prices come in the buyer's currency, so real money is reported per currency. `estimatedUsd*` uses each
 * product's reference USD price × STORE_NET_RATE — a planning estimate, not accounting.
 */
export const RevenueReport = z.object({
  from: Day,
  to: Day,
  environment: Environment,
  days: z.array(
    z.object({
      date: Day,
      platform: StorePlatform,
      orders: z.number().int(),
      refunds: z.number().int(),
      estimatedUsdMicros: z.number().int(),
    }),
  ),
  byProduct: z.array(
    z.object({
      productId: z.string(),
      title: z.string(),
      orders: z.number().int(),
      refunds: z.number().int(),
      estimatedUsdMicros: z.number().int(),
    }),
  ),
  byCurrency: z.array(Money),
  totals: z.object({
    orders: z.number().int(),
    refunds: z.number().int(),
    estimatedUsdGrossMicros: z.number().int(),
    estimatedUsdNetMicros: z.number().int(),
  }),
  /** Right now (not limited to the range). MRR normalizes weekly ×52/12 and yearly ÷12. */
  subscriptions: z.object({
    active: z.number().int(),
    byPlan: z.partialRecord(PremiumPlan, z.number().int()),
    estimatedMrrUsdMicros: z.number().int(),
  }),
  /** Coin flows in the range, and paid coins not yet spent (deferred revenue at their purchase value). */
  coins: z.object({
    sold: z.number().int(),
    bonusGranted: z.number().int(),
    spent: z.number().int(),
    expired: z.number().int(),
    clawedBack: z.number().int(),
    adminAdjusted: z.number().int(),
    unspentPaid: z.number().int(),
    deferredRevenueMicros: z.number().int(),
  }),
});
export type RevenueReport = z.infer<typeof RevenueReport>;
