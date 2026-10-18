/**
 * SQL-first migration runner.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:status             list applied / pending, verify checksums
 *   npm run db:reset              DROP and re-create the schema (refused in production)
 *
 * - Files: database/migrations/NNNN_name.sql, applied in lexical order.
 * - Each file runs in its own transaction and is recorded in schema_migrations
 *   with a SHA-256 checksum. Editing an applied migration is detected and refused.
 * - A Postgres advisory lock prevents two runners (e.g. two app replicas) racing.
 * - Line endings are normalised before hashing so a Windows checkout (CRLF)
 *   produces the same checksum as Linux.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { loadEnvFile } from '../config/load-env-file';

const MIGRATIONS_DIR = resolve(process.cwd(), 'database', 'migrations');
const ADVISORY_LOCK_KEY = '7424110001';
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1]) throw new Error(`Migration file name must look like 0001_name.sql: ${file}`);
    if (seen.has(match[1])) throw new Error(`Duplicate migration number ${match[1]} (${file})`);
    seen.add(match[1]);
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    return { version: file.replace(/\.sql$/, ''), file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

export async function runMigrations(
  connectionString: string,
  opts: {
    reset?: boolean;
    statusOnly?: boolean;
    log?: (line: string) => void;
    /** Test databases only: versions to leave unapplied (e.g. pgvector when the extension is absent). */
    skip?: readonly string[];
  } = {},
): Promise<{ applied: string[]; pending: string[] }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const client = new Client({ connectionString, application_name: 'apexprep-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [ADVISORY_LOCK_KEY]);

    if (opts.reset) {
      log('Resetting schema "public" (all data will be lost)');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version       text PRIMARY KEY,
        checksum      text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at    timestamptz NOT NULL DEFAULT now(),
        execution_ms  integer NOT NULL CHECK (execution_ms >= 0)
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const files = readMigrations();
    const byVersion = new Map(files.map((f) => [f.version, f]));

    for (const [version, checksum] of applied) {
      const file = byVersion.get(version);
      if (!file) throw new Error(`Applied migration ${version} is missing from database/migrations`);
      if (file.checksum !== checksum) {
        throw new Error(`Migration ${version} was edited after it was applied. Add a new migration instead.`);
      }
    }

    const skip = new Set(opts.skip ?? []);
    if (skip.size && process.env.NODE_ENV === 'production') throw new Error('Skipping migrations is refused in production');
    for (const v of skip) log(`SKIPPED  ${v} (test database without its prerequisites)`);
    const pending = files.filter((f) => !applied.has(f.version) && !skip.has(f.version));
    if (opts.statusOnly) {
      for (const f of files) log(`${applied.has(f.version) ? 'applied' : 'PENDING'}  ${f.version}`);
      return { applied: [...applied.keys()], pending: pending.map((f) => f.version) };
    }

    const done: string[] = [];
    for (const m of pending) {
      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum, execution_ms) VALUES ($1, $2, $3)', [
          m.version,
          m.checksum,
          Date.now() - started,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.file} failed: ${(err as Error).message}`);
      }
      done.push(m.version);
      log(`applied  ${m.version} (${Date.now() - started} ms)`);
    }
    if (!done.length) log('Database is up to date.');
    return { applied: [...applied.keys(), ...done], pending: [] };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = new Set(process.argv.slice(2));
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (or MIGRATE_DATABASE_URL) is not set');
  if (args.has('--reset') && process.env.NODE_ENV === 'production') {
    throw new Error('--reset is refused when NODE_ENV=production');
  }
  await runMigrations(url, { reset: args.has('--reset'), statusOnly: args.has('--status') });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

/**
 * For test databases: migrations whose extensions this server cannot provide.
 * Only pgvector today (0007). Developers using the docker-compose image have it.
 */
export async function unavailableExtensionMigrations(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString, application_name: 'apexprep-migrate' });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'",
    );
    return rows[0]?.n ? [] : ['0007_pgvector'];
  } finally {
    await client.end();
  }
}
