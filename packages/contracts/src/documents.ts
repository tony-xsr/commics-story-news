import { z } from 'zod';
import { FeatureMap } from './features';
import { Reason } from './admin';
import { Platform } from './auth';
import { Cursor, Lang, limit, page } from './common';

// In-app documents (privacy, terms, about, FAQ), user feedback, and app config (force update / maintenance).

export const DocumentSlug = z.enum(['privacy', 'terms', 'about', 'faq']);
export type DocumentSlug = z.infer<typeof DocumentSlug>;

/** FAQ: heading = question, body = answer. */
export const DocumentSection = z.object({ heading: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) });
export type DocumentSection = z.infer<typeof DocumentSection>;

/** Public, one language (falls back to `en`); CDN-cacheable. */
export const AppDocument = z.object({
  slug: DocumentSlug,
  title: z.string(),
  summary: z.string(),
  sections: z.array(DocumentSection),
  updatedAt: z.iso.datetime(),
});
export type AppDocument = z.infer<typeof AppDocument>;
export const DocumentQuery = z.object({ lang: Lang.default('en') }).strict();

const PerLang = <T extends z.ZodType>(item: T) =>
  z.partialRecord(Lang, item).refine((t) => t.en !== undefined, { message: 'English (en) is required as the fallback' });

export const DocumentInput = z
  .object({
    title: PerLang(z.string().trim().min(1).max(120)),
    summary: PerLang(z.string().trim().max(500)),
    sections: PerLang(z.array(DocumentSection).max(100)),
    published: z.boolean(),
    reason: Reason,
  })
  .strict();
export type DocumentInput = z.infer<typeof DocumentInput>;

