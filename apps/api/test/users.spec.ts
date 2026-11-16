import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import sharp from 'sharp';
import { RedisService } from '../src/infra/redis/redis.service';
import { StorageService } from '../src/infra/storage/storage.service';
import { bearer, bootApp, resetData } from './helpers';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await bootApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
  await app.get(RedisService).cache.flushdb();
});

const db = () => app.get(DbService).write;
let seq = 0;

async function member(opts: { guest?: boolean; name?: string } = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: `device-users-${++seq}-x` } });
  const id = res.json().user.id as string;
  if (!opts.guest) {
    await db()
      .update(users)
      .set({ isGuest: false, displayName: opts.name ?? `User ${seq}`, username: `user${seq}` })
      .where(eq(users.id, id));
  }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(res.json().accessToken), ...(payload ? { payload } : {}) });
  return { id, call };
}

const flush = () => app.get(RedisService).cache.flushdb();

describe('profile', () => {
  it('edit name / birthday / gender; username once per 30 days and unique', async () => {
    const a = await member();
    const b = await member();
    const res = await a.call('PATCH', '/v1/me/profile', {
      displayName: 'Mai Anh',
      birthday: '2001-05-04',
      gender: 'female',
      username: 'Mai.Anh',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      displayName: 'Mai Anh',
      username: 'mai.anh',
      birthday: '2001-05-04',
      gender: 'female',
      usernameChangeableAt: expect.any(String),
    });
    expect((await a.call('PATCH', '/v1/me/profile', { username: 'mai.anh2' })).statusCode).toBe(409); // too soon
    expect((await b.call('PATCH', '/v1/me/profile', { username: 'MAI.ANH' })).json().error.code).toBe('USERNAME_TAKEN');
    expect((await a.call('PATCH', '/v1/me/profile', { evil: true })).statusCode).toBe(400); // strict
    expect((await a.call('PATCH', '/v1/me/profile', { username: 'a b' })).statusCode).toBe(400);
  });

  it('public profile: counts, CDN-cacheable, no private fields; hidden users 404', async () => {
    const a = await member({ name: 'Alice' });
    const b = await member();
    await b.call('PUT', `/v1/me/follows/${a.id}`);
    const res = await app.inject({ method: 'GET', url: `/v1/users/${a.id}` });
    expect(res.headers['cache-control']).toContain('public');
    expect(res.json()).toMatchObject({ displayName: 'Alice', followers: 1, following: 0, premium: null, badgeIds: [] });
    expect(res.json()).not.toHaveProperty('birthday');
    await db().update(users).set({ status: 'suspended' }).where(eq(users.id, a.id));
    await flush();
    expect((await app.inject({ method: 'GET', url: `/v1/users/${a.id}` })).statusCode).toBe(404);
  });
});

