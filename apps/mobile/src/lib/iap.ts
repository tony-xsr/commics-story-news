import type { Endpoints } from '@storyzio/api-client';
import type { AndroidVerifyRequest, PurchaseResult, StoreProduct } from '@storyzio/contracts';
import { Platform } from 'react-native';

type Iap = typeof import('expo-iap');
type Purchase = Parameters<Iap['finishTransaction']>[0]['purchase'];
type StoreSub = NonNullable<Awaited<ReturnType<Iap['fetchProducts']>>>[number];
type Offer = NonNullable<Extract<StoreSub, { subscriptionOffers?: unknown }>['subscriptionOffers']>[number];

/** Introductory / win-back price the store will apply for THIS user (free trial or discounted first periods). */
export type StoreOffer = {
  free: boolean;
  /** Localized price per period during the offer ("$0.99"); "" when free. */
  price: string;
  period: { unit: 'day' | 'week' | 'month' | 'year'; value: number };
  /** How many periods the offer lasts. */
  periods: number;
};
export type BuyOutcome = { status: 'done'; result: PurchaseResult } | { status: 'cancelled' } | { status: 'unavailable' };

const PURCHASE_TIMEOUT_MS = 10 * 60_000;
/** Play Billing replacement: longer plan starts now and keeps the time left; shorter plan from the next renewal. */
const REPLACEMENT_MODE = { immediate: 'charge-full-price', deferred: 'deferred' } as const;

function iap(): Iap | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // Native module: absent in Expo Go.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module, loaded lazily
    return require('expo-iap') as Iap;
  } catch {
    return null;
  }
}

let connected: Promise<boolean> | null = null;
const connect = (lib: Iap) => (connected ??= lib.initConnection().catch(() => ((connected = null), false)));

const isSubscription = (product: Pick<StoreProduct, 'kind'>) => product.kind === 'subscription';

/** Store-localized prices by SKU ("$4.99", "119.000 ₫"); empty when the store is unavailable. */
export async function storePrices(skus: { inApp: string[]; subs: string[] }): Promise<Record<string, string>> {
  const lib = iap();
  if (!lib || !(await connect(lib))) return {};
  const prices: Record<string, string> = {};
  for (const [type, list] of [
    ['in-app', skus.inApp],
    ['subs', skus.subs],
  ] as const) {
    if (list.length === 0) continue;
    const products = (await lib.fetchProducts({ skus: list, type }).catch(() => null)) ?? [];
    for (const p of products) prices[p.id] = p.displayPrice;
  }
  return prices;
}

/**
 * Android offer to apply on a base plan: Play only lists offers this user is eligible for (free trial, intro price,
 * win-back), so the first real offer wins over the plain base plan. Offers set to "developer determined" eligibility
 * are listed for everyone — tag them `manual` in Play Console and they are never picked automatically.
 */
function androidOffer(offers: readonly Offer[], basePlanId: string | null): { offer: Offer | null; token?: string } {
  const own = offers.filter((o) => o.basePlanIdAndroid === basePlanId);
  const base = own.find((o) => !o.id || o.id === basePlanId);
  const special = own.find((o) => o !== base && !(o.offerTagsAndroid ?? []).includes('manual'));
  const chosen = special ?? base ?? own[0];
  return { offer: special ?? null, token: chosen?.offerTokenAndroid ?? undefined };
}

function toStoreOffer(o: Offer): StoreOffer | null {
  const unit = o.period?.unit;
  if (!unit || unit === 'unknown') return null;
  const free = o.paymentMode === 'free-trial' || o.price === 0;
  return {
    free,
    price: free ? '' : o.displayPrice,
    period: { unit, value: o.period?.value ?? 1 },
    periods: o.periodCount ?? o.numberOfPeriodsIOS ?? 1,
  };
}

/** Offers the store would apply now, by our product id (only plans that have one). */
export async function storeOffers(plans: readonly StoreProduct[]): Promise<Record<string, StoreOffer>> {
  const lib = iap();
  if (!lib || plans.length === 0 || !(await connect(lib))) return {};
  const skus = [...new Set(plans.map((p) => p.sku))];
  const products = (await lib.fetchProducts({ skus, type: 'subs' }).catch(() => null)) ?? [];
  const result: Record<string, StoreOffer> = {};
  for (const plan of plans) {
    const product = products.find((p) => p.id === plan.sku);
    if (!product || !('subscriptionOffers' in product)) continue;
    const offers = product.subscriptionOffers ?? [];
    let offer: Offer | null = null;
    if (Platform.OS === 'android') offer = androidOffer(offers, plan.basePlanId).offer;
    else {
      // StoreKit applies the introductory offer by itself — show it only to users who still qualify.
      const intro = offers.find((o) => o.type === 'introductory') ?? null;
      const group = 'subscriptionGroupIdIOS' in product ? product.subscriptionGroupIdIOS : null;
      if (intro && group && (await lib.isEligibleForIntroOfferIOS(group).catch(() => false))) offer = intro;
    }
    const mapped = offer && toStoreOffer(offer);
    if (mapped) result[plan.id] = mapped;
  }
  return result;
}

