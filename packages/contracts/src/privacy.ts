import { z } from 'zod';
import { Reason } from './admin';
import { Email } from './auth';
import { Cursor, Lang, limit } from './common';

// Privacy requests (store rules: account deletion and a copy of your data, also without the app).
// Web form → email link to the ACCOUNT's address (never the typed one) → admin queue → done / rejected.
// In the app / on the reading site, deletions are immediate (/v1/me/account/delete, /v1/me/data/delete); a data copy
// is asked for here.

/** account_deletion: the whole account · data_deletion: activity data, the account stays · data_export: a copy. */
export const PrivacyRequestType = z.enum(['account_deletion', 'data_deletion', 'data_export']);
export type PrivacyRequestType = z.infer<typeof PrivacyRequestType>;

/** unverified: waits for the email link · pending: admin queue · completed / rejected: closed. */
export const PrivacyRequestStatus = z.enum(['unverified', 'pending', 'completed', 'rejected']);
export type PrivacyRequestStatus = z.infer<typeof PrivacyRequestStatus>;

/** `POST /v1/privacy-requests` (public web form). Same answer whether or not an account matches. */
export const PublicPrivacyRequest = z
  .object({
    type: PrivacyRequestType,
    email: Email,
    /** Accounts without an email (username / phone sign-in): the admin checks the request by hand. */
    username: z.string().trim().min(3).max(30).optional(),
    note: z.string().trim().max(1000).optional(),
    locale: Lang.optional(),
    captchaToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type PublicPrivacyRequest = z.infer<typeof PublicPrivacyRequest>;

export const PrivacyRequestReceived = z.object({ status: z.literal('received') });
export type PrivacyRequestReceived = z.infer<typeof PrivacyRequestReceived>;

/** `POST /v1/privacy-requests/confirm` — the link in the email. */
export const ConfirmPrivacyRequest = z.object({ token: z.string().min(20).max(200) }).strict();
export type ConfirmPrivacyRequest = z.infer<typeof ConfirmPrivacyRequest>;
export const ConfirmPrivacyResult = z.object({ type: PrivacyRequestType, status: PrivacyRequestStatus });
export type ConfirmPrivacyResult = z.infer<typeof ConfirmPrivacyResult>;

/** `POST /v1/me/privacy-requests` (signed in: no email step). Deletion in the app uses /v1/me/account/delete. */
export const MyPrivacyRequestInput = z.object({ type: z.literal('data_export') }).strict();
export type MyPrivacyRequestInput = z.infer<typeof MyPrivacyRequestInput>;

export const MyPrivacyRequest = z.object({
  id: z.string(),
  type: PrivacyRequestType,
  status: PrivacyRequestStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** Data copy ready: signed link, valid until downloadExpiresAt. */
  downloadUrl: z.string().nullable(),
  downloadExpiresAt: z.string().nullable(),
});
export type MyPrivacyRequest = z.infer<typeof MyPrivacyRequest>;
export const MyPrivacyRequests = z.object({ items: z.array(MyPrivacyRequest) });
export type MyPrivacyRequests = z.infer<typeof MyPrivacyRequests>;

// ---- admin ----

export const AdminPrivacyRequestQuery = z
  .object({
    status: PrivacyRequestStatus.optional(),
    type: PrivacyRequestType.optional(),
    cursor: Cursor.optional(),
    limit: limit(100, 50),
  })
  .strict();
export type AdminPrivacyRequestQuery = z.infer<typeof AdminPrivacyRequestQuery>;

export const AdminPrivacyRequest = z.object({
  id: z.string(),
  type: PrivacyRequestType,
  status: PrivacyRequestStatus,
  source: z.enum(['web', 'app']),
  /** Masked unless the admin has users.pii. */
  email: z.string(),
  username: z.string().nullable(),
  note: z.string().nullable(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  /** The owner proved it (email link or signed-in app); false = check by hand before approving. */
  verified: z.boolean(),
  createdAt: z.string(),
  /** Answer due by (30 days after the request). */
  dueAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
});
export type AdminPrivacyRequest = z.infer<typeof AdminPrivacyRequest>;
export const AdminPrivacyRequestPage = z.object({
  items: z.array(AdminPrivacyRequest),
  nextCursor: z.string().nullable(),
  /** Open (pending) requests, for the menu badge. */
  pending: z.number().int(),
});
export type AdminPrivacyRequestPage = z.infer<typeof AdminPrivacyRequestPage>;

export const AdminPrivacyDecision = z.object({ action: z.enum(['approve', 'reject']), reason: Reason }).strict();
export type AdminPrivacyDecision = z.infer<typeof AdminPrivacyDecision>;
