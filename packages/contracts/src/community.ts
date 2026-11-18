import { z } from 'zod';
import { Cursor, limit, page } from './common';

// Comments, ratings and reports (app side). Admin moderation: moderation.ts.

export const COMMENT_MAX_LENGTH = 2000;

export const CommentAuthor = z.object({
  id: z.uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  level: z.number().int(),
});
export type CommentAuthor = z.infer<typeof CommentAuthor>;

export const Comment = z.object({
  id: z.uuid(),
  storyId: z.uuid(),
  chapterId: z.uuid().nullable(),
  parentId: z.uuid().nullable(),
  author: CommentAuthor,
  body: z.string(),
  sticker: z.object({ id: z.uuid(), imageUrl: z.string() }).nullable(),
  isSpoiler: z.boolean(),
  likeCount: z.number().int(),
  replyCount: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type Comment = z.infer<typeof Comment>;

export const CommentPage = page(Comment);
export type CommentPage = z.infer<typeof CommentPage>;

export const CommentSort = z.enum(['new', 'top']);
export type CommentSort = z.infer<typeof CommentSort>;

/** No chapterId = comments on the story page itself. */
export const CommentListQuery = z
  .object({
    chapterId: z.uuid().optional(),
    sort: CommentSort.default('new'),
    cursor: Cursor.optional(),
    limit: limit(50, 20),
  })
  .strict();
export type CommentListQuery = z.infer<typeof CommentListQuery>;

export const ReplyListQuery = z.object({ cursor: Cursor.optional(), limit: limit(50, 20) }).strict();
export type ReplyListQuery = z.infer<typeof ReplyListQuery>;

export const CreateCommentRequest = z
  .object({
    storyId: z.uuid(),
    chapterId: z.uuid().optional(),
    /** Reply to a top-level comment (replying to a reply attaches to its top-level comment). */
    parentId: z.uuid().optional(),
    body: z.string().trim().max(COMMENT_MAX_LENGTH).default(''),
    /** A sticker from a pack the user owns; the body may then be empty. */
    stickerId: z.uuid().optional(),
    isSpoiler: z.boolean().default(false),
  })
  .strict()
  .refine((c) => c.body.length > 0 || !!c.stickerId, { path: ['body'], message: 'Write something or pick a sticker' });
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;

export const MyComment = Comment.extend({
  status: z.enum(['visible', 'pending', 'hidden']),
  story: z.object({ id: z.uuid(), slug: z.string(), title: z.string() }),
});
export type MyComment = z.infer<typeof MyComment>;
export const MyCommentPage = page(MyComment);
export type MyCommentPage = z.infer<typeof MyCommentPage>;

/** `liked by me` is fetched separately so comment pages stay CDN-cacheable. ids = comma-separated, max 100. */
export const CommentLikesQuery = z
  .object({
    ids: z
      .string()
      .max(100 * 37)
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(z.uuid()).min(1).max(100)),
  })
  .strict();
export type CommentLikesQuery = z.infer<typeof CommentLikesQuery>;
export const CommentLikes = z.object({ liked: z.array(z.uuid()) });
export type CommentLikes = z.infer<typeof CommentLikes>;

export const RateRequest = z.object({ score: z.number().int().min(1).max(5) }).strict();
export type RateRequest = z.infer<typeof RateRequest>;

// ---- reports ----

export const ReportTargetType = z.enum(['story', 'chapter', 'comment', 'user']);
export type ReportTargetType = z.infer<typeof ReportTargetType>;
export const ReportReason = z.enum([
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'spoiler',
  'copyright',
  'other',
]);
export type ReportReason = z.infer<typeof ReportReason>;

export const CreateReportRequest = z
  .object({
    targetType: ReportTargetType,
    targetId: z.uuid(),
    reason: ReportReason,
    detail: z.string().trim().max(1000).optional(),
  })
  .strict();
export type CreateReportRequest = z.infer<typeof CreateReportRequest>;