/** Sends a store purchase to our server; only after it is credited is the transaction finished / consumed. */
async function settle(lib: Iap, api: Endpoints, purchase: Purchase, subscription: boolean): Promise<PurchaseResult> {
  const token = purchase.purchaseToken;
  if (!token) throw new Error('Purchase has no token');
  const result =
    Platform.OS === 'ios'
      ? await api.payments.verifyIos(token)
      : await api.payments.verifyAndroid({ productId: purchase.productId, purchaseToken: token, subscription });
  await lib.finishTransaction({ purchase, isConsumable: !subscription });
  return result;
}

/**
 * Buy a coin pack or a Premium plan: server intent (ties the purchase to this account) → store sheet → server
 * verification (credits coins / Premium) → finish. Money never moves on the client's word alone.
 */
export async function buy(api: Endpoints, product: StoreProduct): Promise<BuyOutcome> {
  const lib = iap();
  if (!lib || !(await connect(lib))) return { status: 'unavailable' };
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const subscription = isSubscription(product);
  const type = subscription ? 'subs' : 'in-app';
  const intent = await api.payments.intent({ productId: product.id, platform });

  // Android subscriptions: the offer of our base plan — an eligible trial / intro / win-back offer when there is one.
  let offerToken: string | undefined;
  if (subscription && platform === 'android') {
    const [details] = (await lib.fetchProducts({ skus: [intent.sku], type: 'subs' })) ?? [];
    offerToken = androidOffer(details?.subscriptionOffers ?? [], product.basePlanId).token;
  }

  return new Promise<BuyOutcome>((resolve, reject) => {
    const timer = setTimeout(() => done(() => resolve({ status: 'cancelled' })), PURCHASE_TIMEOUT_MS);
    const onPurchase = lib.purchaseUpdatedListener((purchase) => {
      if (purchase.productId !== intent.sku) return;
      settle(lib, api, purchase, subscription).then(
        (result) => done(() => resolve({ status: 'done', result })),
        (err) => done(() => reject(err)), // left unfinished: recoverPurchases() retries it
      );
    });
    const onError = lib.purchaseErrorListener((error) => {
      done(() => (error.code === lib.ErrorCode.UserCancelled ? resolve({ status: 'cancelled' }) : reject(error)));
    });
    function done(fn: () => void) {
      clearTimeout(timer);
      onPurchase.remove();
      onError.remove();
      fn();
    }
    lib
      .requestPurchase({
        type,
        request: {
          apple: { sku: intent.sku, appAccountToken: intent.appAccountToken },
          google: {
            skus: [intent.sku],
            obfuscatedAccountId: intent.obfuscatedAccountId,
            obfuscatedProfileId: intent.intentId,
            ...(offerToken ? { subscriptionOffers: [{ sku: intent.sku, offerToken }] } : {}),
            // Switching plan: replace the live purchase (otherwise Play bills both plans).
            ...(intent.replace
              ? {
                  purchaseToken: intent.replace.purchaseToken,
                  // All plans are base plans of one Play subscription, so the old product is the same SKU.
                  subscriptionProductReplacementParams: {
                    oldProductId: intent.sku,
                    replacementMode: REPLACEMENT_MODE[intent.replace.mode],
                  },
                }
              : {}),
          },
        },
      })
      .catch((err: unknown) => done(() => reject(err)));
  });
}

/**
 * App start / foreground: purchases paid but never credited (app killed mid-flow, network error) are sent again.
 * Verification is idempotent, so resending one already credited is harmless.
 */
export async function recoverPurchases(api: Endpoints, subscriptionSkus: ReadonlySet<string>): Promise<number> {
  const lib = iap();
  if (!lib || !(await connect(lib))) return 0;
  const purchases = await lib.getAvailablePurchases().catch(() => []);
  let credited = 0;
  for (const purchase of purchases) {
    const subscription = subscriptionSkus.has(purchase.productId);
    try {
      const result = await settle(lib, api, purchase, subscription);
      if (!result.alreadyProcessed) credited += 1;
    } catch {
      // stays pending; the store webhook is the second path
    }
  }
  return credited;
}

/** "Restore purchases" (required by Apple): resend everything the store still holds for this device. */
export async function restorePurchases(api: Endpoints, subscriptionSkus: ReadonlySet<string>) {
  const lib = iap();
  if (!lib || !(await connect(lib))) return null;
  const purchases = (await lib.getAvailablePurchases()).filter((p) => !!p.purchaseToken);
  if (Platform.OS === 'ios') return api.payments.restore({ ios: purchases.map((p) => p.purchaseToken!) });
  const android: AndroidVerifyRequest[] = purchases.map((p) => ({
    productId: p.productId,
    purchaseToken: p.purchaseToken!,
    subscription: subscriptionSkus.has(p.productId),
  }));
  return api.payments.restore({ android });
}
