import { z } from 'zod';
import { Reason } from './admin';

// SEO (web): site-wide settings, redirects, sitemap feed, audit. Admin UI is Vietnamese; values are per language.

const Text = (max: number) => z.string().trim().max(max);
const Verification = z.string().trim().max(120).regex(/^[\w.:=+/-]*$/, 'letters, digits and - _ . : = + / only');

/** Per-language home title / description (any language left empty falls back to the web strings). */
export const SeoLangText = z.object({ title: Text(70), description: Text(200) }).strict();

export const SeoSettings = z
  .object({
    /** Home page title / description per language (`vi`, `en`…). */
    home: z.record(z.string().min(2).max(8), SeoLangText),
    /** Search console verification tokens (the `content` value only). */
    verification: z.object({ google: Verification, bing: Verification, yandex: Verification }).strict(),
    /** Other `<meta name content>` tags a webmaster tool asks for (Cốc Cốc, Pinterest, Facebook domain…). */
    customMeta: z
      .array(z.object({ name: z.string().regex(/^[\w:.-]{1,60}$/), content: Verification }).strict())
      .max(10),
    /** Organization for structured data (Google knowledge panel). */
    organization: z
      .object({
        name: Text(80),
        logoUrl: z.union([z.url(), z.literal('')]),
        /** Facebook page, TikTok, YouTube… */
        sameAs: z.array(z.url()).max(10),
      })
      .strict(),
    /** `@handle` for Twitter / X cards. */
    twitterHandle: z.union([z.string().regex(/^@\w{1,15}$/), z.literal('')]),
    /** Extra robots.txt Disallow paths (start with `/`). */
    robotsDisallow: z.array(z.string().regex(/^\/[^\s]*$/).max(200)).max(50),
    /** Ping IndexNow (Bing, Yandex, Naver, Seznam…) when stories / chapters change. */
    indexNow: z.boolean(),
  })
  .strict();
export type SeoSettings = z.infer<typeof SeoSettings>;

export const DEFAULT_SEO_SETTINGS: SeoSettings = {
  home: {},
  verification: { google: '', bing: '', yandex: '' },
  customMeta: [],
  organization: { name: 'StoryZio', logoUrl: '', sameAs: [] },
  twitterHandle: '',
  robotsDisallow: [],
  indexNow: true,
};

export const SeoSettingsInput = SeoSettings.extend({ reason: Reason }).strict();
export type SeoSettingsInput = z.infer<typeof SeoSettingsInput>;

// ---- redirects ----

/** `/truyen/ten-cu` — lowercase path, no query. */
export const RedirectPath = z
  .string()
  .trim()
  .max(500)
  .regex(/^\/[^\s?#]*$/, 'a path starting with / (no ? or #)');

export const SeoRedirect = z.object({
  id: z.uuid(),
  fromPath: z.string(),
  toPath: z.string(),
  permanent: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type SeoRedirect = z.infer<typeof SeoRedirect>;

export const SeoRedirectInput = z
  .object({
    fromPath: RedirectPath,
    toPath: z.union([RedirectPath, z.url().startsWith('https://')]),
    permanent: z.boolean().default(true),
    note: Text(200).nullable().default(null),
  })
  .strict();
export type SeoRedirectInput = z.infer<typeof SeoRedirectInput>;

/** Bulk import: one `from to` pair per line (CSV-style “from,to” also accepted). */
export const SeoRedirectImport = z.object({ lines: z.string().max(500_000), permanent: z.boolean().default(true) }).strict();
export type SeoRedirectImport = z.infer<typeof SeoRedirectImport>;

export const SeoRedirectQuery = z.object({ q: z.string().trim().max(200).optional(), page: z.coerce.number().int().min(1).default(1) }).strict();
export const SeoRedirectLookup = z.object({ path: RedirectPath }).strict();
export const SeoRedirectTarget = z.object({ to: z.string(), permanent: z.boolean() });
export type SeoRedirectTarget = z.infer<typeof SeoRedirectTarget>;

// ---- sitemap feed (web) ----

export const SITEMAP_CHUNK = 1000;

export const SitemapStats = z.object({ stories: z.number().int(), chunks: z.number().int(), chunkSize: z.number().int() });
export type SitemapStats = z.infer<typeof SitemapStats>;

/** Indexable stories only (public, < 18, not noindex), with their free chapters (the only indexable chapter pages). */
export const SitemapStory = z.object({
  slug: z.string(),
  language: z.string(),
  title: z.string(),
  coverUrl: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  freeChapters: z.array(z.object({ number: z.number().int(), publishedAt: z.iso.datetime().nullable() })),
});
export type SitemapStory = z.infer<typeof SitemapStory>;
export const SitemapChunkQuery = z.object({ chunk: z.coerce.number().int().min(0).max(10_000) }).strict();

// ---- audit (admin) ----

export const SeoIssue = z.object({
  code: z.string(),
  label: z.string(),
  level: z.enum(['error', 'warn', 'info']),
  total: z.number().int(),
  samples: z.array(z.object({ id: z.uuid(), title: z.string() })),
});
export type SeoIssue = z.infer<typeof SeoIssue>;

export const SeoAudit = z.object({
  totals: z.object({
    stories: z.number().int(),
    indexable: z.number().int(),
    adult: z.number().int(),
    noindex: z.number().int(),
    freeChapters: z.number().int(),
    redirects: z.number().int(),
    byLanguage: z.record(z.string(), z.number().int()),
  }),
  issues: z.array(SeoIssue),
  generatedAt: z.iso.datetime(),
});
export type SeoAudit = z.infer<typeof SeoAudit>;
