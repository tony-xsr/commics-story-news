import { z } from 'zod';
import { Reason } from './admin';
import { Comment, ReportReason, ReportTargetType } from './community';
import { Cursor, limit, page } from './common';

// Admin moderation (/v1/admin/reports, /v1/admin/comments, /v1/admin/banned-words).

export const CommentStatus = z.enum(['visible', 'pending', 'hidden', 'deleted']);
export type CommentStatus = z.infer<typeof CommentStatus>;
export const ReportStatus = z.enum(['open', 'resolved', 'dismissed']);
export type ReportStatus = z.infer<typeof ReportStatus>;

/** Queue = open reports grouped by target, most-reported first. Offset paging (small, admin-only). */
export const ReportQueueQuery = z
  .object({
    status: ReportStatus.default('open'),
    targetType: ReportTargetType.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: limit(50, 20),
  })
  .strict();
export type ReportQueueQuery = z.infer<typeof ReportQueueQuery>;

const Ref = z.object({ id: z.uuid(), title: z.string() });

/** What the report is about, so a moderator can decide without opening other pages. */
export const ReportTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('comment'),
    body: z.string(),
    status: CommentStatus,
    isSpoiler: z.boolean(),
    author: z.object({ id: z.uuid(), displayName: z.string(), mutedUntil: z.iso.datetime().nullable() }),
    story: Ref,
    chapterNumber: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal('story'), title: z.string(), slug: z.string(), status: z.string() }),
  z.object({ kind: z.literal('chapter'), story: Ref, number: z.number().int(), title: z.string(), status: z.string() }),
  z.object({
    kind: z.literal('user'),
    displayName: z.string(),
    status: z.string(),
    mutedUntil: z.iso.datetime().nullable(),
  }),
  z.object({ kind: z.literal('missing') }),
]);
export type ReportTarget = z.infer<typeof ReportTarget>;

export const ReportQueueItem = z.object({
  targetType: ReportTargetType,
  targetId: z.uuid(),
  reportCount: z.number().int(),
  reasons: z.partialRecord(ReportReason, z.number().int()),
  firstReportedAt: z.iso.datetime(),
  lastReportedAt: z.iso.datetime(),
  target: ReportTarget,
});
export type ReportQueueItem = z.infer<typeof ReportQueueItem>;

export const ReportQueuePage = z.object({
  items: z.array(ReportQueueItem),
  page: z.number().int(),
  hasMore: z.boolean(),
});
export type ReportQueuePage = z.infer<typeof ReportQueuePage>;

export const ReportEntry = z.object({
  id: z.uuid(),
  reporter: z.object({ id: z.uuid(), displayName: z.string() }),
  reason: ReportReason,
  detail: z.string().nullable(),
  status: ReportStatus,
  resolution: z.string().nullable(),
  handledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ReportEntry = z.infer<typeof ReportEntry>;

/** GET /v1/admin/reports/:type/:id — the target and every report on it (newest first, max 200). */
export const ReportTargetDetail = z.object({ target: ReportTarget, items: z.array(ReportEntry) });
export type ReportTargetDetail = z.infer<typeof ReportTargetDetail>;

export const ReportModerationAction = z.enum(['dismiss', 'resolve', 'hide_comment', 'delete_comment']);
export type ReportModerationAction = z.infer<typeof ReportModerationAction>;

/**
 * Closes every open report on the target. dismiss = no violation (an auto-hidden comment becomes visible again);
 * resolve = handled (e.g. the story was fixed); hide/delete apply to comments. muteDays mutes the comment's author
 * or the reported user.
 */
export const ResolveReportsRequest = z
  .object({
    targetType: ReportTargetType,
    targetId: z.uuid(),
    action: ReportModerationAction,
    note: Reason,
    muteDays: z.number().int().min(1).max(365).optional(),
  })
  .strict()
  .refine((r) => r.targetType === 'comment' || !r.action.endsWith('_comment'), {
    path: ['action'],
    message: 'hide_comment / delete_comment only apply to comments',
  })
  .refine((r) => !r.muteDays || r.targetType === 'comment' || r.targetType === 'user', {
    path: ['muteDays'],
    message: 'muteDays only applies to comment or user reports',
  });
export type ResolveReportsRequest = z.infer<typeof ResolveReportsRequest>;

export const AdminCommentQuery = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    userId: z.uuid().optional(),
    storyId: z.uuid().optional(),
    status: CommentStatus.optional(),
    cursor: Cursor.optional(),
    limit: limit(100, 50),
  })
  .strict();
export type AdminCommentQuery = z.infer<typeof AdminCommentQuery>;

export const AdminComment = Comment.extend({
  status: CommentStatus,
  story: Ref,
  chapterNumber: z.number().int().nullable(),
  openReports: z.number().int(),
});
export type AdminComment = z.infer<typeof AdminComment>;
export const AdminCommentPage = page(AdminComment);
export type AdminCommentPage = z.infer<typeof AdminCommentPage>;

export const ModerateCommentsRequest = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100),
    action: z.enum(['hide', 'delete', 'restore']),
    reason: Reason,
  })
  .strict();
export type ModerateCommentsRequest = z.infer<typeof ModerateCommentsRequest>;

export const BannedWord = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .regex(/^[^\s,]+(?: [^\s,]+)*$/, 'One word or phrase, no commas');
export const BannedWordRequest = z.object({ word: BannedWord }).strict();
export type BannedWordRequest = z.infer<typeof BannedWordRequest>;
export const BannedWordList = z.object({ words: z.array(z.string()) });
export type BannedWordList = z.infer<typeof BannedWordList>;

/** days = 0 lifts the mute. */
export const MuteRequest = z.object({ days: z.number().int().min(0).max(365), reason: Reason }).strict();
export type MuteRequest = z.infer<typeof MuteRequest>;
