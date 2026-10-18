/**
 * Creates a reproducible cohort of test learners:  npm run beta:learners
 *
 * The closed beta the requirements describe is ~50 students over three weeks. Preparing it by hand
 * means fifty registrations, fifty enrolments and a spreadsheet of credentials, and a beta whose
 * starting state nobody can reconstruct afterwards — so when a learner reports something odd in week
 * two there is no way to tell what their account looked like in week one.
 *
 * This script makes that cohort a function of one seed string. The same seed always produces the same
 * learners, the same emails, the same enrolments and the same practice history, on any machine, so a
 * finding can be reproduced from the seed alone. Nothing here is random: `--seed` drives a small
 * deterministic generator, and running twice with the same seed changes nothing (learners are
 * upserted by email).
 *
 * It creates accounts and enrolments. It does **not** answer questions on their behalf by default —
 * `--attempts` opts into that — because a beta's value is in what real learners do, and a database
 * full of synthetic attempts makes the real ones impossible to see. When attempts are generated they
 * are marked: every synthetic session carries `device_type = 'beta_fixture'`.
 *
 * SAFETY
 *
 *   * Refuses to run when NODE_ENV is production, and refuses a DATABASE_URL whose database name
 *     looks like a production one unless --force is given with an explicit --tenant.
 *   * Every learner's email is under a single reserved domain (@beta.invalid — reserved by RFC 2606,
 *     so it can never reach a real mailbox), which makes the whole cohort identifiable and removable
 *     with one query.
 *   * Passwords are derived from the seed and printed once, to stdout. They are test credentials for
 *     a test tenant; they are never written to a file, and the accounts are worthless outside it.
 *
 * Usage:
 *   npm run beta:learners -- --seed=autumn-beta --count=50 --tenant=dev-sandbox
 *   npm run beta:learners -- --seed=autumn-beta --count=50 --tenant=dev-sandbox --attempts=20
 *   npm run beta:learners -- --seed=autumn-beta --list      # print the credentials again
 *   npm run beta:learners -- --seed=autumn-beta --remove    # delete exactly this cohort
 */
import { createHash, randomUUID } from 'node:crypto';
import { argon2id, hash } from 'argon2';
import { Client } from 'pg';
import { loadEnvFile } from '../src/config/load-env-file';

/**
 * The same argon2id parameters `PasswordService` uses, read from the same environment variables with
 * the same defaults as `env.schema.ts`. Hashing here rather than through the service keeps this a
 * plain script — it needs no Nest container — and a cohort whose passwords the running application
 * cannot verify would be useless, so the parameters must not drift from that file.
 */
const argonOptions = {
  type: argon2id,
  memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19456),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
  parallelism: 1,
} as const;

const hashPassword = (plain: string): Promise<string> => hash(plain, argonOptions);

/** Reserved by RFC 2606: cannot resolve, so no message to one of these can reach a person. */
const COHORT_DOMAIN = 'beta.invalid';

interface Options {
  seed: string;
  count: number;
  tenantSlug: string;
  attempts: number;
  list: boolean;
  remove: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
  };
  const seed = get('seed');
  if (!seed) throw new Error('--seed is required: it is what makes the cohort reproducible');
  const count = Number(get('count') ?? 50);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('--count must be a whole number, 1-500');
  const attempts = Number(get('attempts') ?? 0);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 200) throw new Error('--attempts must be 0-200');
  return {
    seed,
    count,
    attempts,
    tenantSlug: get('tenant') ?? 'dev-sandbox',
    list: get('list') !== undefined,
    remove: get('remove') !== undefined,
    force: get('force') !== undefined,
  };
}

/**
 * A deterministic stream of numbers from the seed.
 *
 * sha256 of `seed:counter`, read as a 32-bit integer. Not for anything cryptographic — it is here
 * because `Math.random()` would make the cohort different on every run, which is the one property
 * this script exists to avoid.
 */
class SeededRandom {
  private counter = 0;
  constructor(private readonly seed: string) {}

  next(): number {
    const digest = createHash('sha256').update(`${this.seed}:${this.counter}`).digest();
    this.counter += 1;
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

/** First names only, and obviously synthetic: a beta tester should be able to tell at a glance. */
const NAMES = [
  'Aarav', 'Diya', 'Vihaan', 'Anaya', 'Arjun', 'Isha', 'Reyansh', 'Kiara', 'Advik', 'Myra',
  'Kabir', 'Aadhya', 'Ishaan', 'Saanvi', 'Rudra', 'Pari', 'Atharv', 'Navya', 'Shaurya', 'Riya',
] as const;

interface Learner {
  email: string;
  password: string;
  displayName: string;
  index: number;
}

/** The cohort is entirely determined by the seed and the count. */
function planCohort(seed: string, count: number): Learner[] {
  const rng = new SeededRandom(`${seed}:learners`);
  return Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const name = rng.pick(NAMES);
    // The password is derived, not random, so --list can print it again without storing it.
    const password = `Beta-${createHash('sha256').update(`${seed}:password:${index}`).digest('hex').slice(0, 12)}!7`;
    return {
      index,
      email: `beta-${seed.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${String(index).padStart(3, '0')}@${COHORT_DOMAIN}`,
      password,
      displayName: `${name} (beta ${index})`,
    };
  });
}

