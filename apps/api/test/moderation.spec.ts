import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAuditLogs, comments, reports, users } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { adminClient } from './admin-helpers';
import { createChapters, createStory, seedGenres } from './factories';
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
  await seedGenres(app);
});

const db = () => app.get(DbService).write;
let seq = 0;

async function member(name = `Reader ${++seq}`) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/guest',
    payload: { deviceId: `device-mod-${++seq}-x` },
  });
  const id = res.json().user.id as string;
  await db()
    .update(users)
    .set({ isGuest: false, displayName: name, createdAt: new Date(Date.now() - 48 * 3600_000) })
    .where(eq(users.id, id));
  return { id, name, token: res.json().accessToken as string };
}

type Member = Awaited<ReturnType<typeof member>>;
const as = (u: Member, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: bearer(u.token), ...(payload ? { payload } : {}) });

const comment = async (u: Member, storyId: string, body: string, extra: object = {}) =>
  (await as(u, 'POST', '/v1/comments', { storyId, body, ...extra })).json() as { id: string };

const report = (u: Member, targetType: string, targetId: string, reason = 'spam') =>
  as(u, 'POST', '/v1/me/reports', { targetType, targetId, reason });

const publicList = async (storyId: string, chapterId?: string) =>
  (
    await app.inject({
      method: 'GET',
      url: `/v1/stories/${storyId}/comments${chapterId ? `?chapterId=${chapterId}` : ''}`,
    })
  ).json().items as { id: string }[];

async function scenario() {
  const story = await createStory(app, { title: 'Kiếm Hiệp Ký' });
  const [chapter] = await createChapters(app, story, 2);
  const author = await member('Kẻ Phá Đám');
  const reporters = await Promise.all([member(), member(), member(), member()]);
  const bad = await comment(author, story.id, 'quảng cáo rác', { chapterId: chapter!.id });
  const ok = await comment(author, story.id, 'bình luận bình thường');
  for (const r of reporters) await report(r, 'comment', bad.id, r === reporters[0] ? 'harassment' : 'spam');
  await report(reporters[0]!, 'comment', ok.id);
  await report(reporters[0]!, 'story', story.id, 'copyright');
  await report(reporters[1]!, 'user', author.id, 'harassment');
  return { story, chapter: chapter!, author, reporters, bad, ok };
}

