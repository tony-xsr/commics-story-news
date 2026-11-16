import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAuditLogs } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { StorageService } from '../src/infra/storage/storage.service';
import { adminClient } from './admin-helpers';
import { bootApp, resetData } from './helpers';

// Runs against the local SeaweedFS (docker compose up -d s3) — the same S3 API as Cloudflare R2.

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
});

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .png()
    .toBuffer();

type Admin = Awaited<ReturnType<typeof adminClient>>;

async function ticket(admin: Admin, body: object) {
  const res = await admin.call('POST', '/v1/admin/uploads', body);
  return { res, t: res.json() as { id: string; uploadUrl: string; headers: Record<string, string> } };
}

/** What the browser does: PUT the bytes to the presigned URL with the signed headers. */
const put = (url: string, body: Buffer, headers: Record<string, string>) =>
  fetch(url, { method: 'PUT', body: new Uint8Array(body), headers });

const keyOf = (url: string) => new URL(url).pathname.replace(/^\/storyzio-test\//, '');

describe('admin uploads (presigned PUT → complete)', () => {
  it('cover: uploads, re-encodes to WebP ≤ 600 px, serves publicly, removes the raw file, audits', async () => {
    const cm = await adminClient(app, 'content_manager');
    const file = await png(1200, 1800);
    const { res, t } = await ticket(cm, { purpose: 'cover', contentType: 'image/png', size: file.length });
    expect(res.statusCode).toBe(201);
    expect(t.uploadUrl).toContain('X-Amz-Signature');

    expect((await put(t.uploadUrl, file, t.headers)).status).toBe(200);
    const done = await cm.call('POST', `/v1/admin/uploads/${t.id}/complete`);
    expect(done.statusCode).toBe(200);
    const [out] = done.json().files;
    expect(out).toMatchObject({ width: 600, height: 900 });
    expect(out.url).toMatch(/\/media\/covers\/[0-9a-f-]+\.webp$/);

    const served = await fetch(out.url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format).toBe('webp');

    const storage = app.get(StorageService);
    expect(await storage.head(`tmp/${t.id}`)).toBeNull();
    const audit = await app
      .get(DbService)
      .write.select()
      .from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'media.upload'), eq(adminAuditLogs.entityId, t.id)));
    expect(audit).toHaveLength(1);
    await storage.delete(keyOf(out.url));
  });

  it('comic page: a tall strip comes back as ordered slices', async () => {
    const cm = await adminClient(app, 'content_manager');
    const file = await png(720, 5000);
    const { t } = await ticket(cm, { purpose: 'comic_page', contentType: 'image/png', size: file.length });
    await put(t.uploadUrl, file, t.headers);
    const done = await cm.call('POST', `/v1/admin/uploads/${t.id}/complete`);
    const files = done.json().files as { url: string; width: number; height: number }[];
    expect(files.map((f) => f.height)).toEqual([1600, 1600, 1600, 200]);
    expect(files.map((f) => f.url.split('/').pop())).toEqual([1, 2, 3, 4].map((n) => `${t.id}-${n}.webp`));
    await Promise.all(files.map((f) => app.get(StorageService).delete(keyOf(f.url))));
  });

  it('the signature binds content-type and exact size (a different or bigger file is rejected by storage)', async () => {
    const cm = await adminClient(app, 'content_manager');
    const file = await png(100, 100);
    const { t } = await ticket(cm, { purpose: 'cover', contentType: 'image/png', size: file.length });
    const bigger = Buffer.concat([file, Buffer.alloc(1024)]);
    expect((await put(t.uploadUrl, bigger, t.headers)).status).toBe(403);
    expect((await put(t.uploadUrl, file, { 'content-type': 'text/html' })).status).toBe(403);
  });

  it('a non-image disguised as PNG is rejected and nothing is published', async () => {
    const cm = await adminClient(app, 'content_manager');
    const file = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    const { t } = await ticket(cm, { purpose: 'cover', contentType: 'image/png', size: file.length });
    await put(t.uploadUrl, file, t.headers);
    const done = await cm.call('POST', `/v1/admin/uploads/${t.id}/complete`);
    expect(done.statusCode).toBe(400);
    expect(await app.get(StorageService).head(`tmp/${t.id}`)).toBeNull();
    expect(await app.get(StorageService).head(`media/covers/${t.id}.webp`)).toBeNull();
  });

  it('tickets are single-use and bound to the admin who requested them', async () => {
    const cm = await adminClient(app, 'content_manager');
    const other = await adminClient(app, 'content_manager');
    const file = await png(200, 300);
    const { t } = await ticket(cm, { purpose: 'cover', contentType: 'image/png', size: file.length });
    await put(t.uploadUrl, file, t.headers);
    expect((await other.call('POST', `/v1/admin/uploads/${t.id}/complete`)).statusCode).toBe(404);
    // The other admin's attempt burned the ticket (GETDEL) — and the raw file was cleaned up.
    expect((await cm.call('POST', `/v1/admin/uploads/${t.id}/complete`)).statusCode).toBe(404);
  });

  it('completing before the file is uploaded fails cleanly', async () => {
    const cm = await adminClient(app, 'content_manager');
    const { t } = await ticket(cm, { purpose: 'cover', contentType: 'image/png', size: 1000 });
    expect((await cm.call('POST', `/v1/admin/uploads/${t.id}/complete`)).statusCode).toBe(400);
  });

  it('validates the request: size limits, image types only, permission', async () => {
    const cm = await adminClient(app, 'content_manager');
    const bad = [
      { purpose: 'cover', contentType: 'image/png', size: 11 * 1024 * 1024 },
      { purpose: 'cover', contentType: 'image/svg+xml', size: 100 },
      { purpose: 'cover', contentType: 'text/html', size: 100 },
      { purpose: 'avatar', contentType: 'image/png', size: 100 },
      { purpose: 'cover', contentType: 'image/png', size: 0 },
    ];
    for (const body of bad) expect((await cm.call('POST', '/v1/admin/uploads', body)).statusCode).toBe(400);
    expect(
      (await cm.call('POST', '/v1/admin/uploads', { purpose: 'comic_page', contentType: 'image/png', size: 25e6 }))
        .statusCode,
    ).toBe(201);

    const support = await adminClient(app, 'support');
    const res = await support.call('POST', '/v1/admin/uploads', {
      purpose: 'cover',
      contentType: 'image/png',
      size: 9,
    });
    expect(res.statusCode).toBe(403);
    const anon = await app.inject({ method: 'POST', url: '/v1/admin/uploads', payload: {} });
    expect(anon.statusCode).toBe(401);
  });
});
