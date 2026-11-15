import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  UPLOAD_MAX_BYTES,
  type UploadPurpose,
  type UploadRequest,
  type UploadResult,
  type UploadTicket,
} from '@storyzio/contracts';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StorageService } from '../../infra/storage/storage.service';
import { AuditService } from '../admin/audit.service';
import type { AdminContext } from '../admin/permissions';
import { processComicPage, processCover, processSticker, type ProcessedImage } from './image-processing';

const TICKET_TTL_SEC = 15 * 60;
/** Per admin per hour — a big chapter is ~100 pages; this stops a stolen session from filling the bucket. */
const UPLOADS_PER_HOUR = 2000;

type Ticket = { adminId: string; purpose: UploadPurpose; contentType: string; size: number };

const ticketKey = (id: string) => `upload:${id}`;
/** Raw uploads live under tmp/ (bucket lifecycle rule deletes leftovers after 1 day). */
const tmpKey = (id: string) => `tmp/${id}`;

/**
 * Upload flow: (1) `create` hands out a presigned PUT for tmp/<id> bound to content-type and exact size,
 * (2) the browser uploads directly to storage (no file bytes through the API/Cloudflare Tunnel),
 * (3) `complete` downloads it, validates the real format, re-encodes to WebP into media/, and deletes the raw file.
 * Only re-encoded output is ever public — the raw upload is never served.
 */
@Injectable()
export class UploadsService {
  constructor(
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async create(admin: AdminContext, req: UploadRequest): Promise<UploadTicket> {
    if (!this.storage.enabled) throw new AppError('INTERNAL', 'Uploads are not configured');
    await this.rateLimit.consume('admin-upload', admin.adminId, UPLOADS_PER_HOUR, 3600);
    const id = randomUUID();
    const ticket: Ticket = {
      adminId: admin.adminId,
      purpose: req.purpose,
      contentType: req.contentType,
      size: req.size,
    };
    await this.redis.state.set(ticketKey(id), JSON.stringify(ticket), 'EX', TICKET_TTL_SEC);
    const uploadUrl = await this.storage.presignPut(tmpKey(id), req.contentType, req.size, TICKET_TTL_SEC);
    return {
      id,
      uploadUrl,
      method: 'PUT',
      headers: { 'content-type': req.contentType },
      expiresAt: new Date(Date.now() + TICKET_TTL_SEC * 1000).toISOString(),
    };
  }

  async complete(admin: AdminContext, id: string): Promise<UploadResult> {
    // Single use: GETDEL so a ticket can't be completed twice (or raced).
    const raw = await this.redis.state.getdel(ticketKey(id));
    const ticket = raw ? (JSON.parse(raw) as Ticket) : null;
    if (!ticket || ticket.adminId !== admin.adminId) throw new AppError('NOT_FOUND', 'Upload not found or expired');

    try {
      const head = await this.storage.head(tmpKey(id));
      if (!head) throw new AppError('VALIDATION', 'File was not uploaded');
      if (head.size > UPLOAD_MAX_BYTES[ticket.purpose]) throw new AppError('VALIDATION', 'File is too large');

      const input = await this.storage.get(tmpKey(id));
      const images: ProcessedImage[] =
        ticket.purpose === 'cover'
          ? [await processCover(input)]
          : ticket.purpose === 'sticker'
            ? [await processSticker(input)]
            : await processComicPage(input);

      const dir = { cover: 'covers', sticker: 'stickers', comic_page: 'pages' }[ticket.purpose];
      const keys = images.map((_, i) => `media/${dir}/${id}${images.length > 1 ? `-${i + 1}` : ''}.webp`);
      await Promise.all(images.map((img, i) => this.storage.put(keys[i]!, img.buffer, 'image/webp')));

      await this.audit.record(admin, {
        action: 'media.upload',
        entity: 'media',
        entityId: id,
        after: { purpose: ticket.purpose, keys, bytes: head.size },
      });
      return {
        files: images.map((img, i) => ({
          url: this.storage.publicUrl(keys[i]!),
          width: img.width,
          height: img.height,
        })),
      };
    } finally {
      await this.storage.delete(tmpKey(id)).catch(() => undefined);
    }
  }
}