describe('report queue', () => {
  it('groups open reports by target, most reported first, with a preview and reason breakdown', async () => {
    const { story, chapter, author, bad } = await scenario();
    const mod = await adminClient(app, 'moderator');
    const res = await mod.call('GET', '/v1/admin/reports');
    expect(res.statusCode).toBe(200);
    const { items, hasMore } = res.json();
    expect(hasMore).toBe(false);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      targetType: 'comment',
      targetId: bad.id,
      reportCount: 4,
      reasons: { harassment: 1, spam: 3 },
      target: {
        kind: 'comment',
        body: 'quảng cáo rác',
        status: 'pending', // auto-hidden at 3 reports
        author: { id: author.id, displayName: 'Kẻ Phá Đám', mutedUntil: null },
        story: { id: story.id, title: 'Kiếm Hiệp Ký' },
        chapterNumber: chapter.number,
      },
    });
    const kinds = items.map((i: { target: { kind: string } }) => i.target.kind).sort();
    expect(kinds).toEqual(['comment', 'comment', 'story', 'user']);

    const onlyUsers = (await mod.call('GET', '/v1/admin/reports?targetType=user')).json().items;
    expect(onlyUsers).toEqual([expect.objectContaining({ target: expect.objectContaining({ kind: 'user' }) })]);
    const paged = (await mod.call('GET', '/v1/admin/reports?limit=3&page=2')).json();
    expect(paged).toMatchObject({ page: 2, hasMore: false });
    expect(paged.items).toHaveLength(1);

    const detail = (await mod.call('GET', `/v1/admin/reports/comment/${bad.id}`)).json();
    expect(detail.target).toMatchObject({ kind: 'comment', body: 'quảng cáo rác' });
    expect(detail.items).toHaveLength(4);
    expect(detail.items[0]).toMatchObject({ status: 'open', reporter: { displayName: expect.any(String) } });
    expect((await mod.call('GET', `/v1/admin/reports/thing/${bad.id}`)).statusCode).toBe(400);
  });

  it('dismiss: no violation — the auto-hidden comment comes back, reports are closed, audited', async () => {
    const { story, chapter, bad } = await scenario();
    expect((await publicList(story.id, chapter.id)).map((c) => c.id)).not.toContain(bad.id);
    const mod = await adminClient(app, 'moderator');
    const res = await mod.call('POST', '/v1/admin/reports/resolve', {
      targetType: 'comment',
      targetId: bad.id,
      action: 'dismiss',
      note: 'Không vi phạm',
    });
    expect(res.json()).toEqual({ closed: 4, mutedUntil: null });
    expect((await publicList(story.id, chapter.id)).map((c) => c.id)).toContain(bad.id);
    const rows = await db().select().from(reports).where(eq(reports.targetId, bad.id));
    expect(rows.every((r) => r.status === 'dismissed' && r.resolution === 'dismiss: Không vi phạm')).toBe(true);
    // nothing left to resolve
    const again = await mod.call('POST', '/v1/admin/reports/resolve', {
      targetType: 'comment',
      targetId: bad.id,
      action: 'dismiss',
      note: 'lần hai',
    });
    expect(again.statusCode).toBe(404);
    const [audit] = await db().select().from(adminAuditLogs).where(eq(adminAuditLogs.action, 'report.resolve'));
    expect(audit).toMatchObject({ entity: 'comment', entityId: bad.id, reason: 'Không vi phạm' });
  });

  it('delete + mute: the comment is removed and its author is muted', async () => {
    const { story, author, bad } = await scenario();
    const mod = await adminClient(app, 'moderator');
    const res = await mod.call('POST', '/v1/admin/reports/resolve', {
      targetType: 'comment',
      targetId: bad.id,
      action: 'delete_comment',
      note: 'Spam quảng cáo',
      muteDays: 7,
    });
    expect(res.statusCode).toBe(200);
    const mutedUntil = new Date(res.json().mutedUntil).getTime();
    expect(mutedUntil).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    const [row] = await db().select().from(comments).where(eq(comments.id, bad.id));
    expect(row!.status).toBe('deleted');
    const post = await as(author, 'POST', '/v1/comments', { storyId: story.id, body: 'tôi quay lại' });
    expect(post.statusCode).toBe(403);
  });

  it('rejects comment actions on other targets and mute on stories', async () => {
    const { story } = await scenario();
    const mod = await adminClient(app, 'moderator');
    const base = { targetType: 'story', targetId: story.id, note: 'xem xét' };
    expect((await mod.call('POST', '/v1/admin/reports/resolve', { ...base, action: 'hide_comment' })).statusCode).toBe(
      400,
    );
    expect(
      (await mod.call('POST', '/v1/admin/reports/resolve', { ...base, action: 'resolve', muteDays: 3 })).statusCode,
    ).toBe(400);
    expect((await mod.call('POST', '/v1/admin/reports/resolve', { ...base, action: 'resolve' })).json().closed).toBe(1);
  });

  it('permissions: support can view but not act; content managers and finance see nothing', async () => {
    const { bad } = await scenario();
    const support = await adminClient(app, 'support');
    expect((await support.call('GET', '/v1/admin/reports')).statusCode).toBe(200);
    const act = { targetType: 'comment', targetId: bad.id, action: 'dismiss', note: 'ok ok' };
    expect((await support.call('POST', '/v1/admin/reports/resolve', act)).statusCode).toBe(403);
    for (const role of ['content_manager', 'finance'] as const) {
      expect((await (await adminClient(app, role)).call('GET', '/v1/admin/reports')).statusCode).toBe(403);
    }
    // a user token is never an admin token
    const user = await member();
    expect((await as(user, 'GET', '/v1/admin/reports')).statusCode).toBe(401);
  });
});

