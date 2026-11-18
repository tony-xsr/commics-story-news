import { z } from 'zod';

// Admin uploads: ticket → browser PUTs straight to object storage → complete (server validates + re-encodes).

export const UploadPurpose = z.enum(['cover', 'comic_page', 'sticker']);
export type UploadPurpose = z.infer<typeof UploadPurpose>;

export const UploadContentType = z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
export type UploadContentType = z.infer<typeof UploadContentType>;

/** Max upload size per purpose (bytes). Long webtoon strips are big; covers are not. */
export const UPLOAD_MAX_BYTES: Record<UploadPurpose, number> = {
  cover: 10 * 1024 * 1024,
  comic_page: 30 * 1024 * 1024,
  sticker: 5 * 1024 * 1024,
};

export const UploadRequest = z
  .object({ purpose: UploadPurpose, contentType: UploadContentType, size: z.number().int().positive() })
  .strict()
  .refine((r) => r.size <= UPLOAD_MAX_BYTES[r.purpose], { path: ['size'], message: 'File is too large' });
export type UploadRequest = z.infer<typeof UploadRequest>;

export const UploadTicket = z.object({
  id: z.uuid(),
  uploadUrl: z.url(),
  method: z.literal('PUT'),
  /** Headers the browser must send with the PUT (they are part of the signature). */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type UploadTicket = z.infer<typeof UploadTicket>;

export const MediaFile = z.object({ url: z.url(), width: z.number().int(), height: z.number().int() });
export type MediaFile = z.infer<typeof MediaFile>;

/** A comic page may come back as several files (tall strips are sliced), in reading order. */
export const UploadResult = z.object({ files: z.array(MediaFile).min(1) });
export type UploadResult = z.infer<typeof UploadResult>;