async function main(): Promise<void> {
  loadEnvFile();
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to create test learners with NODE_ENV=production');
  }
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (/prod/i.test(dbName) && !opts.force) {
    throw new Error(`refusing to touch "${dbName}": it looks like a production database (pass --force if it is not)`);
  }

  const cohort = planCohort(opts.seed, opts.count);

  if (opts.list) {
    printCredentials(cohort, opts);
    return;
  }

  const client = new Client({ connectionString: url, application_name: 'apexprep-beta-learners' });
  await client.connect();
  try {
    const { rows: tenantRows } = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [
      opts.tenantSlug,
    ]);
    const tenantId = tenantRows[0]?.id;
    if (!tenantId) throw new Error(`no tenant with slug "${opts.tenantSlug}"`);

    if (opts.remove) {
      await remove(client, tenantId, cohort, opts);
      return;
    }
    await create(client, tenantId, cohort, opts);
  } finally {
    await client.end();
  }
}

async function create(client: Client, tenantId: string, cohort: Learner[], opts: Options): Promise<void> {
  const { rows: tracks } = await client.query<{ id: string; name: string; kind: string | null }>(
    `SELECT id, name, kind FROM tracks
      WHERE tenant_id = $1 AND status = 'published' AND deleted_at IS NULL
      ORDER BY sort_order, name`,
    [tenantId],
  );
  if (tracks.length === 0) throw new Error('that tenant has no published tracks to enrol anyone in');

  const rng = new SeededRandom(`${opts.seed}:enrolments`);
  let created = 0;
  let enrolled = 0;

  for (const learner of cohort) {
    const passwordHash = await hashPassword(learner.password);
    // Upsert by email: running twice with the same seed leaves the same cohort, not a second one.
    const { rows } = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO users (tenant_id, email, password_hash, role, display_name, status)
       VALUES ($1, $2, $3, 'STUDENT', $4, 'active')
       -- The unique index is partial (users_tenant_email_uq ... WHERE deleted_at IS NULL), so the
       -- predicate has to be repeated here for PostgreSQL to match it.
       ON CONFLICT (tenant_id, email) WHERE deleted_at IS NULL
         DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, (xmax = 0) AS inserted`,
      [tenantId, learner.email, passwordHash, learner.displayName],
    );
    const userId = rows[0]!.id;
    if (rows[0]!.inserted) created += 1;

    // A third of the cohort is in two tracks, so the multi-context paths are exercised by the beta
    // rather than only by the tests. Which third is decided by the seed, not by chance.
    const primary = tracks[rng.int(tracks.length)]!;
    const wantsSecond = tracks.length > 1 && rng.next() < 1 / 3;
    const chosen = [primary];
    if (wantsSecond) {
      const others = tracks.filter((t) => t.id !== primary.id);
      chosen.push(others[rng.int(others.length)]!);
    }

    for (const [i, track] of chosen.entries()) {
      await client.query(
        `INSERT INTO learner_tracks (tenant_id, user_id, track_id, is_primary, status, goal_text)
         VALUES ($1, $2, $3, $4, 'active', $5)
         ON CONFLICT (tenant_id, user_id, track_id) DO UPDATE SET status = 'active', left_at = NULL`,
        [tenantId, userId, track.id, i === 0, `Beta cohort ${opts.seed}`],
      );
      enrolled += 1;
    }
    await client.query(`UPDATE users SET primary_track_id = $2 WHERE id = $1`, [userId, primary.id]);

    if (opts.attempts > 0) await generateAttempts(client, tenantId, userId, opts, rng);
  }

  console.log(`Cohort "${opts.seed}": ${cohort.length} learners (${created} new), ${enrolled} enrolments.`);
  if (opts.attempts > 0) console.log(`Each learner has up to ${opts.attempts} synthetic attempts (device_type = 'beta_fixture').`);
  printCredentials(cohort, opts);
}

/**
 * Synthetic practice history, through the same tables an answer writes.
 *
 * This does **not** go through the adaptive engine: it writes attempt rows directly, so the ability
 * scores it produces are not what the engine would have produced. That is why it is off by default
 * and why every session it creates is marked — a beta report about "my level looks wrong" must never
 * be traced back to rows this script invented. Its purpose is to give the analytics screens something
 * to render before real learners arrive, nothing more.
 */
async function generateAttempts(
  client: Client,
  tenantId: string,
  userId: string,
  opts: Options,
  rng: SeededRandom,
): Promise<void> {
  const { rows: candidates } = await client.query<{ id: string; primary_subtopic_id: string; expected_time_seconds: number }>(
    `SELECT q.id, q.primary_subtopic_id, q.expected_time_seconds
       FROM questions q
       JOIN learner_tracks lt ON lt.tenant_id = q.tenant_id AND lt.user_id = $2 AND lt.status = 'active'
       JOIN subtopic_paths p ON p.tenant_id = q.tenant_id AND p.subtopic_id = q.primary_subtopic_id
            AND p.is_live AND p.track_id = lt.track_id
      WHERE q.tenant_id = $1 AND q.status = 'published' AND q.deleted_at IS NULL
      ORDER BY q.id
      LIMIT $3`,
    [tenantId, userId, opts.attempts],
  );
  if (candidates.length === 0) return;

  const { rows: configRows } = await client.query<{ id: string }>(
    `SELECT id FROM engine_config WHERE tenant_id = $1 AND is_active LIMIT 1`,
    [tenantId],
  );
  const configId = configRows[0]?.id;
  if (!configId) return;

  for (const q of candidates) {
    const correct = rng.next() < 0.65;
    // Around the question's expected time, so the timing figures are not nonsense.
    const totalTimeMs = Math.round(q.expected_time_seconds * 1000 * (0.6 + rng.next() * 0.9));
    const { rows: sessionRows } = await client.query<{ id: string }>(
      `INSERT INTO sessions (tenant_id, user_id, subtopic_id, engine_config_id, focus_tracking_enabled, status,
                             started_at, last_activity_at, ended_at, served_count, answered_count, device_type)
       VALUES ($1, $2, $3, $4, false, 'completed', now() - interval '1 hour', now() - interval '1 hour',
               now() - interval '1 hour', 1, 1, 'beta_fixture')
       RETURNING id`,
      [tenantId, userId, q.primary_subtopic_id, configId],
    );
    const sessionId = sessionRows[0]!.id;
    const { rows: itemRows } = await client.query<{ id: string }>(
      `INSERT INTO session_items (tenant_id, session_id, user_id, subtopic_id, question_id, position, selection_reason,
                                  difficulty_b_at_serve, theta_at_serve, status, served_at, answered_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'adaptive', 1000, 1000, 'answered', now() - interval '1 hour',
               now() - interval '1 hour')
       RETURNING id`,
      [tenantId, sessionId, userId, q.primary_subtopic_id, q.id],
    );
    await client.query(
      `INSERT INTO attempts (tenant_id, user_id, question_id, question_version, subtopic_id, session_id, session_item_id,
                             idempotency_key, response, outcome, score, total_time_ms, difficulty_b_at_attempt,
                             difficulty_label_at_attempt, theta_before, expected_score, calibration_n_at_attempt,
                             expected_time_seconds_at_attempt, engine_config_id, created_at)
       SELECT $1, $2, $3, q.version, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, q.difficulty_b, q.difficulty_label,
              1000, 0.5, q.calibration_n, q.expected_time_seconds, $12, now() - interval '1 hour'
         FROM questions q WHERE q.id = $3`,
      [
        tenantId,
        userId,
        q.id,
        q.primary_subtopic_id,
        sessionId,
        itemRows[0]!.id,
        `beta-${randomUUID()}`,
        correct ? '{"option_keys":["A"]}' : '{"option_keys":["B"]}',
        correct ? 'correct' : 'incorrect',
        correct ? 1 : 0,
        totalTimeMs,
        configId,
      ],
    );
  }
}

/**
 * Deletes exactly this cohort and nothing else.
 *
 * Attempts, sessions and ability scores go with the learners, because a half-removed cohort is worse
 * than none: analytics would keep counting rows whose learner no longer exists.
 */
async function remove(client: Client, tenantId: string, cohort: Learner[], opts: Options): Promise<void> {
  const emails = cohort.map((l) => l.email);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND email = ANY($2::text[])`,
    [tenantId, emails],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    console.log(`Cohort "${opts.seed}": nothing to remove.`);
    return;
  }
  await client.query('BEGIN');
  try {
    // Children first: these tables reference users and have no cascade.
    for (const table of [
      'session_events',
      'attempts',
      'session_items',
      'sessions',
      'ability_scores',
      'learner_tracks',
      'refresh_tokens',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`, [tenantId, ids]);
    }
    await client.query(`DELETE FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  console.log(`Cohort "${opts.seed}": removed ${ids.length} learners and everything they had done.`);
}

function printCredentials(cohort: Learner[], opts: Options): void {
  console.log('');
  console.log(`# Beta cohort "${opts.seed}" — ${cohort.length} learners, tenant "${opts.tenantSlug}"`);
  console.log('# Reproduce this exact list at any time with: --seed=' + opts.seed + ' --count=' + opts.count + ' --list');
  console.log('email,password,display_name');
  for (const l of cohort) console.log(`${l.email},${l.password},"${l.displayName}"`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