export const AdminDocument = z.object({
  slug: DocumentSlug,
  title: z.partialRecord(Lang, z.string()),
  summary: z.partialRecord(Lang, z.string()),
  sections: z.partialRecord(Lang, z.array(DocumentSection)),
  published: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type AdminDocument = z.infer<typeof AdminDocument>;
export const AdminDocumentList = z.object({ items: z.array(AdminDocument) });
export type AdminDocumentList = z.infer<typeof AdminDocumentList>;

// ---- feedback ----

export const FeedbackRequest = z.object({ message: z.string().trim().min(10).max(2000) }).strict();
export type FeedbackRequest = z.infer<typeof FeedbackRequest>;

export const FeedbackStatus = z.enum(['open', 'in_progress', 'resolved']);
export const AdminFeedback = z.object({
  id: z.uuid(),
  user: z.object({ id: z.uuid(), displayName: z.string(), email: z.string().nullable() }),
  message: z.string(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  status: FeedbackStatus,
  createdAt: z.iso.datetime(),
  /** Ticket handling (admin E1). */
  assigneeEmail: z.string().nullable(),
  lastReplyAt: z.iso.datetime().nullable(),
});
export type AdminFeedback = z.infer<typeof AdminFeedback>;
export const AdminFeedbackPage = page(AdminFeedback);
export type AdminFeedbackPage = z.infer<typeof AdminFeedbackPage>;
export const AdminFeedbackQuery = z
  .object({
    status: FeedbackStatus.optional(),
    /** `me` = assigned to the caller, `none` = unassigned. */
    assignee: z.enum(['me', 'none']).optional(),
    cursor: Cursor.optional(),
    limit: limit(100, 50),
  })
  .strict();
export type AdminFeedbackQuery = z.infer<typeof AdminFeedbackQuery>;
export const UpdateFeedbackRequest = z.object({ status: FeedbackStatus }).strict();

// ---- app config ----

const Version = z.string().regex(/^\d+\.\d+\.\d+$/, 'x.y.z');

/** Stored config (admin). Versions per mobile platform. */
export const AppConfigInput = z
  .object({
    ios: z.object({ minVersion: Version, latestVersion: Version, storeUrl: z.url({ protocol: /^https$/ }) }).strict(),
    android: z.object({ minVersion: Version, latestVersion: Version, storeUrl: z.url({ protocol: /^https$/ }) }).strict(),
    /**
     * `active` = on right now (manual switch). `startsAt` / `endsAt` (UTC ISO) = a scheduled window: the app warns
     * before it, blocks during it and opens again by itself after it — every device shows the times in its own zone.
     */
    maintenance: z
      .object({
        active: z.boolean(),
        message: z.string().trim().max(500),
        startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
        endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
      })
      .strict()
      .refine((m) => !m.startsAt || !m.endsAt || Date.parse(m.endsAt) > Date.parse(m.startsAt), {
        message: 'endsAt must be after startsAt',
        path: ['endsAt'],
      }),
    supportEmail: z.email(),
    reason: Reason,
  })
  .strict();
export type AppConfigInput = z.infer<typeof AppConfigInput>;
export type StoredAppConfig = Omit<AppConfigInput, 'reason'>;

export const AppConfigQuery = z.object({ platform: Platform, version: Version.optional() }).strict();
export type AppConfigQuery = z.infer<typeof AppConfigQuery>;

/** What the app checks at start. Same for every caller with the same platform + version (CDN 60 s). */
export const AppConfig = z.object({
  minVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  /** The installed version is below the minimum: block the app until updated (requests answer 426 too). */
  updateRequired: z.boolean(),
  updateAvailable: z.boolean(),
  storeUrl: z.string().nullable(),
  /** `active` already includes the schedule (computed per request); times are UTC — show them in the device zone. */
  maintenance: z.object({
    active: z.boolean(),
    message: z.string(),
    startsAt: z.iso.datetime().nullable(),
    endsAt: z.iso.datetime().nullable(),
  }),
  supportEmail: z.string(),
  /** Feature switches resolved for this platform (admin → Tính năng); hide the UI of features that are off. */
  features: FeatureMap,
});

/** Is a maintenance window (manual switch or schedule) in force at `now`? Shared by API and app. */
export function maintenanceActive(
  m: { active: boolean; startsAt: string | null; endsAt: string | null },
  now: number = Date.now(),
): boolean {
  if (m.active) return true;
  if (!m.startsAt) return false;
  return Date.parse(m.startsAt) <= now && (!m.endsAt || now < Date.parse(m.endsAt));
}
export type AppConfig = z.infer<typeof AppConfig>;

/** "1.10.0" > "1.9.3". Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// ---- support desk (admin E1, E2) ----

export const FeedbackReply = z.object({ id: z.uuid(), adminEmail: z.string(), body: z.string(), createdAt: z.iso.datetime() });
export const AdminFeedbackDetail = AdminFeedback.extend({
  user: z.object({ id: z.uuid(), displayName: z.string(), email: z.string().nullable(), locale: z.string(), status: z.string() }),
  replies: z.array(FeedbackReply),
});
export type AdminFeedbackDetail = z.infer<typeof AdminFeedbackDetail>;

/** Reply to a ticket: saved on the ticket and sent to the user's inbox. `resolve` closes the ticket too. */
export const FeedbackReplyRequest = z.object({ body: z.string().trim().min(2).max(4000), resolve: z.boolean().default(false) }).strict();
export type FeedbackReplyRequest = z.infer<typeof FeedbackReplyRequest>;
export const FeedbackAssignRequest = z.object({ assign: z.enum(['me', 'none']) }).strict();
export type FeedbackAssignRequest = z.infer<typeof FeedbackAssignRequest>;

const MacroText = z.string().trim().min(2).max(4000);
export const SupportMacroInput = z
  .object({
    title: z.string().trim().min(2).max(100),
    /** One text per language; `en` required (fallback for other languages). */
    body: z.object({ en: MacroText }).catchall(MacroText),
  })
  .strict();
export type SupportMacroInput = z.infer<typeof SupportMacroInput>;
export const SupportMacro = SupportMacroInput.extend({ id: z.uuid(), updatedAt: z.iso.datetime() });
export type SupportMacro = z.infer<typeof SupportMacro>;