describe('follows & blocks', () => {
  it('follow / unfollow, lists with cursor, relation; guests and self refused', async () => {
    const star = await member();
    const fans = [await member(), await member(), await member()];
    for (const f of fans) expect((await f.call('PUT', `/v1/me/follows/${star.id}`)).statusCode).toBe(204);
    await fans[0]!.call('PUT', `/v1/me/follows/${star.id}`); // idempotent

    const first = (await app.inject({ method: 'GET', url: `/v1/users/${star.id}/followers?limit=2` })).json();
    expect(first.items.map((u: { id: string }) => u.id)).toEqual([fans[2]!.id, fans[1]!.id]); // newest first
    const rest = (await app.inject({ method: 'GET', url: `/v1/users/${star.id}/followers?cursor=${first.nextCursor}` })).json();
    expect(rest.items.map((u: { id: string }) => u.id)).toEqual([fans[0]!.id]);
    expect((await app.inject({ method: 'GET', url: `/v1/users/${fans[0]!.id}/following` })).json().items).toHaveLength(1);

    expect((await fans[0]!.call('GET', `/v1/me/relations/${star.id}`)).json()).toEqual({
      following: true,
      blocked: false,
      blockedMe: false,
    });
    await fans[0]!.call('DELETE', `/v1/me/follows/${star.id}`);
    expect((await fans[0]!.call('GET', `/v1/me/relations/${star.id}`)).json().following).toBe(false);

    expect((await star.call('PUT', `/v1/me/follows/${star.id}`)).statusCode).toBe(400);
    expect((await (await member({ guest: true })).call('PUT', `/v1/me/follows/${star.id}`)).statusCode).toBe(403);
    expect((await star.call('PUT', '/v1/me/follows/00000000-0000-7000-8000-000000000000')).statusCode).toBe(404);
  });

  it('block ends follows both ways and stops new ones; block list; unblock', async () => {
    const a = await member();
    const b = await member();
    await a.call('PUT', `/v1/me/follows/${b.id}`);
    await b.call('PUT', `/v1/me/follows/${a.id}`);
    expect((await a.call('PUT', `/v1/me/blocks/${b.id}`)).statusCode).toBe(204);
    expect((await a.call('GET', `/v1/me/relations/${b.id}`)).json()).toEqual({
      following: false,
      blocked: true,
      blockedMe: false,
    });
    expect((await b.call('GET', `/v1/me/relations/${a.id}`)).json()).toMatchObject({ following: false, blockedMe: true });
    expect((await b.call('PUT', `/v1/me/follows/${a.id}`)).statusCode).toBe(403);
    const list = (await a.call('GET', '/v1/me/blocks')).json();
    expect(list.items).toEqual([expect.objectContaining({ id: b.id, displayName: expect.any(String) })]);

    await a.call('DELETE', `/v1/me/blocks/${b.id}`);
    expect((await a.call('GET', '/v1/me/blocks')).json().items).toHaveLength(0);
    expect((await b.call('PUT', `/v1/me/follows/${a.id}`)).statusCode).toBe(204);
  });
});

describe('avatar (presigned PUT → complete)', () => {
  const jpeg = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } })
      .jpeg()
      .toBuffer();

  async function upload(m: Awaited<ReturnType<typeof member>>, file: Buffer) {
    const t = (await m.call('POST', '/v1/me/avatar', { contentType: 'image/jpeg', size: file.length })).json();
    expect((await fetch(t.uploadUrl, { method: 'PUT', body: new Uint8Array(file), headers: t.headers })).status).toBe(200);
    return { t, done: await m.call('POST', `/v1/me/avatar/${t.id}/complete`) };
  }

  it('re-encodes a 256 px square, sets the avatar, deletes the previous one; single use; guests refused', async () => {
    const m = await member();
    const first = await upload(m, await jpeg(800, 500));
    expect(first.done.statusCode).toBe(200);
    const url1 = first.done.json().avatarUrl as string;
    expect(url1).toMatch(new RegExp(`/media/avatars/${m.id}/[0-9a-f-]+\\.webp$`));
    const img = await sharp(Buffer.from(await (await fetch(url1)).arrayBuffer())).metadata();
    expect(img).toMatchObject({ format: 'webp', width: 256, height: 256 });
    expect((await app.inject({ method: 'GET', url: `/v1/users/${m.id}` })).json().avatarUrl).toBe(url1);

    const second = await upload(m, await jpeg(300, 300));
    const url2 = second.done.json().avatarUrl as string;
    expect(url2).not.toBe(url1);
    const storage = app.get(StorageService);
    const key = (u: string) => new URL(u).pathname.replace(/^\/storyzio-test\//, '');
    expect(await storage.head(key(url1))).toBeNull();
    expect((await m.call('POST', `/v1/me/avatar/${second.t.id}/complete`)).statusCode).toBe(404);

    const guest = await member({ guest: true });
    expect((await guest.call('POST', '/v1/me/avatar', { contentType: 'image/jpeg', size: 10 })).statusCode).toBe(403);
    expect((await m.call('POST', '/v1/me/avatar', { contentType: 'image/gif', size: 10 })).statusCode).toBe(400);
  });

  it('rejects a file that is not an image', async () => {
    const m = await member();
    const { done } = await upload(m, Buffer.from('not an image at all, just text'));
    expect(done.statusCode).toBe(400);
  });
});
