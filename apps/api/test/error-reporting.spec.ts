import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERROR_REPORTER, SentryReporter, type ErrorContext, type ErrorReporter } from '../src/infra/errors/error-reporter';
import { scrubEvent } from '../src/infra/errors/scrub';
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { bootApp } from './helpers';

class Recorder implements ErrorReporter {
  calls: { error: unknown; context?: ErrorContext }[] = [];
  capture(error: unknown, context?: ErrorContext) {
    this.calls.push({ error, context });
  }
}

describe('API → error reporter', () => {
  let app: NestFastifyApplication;
  const recorder = new Recorder();
  beforeAll(async () => {
    app = await bootApp({ overrides: [[ERROR_REPORTER, recorder]] });
  });
  afterAll(async () => {
    await app.close();
  });

  it('reports unexpected 5xx with route tag (not the client error details); never 4xx', async () => {
    const spy = vi.spyOn(app.get(CatalogService), 'genres').mockRejectedValueOnce(new Error('db exploded'));
    const res = await app.inject({ method: 'GET', url: '/v1/genres?lang=vi' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal error' } }); // nothing leaked
    expect(recorder.calls).toHaveLength(1);
    expect((recorder.calls[0]!.error as Error).message).toBe('db exploded');
    expect(recorder.calls[0]!.context?.tags).toEqual({ process: 'api', method: 'GET', route: '/v1/genres' });
    spy.mockRestore();

    await app.inject({ method: 'GET', url: '/v1/stories/not-a-story' }); // 404
    await app.inject({ method: 'GET', url: '/v1/search?q=' }); // 400
    await app.inject({ method: 'GET', url: '/v1/me' }); // 401
    expect(recorder.calls).toHaveLength(1);
  });
});

describe('Sentry SDK end to end (local fake ingest)', () => {
  let server: Server;
  const received: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        received.push((req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8'));
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    Sentry.init({ dsn: `http://publickey@127.0.0.1:${port}/1`, tracesSampleRate: 0, beforeSend: scrubEvent });
  });
  afterAll(async () => {
    await Sentry.close(1000);
    server.close();
  });

  it('sends the captured error with tags + user id, scrubbed', async () => {
    Sentry.getCurrentScope().setContext('note', { email: 'x' }); // unrelated context is fine
    new SentryReporter().capture(new Error('payment for mai@example.com failed'), {
      tags: { process: 'worker', job: 'reconcile-stores' },
      userId: 'user-123',
    });
    await Sentry.flush(2000);
    const envelope = received.join('\n');
    expect(envelope).toContain('payment for [email] failed');
    expect(envelope).not.toContain('mai@example.com');
    expect(envelope).toContain('"job":"reconcile-stores"');
    expect(envelope).toContain('"id":"user-123"');
  });
});
