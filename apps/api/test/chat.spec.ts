import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CHAT_SOCKET_EVENT, type ChatEvent } from '@storyzio/contracts';
import { eq } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../src/config/env';
import { users } from '../src/db/schema';
import { DbService } from '../src/infra/db/db.service';
import { PUSH_SENDER, type PushMessage, type PushSender } from '../src/infra/push/push';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokensService } from '../src/modules/auth/tokens.service';
import { MonitorReporter } from '../src/infra/monitor/monitor-reporter';
import { REALTIME_PATH, RealtimeServer } from '../src/realtime/realtime.server';
import { bearer, bootApp, resetData } from './helpers';

class RecordingPush implements PushSender {
  sent: PushMessage[] = [];
  async send(messages: PushMessage[]) {
    this.sent.push(...messages);
    return messages.map(() => ({ ok: true as const }));
  }
}

let app: NestFastifyApplication;
let realtime: RealtimeServer;
let port: number;
const push = new RecordingPush();

beforeAll(async () => {
  app = await bootApp({ overrides: [[PUSH_SENDER, push]] });
  // Same token keys as the API under test (dev/test keys are generated per process).
  realtime = new RealtimeServer(app.get<Env>(ENV), app.get(TokensService), app.get(SessionsService), app.get(MonitorReporter));
  port = await realtime.start(0);
});
afterAll(async () => {
  await realtime.onApplicationShutdown();
  await app.close();
});
beforeEach(async () => {
  await resetData(app);
  push.sent.length = 0;
});

const db = () => app.get(DbService).write;
let seq = 0;

async function member(opts: { guest?: boolean } = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { deviceId: `device-chat-${++seq}-x` } });
  const id = res.json().user.id as string;
  const token = res.json().accessToken as string;
  if (!opts.guest) await db().update(users).set({ isGuest: false, displayName: `User ${seq}` }).where(eq(users.id, id));
  await app.inject({
    method: 'PUT',
    url: '/v1/me/push-tokens',
    headers: bearer(token),
    payload: { token: `chat${seq}000000000001:APA91b${'Q'.repeat(120)}`, platform: 'ios' },
  });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });
  return { id, token, call };
}

const say = (m: Awaited<ReturnType<typeof member>>, conv: string, body: string, clientId = `c-${Math.random().toString(36).slice(2, 12)}`) =>
  m.call('POST', `/v1/me/conversations/${conv}/messages`, { body, clientId });

