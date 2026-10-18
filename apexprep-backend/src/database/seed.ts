/**
 * DEVELOPMENT-ONLY seed:  npm run db:seed
 *
 * 1. Refuses to run when NODE_ENV=production.
 * 2. Runs database/seeds/dev/*.sql in one transaction with apexprep.allow_dev_seed = 'on'
 *    (the SQL aborts without that flag, so it cannot be piped into production by hand).
 * 3. Creates/updates one ADMIN and one STUDENT in the dev tenant, and optionally one
 *    SUPER_ADMIN in the platform tenant. Passwords come from SEED_*_PASSWORD and are
 *    hashed with argon2id here — no credentials exist in the repository.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argon2id, hash } from 'argon2';
import { Client } from 'pg';
import { loadEnvFile } from '../config/load-env-file';

const SEED_DIR = resolve(process.cwd(), 'database', 'seeds', 'dev');
export const DEV_TENANT_ID = 'd0000000-0000-4000-8000-000000000001';
export const PLATFORM_TENANT_ID = 'd0000000-0000-4000-8000-000000000000';
export const DEV_TRACK_ID = 'd1000000-0000-4000-8000-000000000001';

function requiredEnv(name: string, minLength = 1): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minLength) {
    throw new Error(`${name} must be set${minLength > 1 ? ` (at least ${minLength} characters)` : ''}`);
  }
  return value;
}

interface SeedUser {
  tenantId: string;
  email: string;
  passwordHash: string;
  role: 'ADMIN' | 'STUDENT' | 'SUPER_ADMIN';
  displayName: string;
}

async function upsertUser(client: Client, u: SeedUser): Promise<string> {
  const isStudent = u.role === 'STUDENT';
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name, email_verified_at,
                        primary_track_id, daily_question_goal, onboarded_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8)
     ON CONFLICT (tenant_id, email) WHERE deleted_at IS NULL
     DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
     RETURNING id`,
    [
      u.tenantId,
      u.email,
      u.passwordHash,
      u.role,
      u.displayName,
      isStudent ? DEV_TRACK_ID : null,
      isStudent ? 50 : null,
      isStudent ? new Date() : null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`failed to upsert ${u.email}`);
  return id;
}

async function main(): Promise<void> {
  loadEnvFile();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production. This seed is for local development only.');
  }
  const url = requiredEnv('DATABASE_URL');
  const hashOptions = {
    type: argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19456),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
    parallelism: 1,
  };
  const users: SeedUser[] = [
    {
      tenantId: DEV_TENANT_ID,
      email: requiredEnv('SEED_ADMIN_EMAIL').toLowerCase(),
      passwordHash: await hash(requiredEnv('SEED_ADMIN_PASSWORD', 12), hashOptions),
      role: 'ADMIN',
      displayName: 'Dev Admin',
    },
    {
      tenantId: DEV_TENANT_ID,
      email: requiredEnv('SEED_STUDENT_EMAIL').toLowerCase(),
      passwordHash: await hash(requiredEnv('SEED_STUDENT_PASSWORD', 12), hashOptions),
      role: 'STUDENT',
      displayName: 'Dev Student',
    },
  ];
  if (process.env.SEED_SUPER_ADMIN_EMAIL?.trim()) {
    users.push({
      tenantId: PLATFORM_TENANT_ID,
      email: requiredEnv('SEED_SUPER_ADMIN_EMAIL').toLowerCase(),
      passwordHash: await hash(requiredEnv('SEED_SUPER_ADMIN_PASSWORD', 12), hashOptions),
      role: 'SUPER_ADMIN',
      displayName: 'Dev Super Admin',
    });
  }

  const client = new Client({ connectionString: url, application_name: 'apexprep-seed' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL apexprep.allow_dev_seed = 'on'");
    for (const file of readdirSync(SEED_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(SEED_DIR, file), 'utf8'));
      console.log(`seeded   ${file}`);
    }
    const created: string[] = [];
    for (const u of users) created.push(`${u.role.padEnd(11)} ${u.email} (${await upsertUser(client, u)})`);
    await client.query('COMMIT');
    for (const line of created) console.log(line);
    console.log('Development seed complete. Tenants: dev-sandbox, apexprep-platform.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
