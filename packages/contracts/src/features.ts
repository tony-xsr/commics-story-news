import { z } from 'zod';
import { Reason } from './admin';
import { Platform } from './auth';

// Feature switches (admin → Tính năng): turn a whole feature off without a release. The API refuses its routes
// (FEATURE_DISABLED), the app and the reading site hide its UI (`/v1/app-config` → `features`). Store webhooks,
// purchase verification and restore are NEVER switched off — money already paid must always arrive.
// Adding a feature: docs/FEATURE_FLAGS.md.

/** Every switchable feature, with its default (what a fresh install / missing setting means). */
export const FEATURES = {
  chat: {
    label: 'Chat 1-1',
    description: 'Nhắn tin giữa người đọc (app đang tạm cất UI: parked/mobile-chat).',
    default: false,
  },
  comments: { label: 'Bình luận', description: 'Xem / viết / thích / báo cáo bình luận (app + web).', default: true },
  ratings: { label: 'Chấm điểm truyện', description: 'Chấm 1–5 sao trên trang truyện.', default: true },
  follows: { label: 'Theo dõi người dùng', description: 'Nút theo dõi, danh sách người theo dõi.', default: true },
  giftCodes: { label: 'Mã quà tặng', description: 'Nhập mã nhận xu / điểm (app).', default: true },
  rewards: {
    label: 'Điểm danh & nhiệm vụ',
    description: 'Điểm danh hằng ngày, nhiệm vụ đọc, nhắc điểm danh.',
    default: true,
  },
  stickerShop: { label: 'Shop sticker', description: 'Mua gói sticker bằng xu / điểm.', default: true },
  premium: {
    label: 'Premium (đăng ký)',
    description: 'Bán gói Premium mới. Gói đang có vẫn được gia hạn / khôi phục.',
    default: true,
  },
  coinPurchase: {
    label: 'Mua xu',
    description: 'Bán gói xu mới (IAP / Stripe). Giao dịch đang xử lý vẫn được cộng xu.',
    default: true,
  },
  waitForFree: { label: 'Chờ để đọc miễn phí', description: 'Mở chương miễn phí sau thời gian chờ.', default: true },
  ads: {
    label: 'Quảng cáo (AdMob)',
    description: 'Quảng cáo xen giữa chương + xem quảng cáo mở chương (app).',
    default: true,
  },
} as const satisfies Record<string, { label: string; description: string; default: boolean }>;

export type FeatureKey = keyof typeof FEATURES;
export const FeatureKey = z.enum(Object.keys(FEATURES) as [FeatureKey, ...FeatureKey[]]);

/** One switch: on/off, optionally only on some platforms (null = everywhere). */
export const FeatureSetting = z
  .object({ enabled: z.boolean(), platforms: z.array(Platform).min(1).nullable().default(null) })
  .strict();
export type FeatureSetting = z.infer<typeof FeatureSetting>;

/** Stored in app_settings['features']; keys left out use FEATURES[key].default. */
export const FeatureSettings = z.partialRecord(FeatureKey, FeatureSetting);
export type FeatureSettings = z.infer<typeof FeatureSettings>;

export const FeatureSettingsInput = z.object({ features: FeatureSettings, reason: Reason }).strict();
export type FeatureSettingsInput = z.infer<typeof FeatureSettingsInput>;

/** Admin view: every feature with its effective setting. */
export const AdminFeatureList = z.object({
  items: z.array(
    z.object({
      key: FeatureKey,
      label: z.string(),
      description: z.string(),
      default: z.boolean(),
      setting: FeatureSetting,
    }),
  ),
});
export type AdminFeatureList = z.infer<typeof AdminFeatureList>;

/** Public, resolved for one platform (inside `/v1/app-config`). */
export const FeatureMap = z.record(FeatureKey, z.boolean());
export type FeatureMap = z.infer<typeof FeatureMap>;

/** On for `platform`? (shared by API and clients; missing setting → default). */
export function featureOn(settings: FeatureSettings | undefined, key: FeatureKey, platform: Platform | null): boolean {
  const s = settings?.[key];
  if (!s) return FEATURES[key].default;
  if (!s.enabled) return false;
  return !s.platforms || (platform !== null && s.platforms.includes(platform));
}

export function resolveFeatures(settings: FeatureSettings | undefined, platform: Platform | null): FeatureMap {
  return Object.fromEntries(
    (Object.keys(FEATURES) as FeatureKey[]).map((k) => [k, featureOn(settings, k, platform)]),
  ) as FeatureMap;
}
