import { z } from 'zod';
import { Cursor, limit, page } from './common';

// Daily reconciliation of our orders against the stores' own reports (admin, read-only).

export const ReconProvider = z.enum(['apple', 'google']);
export type ReconProvider = z.infer<typeof ReconProvider>;
/** ok = matches; mismatch = differences listed; unavailable = report not published yet (retried); error = fetch/parse failed. */
export const ReconStatus = z.enum(['ok', 'mismatch', 'unavailable', 'error', 'not_configured']);
export type ReconStatus = z.infer<typeof ReconStatus>;

const Money = z.object({ currency: z.string(), micros: z.number().int() });

/** Apple's Sales report is aggregated per product and day (Pacific Time): compare counts. */
export const AppleReconSummary = z.object({
  products: z.array(
    z.object({
      sku: z.string(),
      productId: z.string().nullable(),
      storeUnits: z.number().int(),
      ourOrders: z.number().int(),
      storeRefunds: z.number().int(),
      ourRefunds: z.number().int(),
    }),
  ),
  /** Developer proceeds per currency, as reported by Apple. */
  proceeds: z.array(Money),
});
export type AppleReconSummary = z.infer<typeof AppleReconSummary>;

/** Google's sales report lists every order: compare one by one. */
export const GoogleReconSummary = z.object({
  storeOrders: z.number().int(),
  ourOrders: z.number().int(),
  /** Charged by Google, unknown to us → the buyer may not have received coins / Premium. */
  missingInOurs: z.array(
    z.object({ orderNumber: z.string(), productId: z.string(), amount: z.string(), currency: z.string() }),
  ),
  /** Recorded by us, absent from Google's report for the month → check (fraud, test order, report delay). */
  missingInStore: z.array(z.object({ orderId: z.uuid(), storeTxnId: z.string(), productId: z.string() })),
  /** Refunded by Google but still "verified" here → coins not clawed back. */
  refundsNotApplied: z.array(z.object({ orderNumber: z.string(), orderId: z.uuid().nullable() })),
  revenue: z.array(Money),
});
export type GoogleReconSummary = z.infer<typeof GoogleReconSummary>;

export const ReconRun = z.object({
  id: z.uuid(),
  provider: ReconProvider,
  reportDate: z.iso.date(),
  status: ReconStatus,
  mismatches: z.number().int(),
  summary: z.union([AppleReconSummary, GoogleReconSummary]).nullable(),
  error: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});
export type ReconRun = z.infer<typeof ReconRun>;
export const ReconRunPage = page(ReconRun);
export type ReconRunPage = z.infer<typeof ReconRunPage>;

export const ReconQuery = z
  .object({
    provider: ReconProvider.optional(),
    status: ReconStatus.optional(),
    cursor: Cursor.optional(),
    limit: limit(100, 30),
  })
  .strict();
export type ReconQuery = z.infer<typeof ReconQuery>;

export const ReconRunRequest = z.object({ provider: ReconProvider, date: z.iso.date() }).strict();
export type ReconRunRequest = z.infer<typeof ReconRunRequest>;
