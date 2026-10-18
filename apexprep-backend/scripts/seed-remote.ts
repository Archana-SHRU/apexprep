/**
 * Remote / Cloud Database Seeder for Render / Cloud deployments.
 *
 * Populates a remote PostgreSQL database with:
 * 1. Default tenant ('dev-sandbox') with self-registration enabled.
 * 2. Complete syllabus (JEE Advanced -> Physics, Chemistry, Math -> Mechanics -> Topics).
 * 3. 15 practice questions with L1-L5 levels, hints, and explanations.
 * 4. Initial Admin and Student accounts.
 *
 * Usage:
 *   npx tsx scripts/seed-remote.ts <DATABASE_URL>
 *
 * Or set DATABASE_URL, SEED_ADMIN_PASSWORD, SEED_STUDENT_PASSWORD in environment:
 *   npm run db:seed:remote
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argon2id, hash } from 'argon2';
import { Client } from 'pg';
import { loadEnvFile } from '../src/config/load-env-file';

const SEED_DIR = resolve(process.cwd(), 'database', 'seeds', 'dev');
export const DEV_TENANT_ID = 'd0000000-0000-4000-8000-000000000001';
export const PLATFORM_TENANT_ID = 'd0000000-0000-4000-8000-000000000000';
export const DEV_TRACK_ID = 'd1000000-0000-4000-8000-000000000001';

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
  if (!id) throw new Error(`Failed to upsert ${u.email}`);
  return id;
}

async function main(): Promise<void> {
  loadEnvFile();
  const cliUrl = process.argv[2];
  const url = cliUrl ?? process.env.DATABASE_URL;

  if (!url) {
    console.error('ERROR: No DATABASE_URL provided.');
    console.error('Usage: npm run db:seed:remote -- "<DATABASE_URL>"');
    console.error('Or set DATABASE_URL in environment or .env');
    process.exit(1);
  }

  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@apexprep.dev').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'AdminPassword123!';
  const studentEmail = (process.env.SEED_STUDENT_EMAIL || 'student@apexprep.dev').toLowerCase();
  const studentPassword = process.env.SEED_STUDENT_PASSWORD || 'StudentPassword123!';

  console.log(`Connecting to database...`);
  const isCloud = !url.includes('localhost') && !url.includes('127.0.0.1');
  const client = new Client({
    connectionString: url,
    application_name: 'apexprep-remote-seed',
    ssl: isCloud ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    const hashOptions = {
      type: argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    };

    console.log('Hashing passwords with argon2id...');
    const users: SeedUser[] = [
      {
        tenantId: DEV_TENANT_ID,
        email: adminEmail,
        passwordHash: await hash(adminPassword, hashOptions),
        role: 'ADMIN',
        displayName: 'Platform Admin',
      },
      {
        tenantId: DEV_TENANT_ID,
        email: studentEmail,
        passwordHash: await hash(studentPassword, hashOptions),
        role: 'STUDENT',
        displayName: 'Demo Student',
      },
    ];

    if (process.env.SEED_SUPER_ADMIN_EMAIL?.trim()) {
      users.push({
        tenantId: PLATFORM_TENANT_ID,
        email: process.env.SEED_SUPER_ADMIN_EMAIL.toLowerCase(),
        passwordHash: await hash(process.env.SEED_SUPER_ADMIN_PASSWORD || 'SuperAdmin123!', hashOptions),
        role: 'SUPER_ADMIN',
        displayName: 'Super Admin',
      });
    }

    console.log('Beginning remote seed transaction...');
    await client.query('BEGIN');
    await client.query("SET LOCAL apexprep.allow_dev_seed = 'on'");

    for (const file of readdirSync(SEED_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(SEED_DIR, file), 'utf8');
      await client.query(sql);
      console.log(`  [OK] Applied ${file}`);
    }

    console.log('Upserting seed users...');
    for (const u of users) {
      const id = await upsertUser(client, u);
      console.log(`  [OK] ${u.role.padEnd(11)} ${u.email} (ID: ${id})`);
    }

    await client.query('COMMIT');
    console.log('\n Remote seed complete!');
    console.log('----------------------------------------------------');
    console.log(`Default Tenant Slug : dev-sandbox`);
    console.log(`Admin User          : ${adminEmail} (password: ${adminPassword})`);
    console.log(`Student User        : ${studentEmail} (password: ${studentPassword})`);
    console.log('----------------------------------------------------\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Seeding failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
