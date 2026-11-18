import { z } from 'zod';
import { Reason } from './admin';
import { Platform } from './auth';
import { Cursor, Lang, limit, page } from './common';

// Inbox (personal notifications ∪ broadcasts, merged at read time), push tokens, and admin broadcasts.

export const InboxTab = z.enum(['reward', 'update']);
export type InboxTab = z.infer<typeof InboxTab>;

/** Where tapping the item goes. URLs must be https (never javascript:, data:, …). */
export const InboxAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('story'), storyId: z.uuid() }),
  z.object({ type: z.literal('chapter'), chapterId: z.uuid() }),
  z.object({ type: z.literal('screen'), screen: z.enum(['wallet', 'premium', 'shop', 'rewards', 'library', 'inbox']) }),
  z.object({ type: z.literal('url'), url: z.url({ protocol: /^https$/ }).max(500) }),
]);
export type InboxAction = z.infer<typeof InboxAction>;

export const InboxItem = z.object({
  id: z.uuid(),
  source: z.enum(['personal', 'broadcast']),
  tab: InboxTab,
  title: z.string(),
  body: z.string(),
  icon: z.string().nullable(),
  action: InboxAction.nullable(),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type InboxItem = z.infer<typeof InboxItem>;
export const InboxPage = page(InboxItem);
export type InboxPage = z.infer<typeof InboxPage>;

export const InboxQuery = z
  .object({ tab: InboxTab.optional(), cursor: Cursor.optional(), limit: limit(50, 20) })
  .strict();
export type InboxQuery = z.infer<typeof InboxQuery>;

export const InboxReadRequest = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z
    .object({
      items: z
        .array(z.object({ source: z.enum(['personal', 'broadcast']), id: z.uuid() }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
]);
export type InboxReadRequest = z.infer<typeof InboxReadRequest>;

export const UnreadCount = z.object({ count: z.number().int() });
export type UnreadCount = z.infer<typeof UnreadCount>;

/** FCM registration token (`messaging().getToken()` on Android and iOS). */
export const PushTokenRequest = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_:-]{100,4096}$/, 'FCM registration token expected'),
    platform: Platform,
  })
  .strict();
export type PushTokenRequest = z.infer<typeof PushTokenRequest>;

/** marketing = campaigns; updates = new chapters of favorited stories. (System notices always go out.) */
export const NotificationSettings = z.object({ marketing: z.boolean(), updates: z.boolean() }).strict();
export const NotificationSettingsPatch = NotificationSettings.partial().strict();
export type NotificationSettingsPatch = z.infer<typeof NotificationSettingsPatch>;
export type NotificationSettings = z.infer<typeof NotificationSettings>;

// ---- admin broadcasts ----

/** Per-language text; `en` is the fallback for languages not given. */
const I18nText = (max: number) =>
  z
    .partialRecord(Lang, z.string().trim().min(1).max(max))
    .refine((t) => !!t.en, { message: 'English (en) text is required as the fallback' });

export const BroadcastAudience = z
  .object({
    langs: z.array(Lang).min(1).optional(),
    platforms: z.array(Platform).min(1).optional(),
    premium: z.enum(['only', 'exclude']).optional(),
    /** Push only: users with no app activity for at least N days (win-back). Ignored for the inbox. */
    inactiveDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
export type BroadcastAudience = z.infer<typeof BroadcastAudience>;

const broadcastFields = {
  tab: InboxTab,
  /** marketing = respects the user's marketing opt-out for push. */
  kind: z.enum(['system', 'marketing']),
  title: I18nText(80),
  body: I18nText(500),
  icon: z.string().trim().max(40).nullable(),
  action: InboxAction.nullable(),
  audience: BroadcastAudience,
  /** null = draft (not visible, no push). */
  publishAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  push: z.boolean(),
};

export const BroadcastCreate = z
  .object({
    ...broadcastFields,
    icon: broadcastFields.icon.default(null),
    action: broadcastFields.action.default(null),
    audience: broadcastFields.audience.default({}),
    publishAt: broadcastFields.publishAt.default(null),
    expiresAt: broadcastFields.expiresAt.default(null),
    push: broadcastFields.push.default(false),
    reason: Reason,
  })
  .strict();
export type BroadcastCreate = z.infer<typeof BroadcastCreate>;

/** Only while not published yet (or a draft). */
export const BroadcastPatch = z
  .object({ ...broadcastFields, reason: Reason })
  .partial()
  .required({ reason: true })
  .strict();
export type BroadcastPatch = z.infer<typeof BroadcastPatch>;

export const BroadcastStatus = z.enum(['draft', 'scheduled', 'live', 'expired', 'canceled']);
export const PushStatus = z.enum(['none', 'pending', 'sending', 'sent']);

export const AdminBroadcast = z.object({
  id: z.uuid(),
  ...broadcastFields,
  title: z.partialRecord(Lang, z.string()),
  body: z.partialRecord(Lang, z.string()),
  status: BroadcastStatus,
  pushStatus: PushStatus,
  pushSent: z.number().int(),
  pushFailed: z.number().int(),
  /** Users who opened it from the inbox. */
  reads: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  canceledAt: z.iso.datetime().nullable(),
});
export type AdminBroadcast = z.infer<typeof AdminBroadcast>;
export const AdminBroadcastPage = page(AdminBroadcast);
export type AdminBroadcastPage = z.infer<typeof AdminBroadcastPage>;
export const AdminBroadcastQuery = z.object({ cursor: Cursor.optional(), limit: limit(100, 30) }).strict();
export type AdminBroadcastQuery = z.infer<typeof AdminBroadcastQuery>;

/** How many push tokens the audience reaches right now. */
export const BroadcastEstimate = z.object({ pushTokens: z.number().int() });
export type BroadcastEstimate = z.infer<typeof BroadcastEstimate>;

export const BroadcastTestRequest = z.object({ userId: z.uuid() }).strict();
export type BroadcastTestRequest = z.infer<typeof BroadcastTestRequest>;
export const PushResult = z.object({ sent: z.number().int(), failed: z.number().int() });
export type PushResult = z.infer<typeof PushResult>;