function socketOf(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(`http://127.0.0.1:${port}`, { path: REALTIME_PATH, transports: ['websocket'], auth: { token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const nextEvent = (s: Socket) =>
  new Promise<ChatEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no event')), 3000);
    s.once(CHAT_SOCKET_EVENT, (e: ChatEvent) => {
      clearTimeout(timer);
      resolve(e);
    });
  });

describe('conversations & messages', () => {
  it('open (idempotent), send (idempotent per clientId), history, unread, read, list, clear', async () => {
    const a = await member();
    const b = await member();
    const conv = (await a.call('POST', '/v1/me/conversations', { userId: b.id })).json();
    expect(conv).toMatchObject({ peer: { id: b.id }, lastMessage: null, unread: 0 });
    expect((await a.call('POST', '/v1/me/conversations', { userId: b.id })).json().id).toBe(conv.id);
    expect((await b.call('GET', '/v1/me/conversations')).json().items).toEqual([]); // nothing sent yet

    const first = await say(a, conv.id, 'chào bạn', 'client-0001');
    expect(first.statusCode).toBe(201);
    const retry = await say(a, conv.id, 'chào bạn', 'client-0001');
    expect(retry.json().id).toBe(first.json().id);
    await say(b, conv.id, 'hi!');
    await say(a, conv.id, 'đọc truyện gì đó?');

    const bList = (await b.call('GET', '/v1/me/conversations')).json().items;
    expect(bList).toEqual([expect.objectContaining({ id: conv.id, peer: expect.objectContaining({ id: a.id }), unread: 1 })]);
    expect(bList[0].lastMessage.body).toBe('đọc truyện gì đó?');
    expect((await b.call('GET', '/v1/me/chat/unread-count')).json()).toEqual({ count: 1 });

    const history = (await b.call('GET', `/v1/me/conversations/${conv.id}/messages?limit=2`)).json();
    expect(history.items.map((m: { body: string }) => m.body)).toEqual(['đọc truyện gì đó?', 'hi!']);
    expect(history.hasMore).toBe(true);
    const older = (await b.call('GET', `/v1/me/conversations/${conv.id}/messages?before=${history.items[1].id}`)).json();
    expect(older.items.map((m: { body: string }) => m.body)).toEqual(['chào bạn']);

    await b.call('POST', `/v1/me/conversations/${conv.id}/read`);
    expect((await b.call('GET', '/v1/me/chat/unread-count')).json().count).toBe(0);

    await b.call('DELETE', `/v1/me/conversations/${conv.id}`);
    expect((await b.call('GET', '/v1/me/conversations')).json().items).toEqual([]);
    expect((await b.call('GET', `/v1/me/conversations/${conv.id}/messages`)).json().items).toEqual([]);
    await say(a, conv.id, 'còn đó không?');
    const back = (await b.call('GET', '/v1/me/conversations')).json().items;
    expect(back).toHaveLength(1); // a new message brings it back, without the old history
    expect((await b.call('GET', `/v1/me/conversations/${conv.id}/messages`)).json().items).toHaveLength(1);

    const stranger = await member();
    expect((await stranger.call('GET', `/v1/me/conversations/${conv.id}/messages`)).statusCode).toBe(404);
    expect((await say(stranger, conv.id, 'xin chào')).statusCode).toBe(404);
  });

  it('blocks, DM policy, guests, links and banned words', async () => {
    const a = await member();
    const b = await member();
    const conv = (await a.call('POST', '/v1/me/conversations', { userId: b.id })).json();
    expect((await say(a, conv.id, 'xem https://scam.example')).statusCode).toBe(400);

    await b.call('PUT', `/v1/me/blocks/${a.id}`);
    expect((await say(a, conv.id, 'hello')).statusCode).toBe(403);
    expect((await a.call('POST', '/v1/me/conversations', { userId: b.id })).statusCode).toBe(403);
    expect((await b.call('GET', '/v1/me/conversations')).json().items).toEqual([]);

    const c = await member();
    await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: bearer(c.token), payload: { dmPolicy: 'following' } });
    const d = await member();
    expect((await d.call('POST', '/v1/me/conversations', { userId: c.id })).statusCode).toBe(403);
    await c.call('PUT', `/v1/me/follows/${d.id}`);
    expect((await d.call('POST', '/v1/me/conversations', { userId: c.id })).statusCode).toBe(200);

    const guest = await member({ guest: true });
    expect((await guest.call('POST', '/v1/me/conversations', { userId: c.id })).statusCode).toBe(403);
    expect((await a.call('POST', '/v1/me/conversations', { userId: a.id })).statusCode).toBe(400);
  });
});

describe('realtime', () => {
  it('delivers new messages and read receipts to both users over Socket.IO; pushes the peer once per burst', async () => {
    const a = await member();
    const b = await member();
    const conv = (await a.call('POST', '/v1/me/conversations', { userId: b.id })).json();
    const [sa, sb] = await Promise.all([socketOf(a.token), socketOf(b.token)]);
    try {
      const [ea, eb] = [nextEvent(sa), nextEvent(sb)];
      await say(a, conv.id, 'realtime!');
      expect((await eb).type).toBe('message');
      expect(await ea).toMatchObject({ type: 'message', message: { body: 'realtime!', senderId: a.id } });

      const receipt = nextEvent(sa);
      await b.call('POST', `/v1/me/conversations/${conv.id}/read`);
      expect(await receipt).toMatchObject({ type: 'read', conversationId: conv.id, userId: b.id });

      await say(a, conv.id, 'second');
      await new Promise((r) => setTimeout(r, 100)); // pushes are sent after the response
      expect(push.sent.filter((p) => p.data?.conversationId === conv.id)).toHaveLength(1);
      expect(push.sent[0]).toMatchObject({ body: 'realtime!' });
    } finally {
      sa.close();
      sb.close();
    }
  });

  it('refuses sockets without a valid token', async () => {
    await expect(socketOf('not-a-token')).rejects.toThrow('UNAUTHENTICATED');
  });
});