describe('comment moderation', () => {
  it('search by text / user / story / status, with open report counts', async () => {
    const { story, author, bad, ok } = await scenario();
    const other = await createStory(app);
    await comment(await member(), other.id, '50% giảm giá_đặc biệt');
    const mod = await adminClient(app, 'moderator');
    const search = async (qs: string) => (await mod.call('GET', `/v1/admin/comments?${qs}`)).json().items;

    expect((await search('q=QUẢNG CÁO')).map((c: { id: string }) => c.id)).toEqual([bad.id]);
    expect(await search('q=%25')).toHaveLength(1); // "%" is literal, not a wildcard
    expect((await search(`userId=${author.id}`)).map((c: { id: string }) => c.id)).toEqual([ok.id, bad.id]);
    expect(await search(`storyId=${story.id}`)).toHaveLength(2);
    const pending = await search('status=pending');
    expect(pending).toEqual([
      expect.objectContaining({ id: bad.id, openReports: 4, story: { id: story.id, title: 'Kiếm Hiệp Ký' } }),
    ]);
  });

  it('bulk hide / restore keeps reply counts right and closes their reports', async () => {
    const story = await createStory(app);
    const a = await member();
    const b = await member();
    const top = await comment(a, story.id, 'top');
    const r1 = await comment(b, story.id, 'reply 1', { parentId: top.id });
    const r2 = await comment(b, story.id, 'reply 2', { parentId: top.id });
    await report(a, 'comment', r1.id);
    const mod = await adminClient(app, 'moderator');

    const hide = await mod.call('POST', '/v1/admin/comments/moderate', {
      ids: [r1.id, r2.id],
      action: 'hide',
      reason: 'Công kích cá nhân',
    });
    expect(hide.json()).toEqual({ changed: 2, reportsClosed: 1 });
    expect((await publicList(story.id))[0]).toMatchObject({ id: top.id, replyCount: 0 });

    const again = await mod.call('POST', '/v1/admin/comments/moderate', {
      ids: [r1.id, r2.id],
      action: 'hide',
      reason: 'lặp lại',
    });
    expect(again.json().changed).toBe(0); // idempotent: counters untouched
    await mod.call('POST', '/v1/admin/comments/moderate', { ids: [r2.id], action: 'restore', reason: 'Xem lại: ổn' });
    expect((await publicList(story.id))[0]).toMatchObject({ replyCount: 1 });

    const audits = await db().select().from(adminAuditLogs).where(eq(adminAuditLogs.entity, 'comment'));
    expect(audits.map((x) => x.action).sort()).toEqual(['comment.hide', 'comment.hide', 'comment.restore']);
    const support = await adminClient(app, 'support');
    const denied = await support.call('POST', '/v1/admin/comments/moderate', {
      ids: [r2.id],
      action: 'delete',
      reason: 'không được',
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('banned words and mutes', () => {
  it('words added in admin are masked in new comments right away; removal stops masking', async () => {
    const story = await createStory(app);
    const u = await member();
    const mod = await adminClient(app, 'moderator');
    expect((await mod.call('POST', '/v1/admin/banned-words', { word: '  Đồ Tồi ' })).json()).toEqual({
      words: ['đồ tồi'],
    });
    expect((await mod.call('POST', '/v1/admin/banned-words', { word: 'a,b' })).statusCode).toBe(400);
    const masked = await as(u, 'POST', '/v1/comments', { storyId: story.id, body: 'Nhân vật này đồ tồi thật' });
    expect(masked.json().body).toBe('Nhân vật này ****** thật');

    const removed = await mod.call('DELETE', `/v1/admin/banned-words/${encodeURIComponent('đồ tồi')}`);
    expect(removed.json()).toEqual({ words: [] });
    const plain = await as(u, 'POST', '/v1/comments', { storyId: story.id, body: 'đồ tồi' });
    expect(plain.json().body).toBe('đồ tồi');
  });

  it('mute / unmute from the user page (users.moderate), visible in user 360', async () => {
    const story = await createStory(app);
    const u = await member();
    const support = await adminClient(app, 'support');
    const res = await support.call('POST', `/v1/admin/users/${u.id}/mute`, { days: 3, reason: 'Spam liên tục' });
    expect(res.statusCode).toBe(200);
    expect((await as(u, 'POST', '/v1/comments', { storyId: story.id, body: 'hi' })).statusCode).toBe(403);
    const detail = (await support.call('GET', `/v1/admin/users/${u.id}`)).json();
    expect(detail.user.mutedUntil).toBe(res.json().mutedUntil);

    await support.call('POST', `/v1/admin/users/${u.id}/mute`, { days: 0, reason: 'Đã cam kết' });
    expect((await as(u, 'POST', '/v1/comments', { storyId: story.id, body: 'hi' })).statusCode).toBe(201);
    const audits = await db().select().from(adminAuditLogs).where(eq(adminAuditLogs.entityId, u.id));
    // (+ a user.view row: profile views are logged too — B6)
    expect(audits.map((a) => a.action).filter((a) => a !== 'user.view').sort()).toEqual(['user.mute', 'user.unmute']);

    const cm = await adminClient(app, 'content_manager');
    expect(
      (await cm.call('POST', `/v1/admin/users/${u.id}/mute`, { days: 1, reason: 'không có quyền' })).statusCode,
    ).toBe(403);
  });

  it('dashboard shows the moderation backlog', async () => {
    await scenario();
    const mod = await adminClient(app, 'moderator');
    expect((await mod.call('GET', '/v1/admin/dashboard')).json().moderation).toEqual({
      openReports: 7,
      pendingComments: 1,
    });
  });
});
