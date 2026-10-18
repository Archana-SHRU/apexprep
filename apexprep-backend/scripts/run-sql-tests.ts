/**
 * Database-level tests:  npm run test:sql
 *
 * 1. Resets and migrates TEST_DATABASE_URL. Refuses unless the database name ends
 *    in "_test", so it can never wipe a development or production database.
 * 2. Loads the development content seed (database/seeds/dev/*.sql).
 * 3. Runs every test/sql/NNN_*.sql in a fresh session, after test/sql/_setup.sql.
 *    Each file wraps its work in BEGIN … ROLLBACK and reports through NOTICEs:
 *    "ok   <label>" per passing assertion; any error fails the file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { loadEnvFile } from '../src/config/load-env-file';
import { runMigrations, unavailableExtensionMigrations } from '../src/database/migrate';

const TEST_DIR = resolve(process.cwd(), 'test', 'sql');
const SEED_DIR = resolve(process.cwd(), 'database', 'seeds', 'dev');

async function withClient<T>(url: string, fn: (c: Client, notices: string[]) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, application_name: 'apexprep-sql-tests' });
  const notices: string[] = [];
  client.on('notice', (n) => notices.push(n.message ?? ''));
  await client.connect();
  try {
    return await fn(client, notices);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset "${dbName}": the test database name must end in _test`);

  process.env.NODE_ENV ??= 'test';
  const skip = await unavailableExtensionMigrations(url);
  if (skip.length) console.log(`WARNING: pgvector is not installed on this server; skipping ${skip.join(', ')}`);
  await runMigrations(url, { reset: true, log: () => undefined, skip });
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query("SET LOCAL apexprep.allow_dev_seed = 'on'");
    for (const f of readdirSync(SEED_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query(readFileSync(join(SEED_DIR, f), 'utf8'));
    }
    await c.query('COMMIT');
  });

  const setup = readFileSync(join(TEST_DIR, '_setup.sql'), 'utf8');
  const files = readdirSync(TEST_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  let passed = 0;
  let failedFiles = 0;

  for (const file of files) {
    const sql = readFileSync(join(TEST_DIR, file), 'utf8');
    await withClient(url, async (c, notices) => {
      try {
        await c.query(setup);
        await c.query(sql);
        const oks = notices.filter((n) => n.startsWith('ok '));
        passed += oks.length;
        console.log(`PASS ${file} (${oks.length} assertions)`);
      } catch (err) {
        failedFiles += 1;
        console.log(`FAIL ${file}\n     ${(err as Error).message}`);
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  }

  console.log(`\n${passed} assertions passed, ${failedFiles} file(s) failed, ${files.length} file(s) run`);
  if (failedFiles) process.exit(1);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
