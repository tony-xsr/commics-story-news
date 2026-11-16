import { resolve } from 'node:path';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate';
import { TEST_DATABASE_URL } from './test-env';

/** Runs once before all test files: create the test database if missing and apply migrations. */
export default async function setup() {
  const target = new URL(TEST_DATABASE_URL);
  const dbName = target.pathname.slice(1);
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (!rowCount) await client.query(`create database "${dbName}"`);
  } finally {
    await client.end();
  }

  await runMigrations(TEST_DATABASE_URL, resolve(import.meta.dirname, '../drizzle'));
}
