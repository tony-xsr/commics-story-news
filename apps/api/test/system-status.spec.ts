import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminClient } from './admin-helpers';
import { bootApp, resetData } from './helpers';

let app: NestFastifyApplication;

beforeAll(async () => {
  Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_status', STRIPE_WEBHOOK_SECRET: 'whsec_status_secret' });
  app = await bootApp();
});
// Admin emails restart at `<role>-1@…` in every file: start from a clean DB like the other e2e files.
beforeEach(async () => {
  await resetData(app);
});
afterAll(async () => {
  await app.close();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

type Check = { key: string; status: string; missing: string[]; summary: string; fix: string };

describe('admin system status', () => {
  it('reports live dependencies, configured and missing integrations — names only, never secret values', async () => {
    const admin = await adminClient(app, 'super_admin');
    const res = await admin.call('GET', '/v1/admin/system/status');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const by = new Map<string, Check>(body.checks.map((c: Check) => [c.key, c]));

    expect(by.get('database')?.status).toBe('ok');
    expect(by.get('redis')?.status).toBe('ok');
    expect(by.get('storage')?.status).toBe('ok'); // test SeaweedFS bucket
    expect(by.get('stripe')).toMatchObject({ status: 'ok', missing: [] });
    expect(by.get('stripe')?.summary).toContain('Test mode');
    // Not configured in tests → red, with the variables to set.
    expect(by.get('sentry')).toMatchObject({ status: 'missing', missing: ['SENTRY_DSN'] });
    expect(by.get('push')?.status).toBe('missing');
    expect(by.get('push')?.missing).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
    expect(by.get('email')?.status).toBe('missing');
    expect(by.get('db-backup')).toMatchObject({ status: 'missing', group: 'operations' });
    expect(by.get('db-backup')?.missing).toContain('BACKUP_S3_PREFIX');
    for (const c of body.checks as Check[]) {
      expect(['ok', 'warning', 'missing', 'error']).toContain(c.status);
      if (c.status === 'missing') expect(c.fix.length).toBeGreaterThan(10);
    }

    const raw = res.body;
    for (const secret of ['sk_test_status', 'whsec_status_secret', process.env.S3_SECRET_KEY ?? 'storyzio-secret']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('super admin only', async () => {
    for (const role of ['content_manager', 'finance', 'support', 'moderator'] as const) {
      expect((await (await adminClient(app, role)).call('GET', '/v1/admin/system/status')).statusCode).toBe(403);
    }
  });
});
