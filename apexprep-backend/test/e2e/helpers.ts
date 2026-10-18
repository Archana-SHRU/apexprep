import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { argon2id, hash } from 'argon2';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { validateEnv } from '../../src/config/env.schema';
import { MAIL_OUTBOX, type MailMessage } from '../../src/mail/mail.service';
import { engineParamsJson } from '../fixtures/engine-params';

export interface TestApp {
  app: NestExpressApplication;
  http: () => ReturnType<typeof request>;
  outbox: MailMessage[];
  close: () => Promise<void>;
}

/**
 * The real application (same modules, guards, filters and middleware as production)
 * against the test database. `env` overrides individual settings for this instance only.
 *
 * `providers` replaces individual DI tokens. It exists for the AI boundary: the explanation
 * tests drive the real request path — controller, guards, validation, service, repository,
 * database — and swap only the provider at the network edge, so nothing about resolution,
 * grounding or safety is mocked.
 */
export async function createTestApp(
  env: Record<string, string> = {},
  providers: { token: unknown; value: unknown }[] = [],
): Promise<TestApp> {
  const config = new ConfigService(validateEnv({ ...process.env, ...env }));
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ConfigService).useValue(config);
  for (const { token, value } of providers) builder = builder.overrideProvider(token).useValue(value);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app);
  await app.init();
  return {
    app,
    http: () => request(app.getHttpServer()),
    outbox: app.get<MailMessage[]>(MAIL_OUTBOX),
    close: () => app.close(),
  };
}

let pool: Pool | undefined;
export function db(): Pool {
  pool ??= new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  return pool;
}
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export function uniq(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

export interface TenantFixture {
  id: string;
  slug: string;
}

export async function createTenant(opts: { selfRegistration?: boolean; status?: 'active' | 'suspended' } = {}): Promise<TenantFixture> {
  const slug = uniq('t');
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO tenants (slug, name, self_registration_enabled, status) VALUES ($1, $2, $3, $4) RETURNING id`,
    [slug, `Tenant ${slug}`, opts.selfRegistration ?? true, opts.status ?? 'active'],
  );
  return { id: rows[0]!.id, slug };
}

export interface UserFixture {
  id: string;
  tenantId: string;
  email: string;
  password: string;
  role: 'STUDENT' | 'ADMIN' | 'SUPER_ADMIN';
}

/** Inserts a user directly (cheap argon2id parameters; the app rehashes on first login). */
export async function createUser(
  tenant: TenantFixture,
  role: UserFixture['role'] = 'STUDENT',
  opts: { status?: 'active' | 'disabled'; email?: string } = {},
): Promise<UserFixture> {
  const email = opts.email ?? `${uniq(role.toLowerCase())}@example.test`;
  const password = `pw-${randomBytes(9).toString('base64url')}`;
  const passwordHash = await hash(password, { type: argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 });
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role, display_name, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenant.id, email, passwordHash, role, `${role} user`, opts.status ?? 'active'],
  );
  return { id: rows[0]!.id, tenantId: tenant.id, email, password, role };
}

export interface Session {
  accessToken: string;
  refreshCookie: string; // "apx_refresh=<token>"
  refreshToken: string;
  body: Record<string, unknown>;
}

export function refreshCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('apx_refresh='));
  if (!cookie) throw new Error('response did not set the apx_refresh cookie');
  return cookie.split(';')[0]!;
}

export async function login(t: TestApp, user: UserFixture, tenantSlug: string): Promise<Session> {
  const res = await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as { accessToken: string };
  const refreshCookie = refreshCookieFrom(res);
  return { accessToken: body.accessToken, refreshCookie, refreshToken: refreshCookie.split('=')[1]!, body: res.body as Record<string, unknown> };
}

export const bearer = (s: { accessToken: string }): [string, string] => ['Authorization', `Bearer ${s.accessToken}`];

/** Deep-scan any JSON value for secrets: password/hash keys or argon2 strings. */
export function findSecrets(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return value.startsWith('$argon2') ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/(password|hash|token_?version|failed_?login|locked)/i.test(k) ? [`${path}.${k}`] : []),
      ...findSecrets(v, `${path}.${k}`),
    ]);
  }
  return [];
}

// ---------------------------------------------------------------- Phase 3 fixtures

export interface SyllabusFixture {
  trackId: string;
  subjectId: string;
  chapterId: string;
  topicId: string;
  subtopicId: string;
}

type NodeStatus = 'draft' | 'published' | 'archived';

/** Inserts one track → subject → chapter → topic → sub-topic chain, published by default. */
export async function createSyllabus(
  tenant: TenantFixture,
  statuses: Partial<Record<'track' | 'subject' | 'chapter' | 'topic' | 'subtopic', NodeStatus>> = {},
): Promise<SyllabusFixture> {
  const st = (k: keyof typeof statuses): NodeStatus => statuses[k] ?? 'published';
  const one = async (sql: string, params: unknown[]): Promise<string> => (await db().query<{ id: string }>(sql, params)).rows[0]!.id;
  const trackId = await one(
    `INSERT INTO tracks (tenant_id, slug, name, status) VALUES ($1, $2, 'JEE Advanced', $3) RETURNING id`,
    [tenant.id, uniq('track'), st('track')],
  );
  const subjectId = await one(
    `INSERT INTO subjects (tenant_id, track_id, slug, name, status) VALUES ($1, $2, $3, 'Physics', $4) RETURNING id`,
    [tenant.id, trackId, uniq('subject'), st('subject')],
  );
  const chapterId = await one(
    `INSERT INTO chapters (tenant_id, subject_id, slug, name, status) VALUES ($1, $2, $3, 'Mechanics', $4) RETURNING id`,
    [tenant.id, subjectId, uniq('chapter'), st('chapter')],
  );
  const topicId = await one(
    `INSERT INTO topics (tenant_id, chapter_id, slug, name, status) VALUES ($1, $2, $3, 'Rotational Dynamics', $4) RETURNING id`,
    [tenant.id, chapterId, uniq('topic'), st('topic')],
  );
  const subtopicId = await one(
    `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Angular Momentum', $4) RETURNING id`,
    [tenant.id, topicId, uniq('subtopic'), st('subtopic')],
  );
  return { trackId, subjectId, chapterId, topicId, subtopicId };
}

export async function createSubtopic(tenant: TenantFixture, topicId: string, status: NodeStatus = 'published', name = 'Rolling'): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenant.id, topicId, uniq('subtopic'), name, status],
  );
  return rows[0]!.id;
}

/**
 * An active engine_config version carrying the same provisional parameters as the
 * development seed. Pass overrides to exercise a specific rule.
 */
export async function createEngineConfig(tenant: TenantFixture, params: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO engine_config (tenant_id, version, params, change_note, is_active, activated_at)
     VALUES ($1, 1, $2, 'test fixture', true, now()) RETURNING id`,
    [tenant.id, JSON.stringify(engineParamsJson(params))],
  );
  return rows[0]!.id;
}

/** A published theory block. `kind` lets a test add a question/solution block that must never be served as theory. */
export async function insertContentBlock(
  tenant: TenantFixture,
  subtopicId: string,
  opts: { kind?: 'theory' | 'question' | 'solution'; format?: string; title?: string | null; text: string; contentJson?: unknown; status?: string; sortOrder?: number } ,
): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO content_blocks (tenant_id, kind, format, title, raw_text, normalized_text, content_json, content_hash,
                                 classified_by, subtopic_id, sort_order, status, published_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, encode(sha256(convert_to($5, 'UTF8')), 'hex'), 'human', $7, $8, $9,
             CASE WHEN $9 = 'published' THEN now() END)
     RETURNING id`,
    [
      tenant.id,
      opts.kind ?? 'theory',
      opts.format ?? 'paragraph',
      opts.title ?? null,
      opts.text,
      opts.contentJson === undefined ? null : JSON.stringify(opts.contentJson),
      subtopicId,
      opts.sortOrder ?? 0,
      opts.status ?? 'published',
    ],
  );
  return rows[0]!.id;
}

/** The audit rows written for one entity, newest first. */
export async function auditActions(tenantId: string, entityId: string): Promise<string[]> {
  const { rows } = await db().query<{ action: string }>(
    `SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY occurred_at DESC, id DESC`,
    [tenantId, entityId],
  );
  return rows.map((r) => r.action);
}

// ---------------------------------------------------------------- Phase 5 fixtures

export interface PracticeQuestionOptions {
  /** L1-L5. */
  label?: number;
  /** Elo difficulty. */
  b?: number;
  calibrationN?: number;
  expectedTimeSeconds?: number;
  duplicateGroupId?: string | null;
  stem?: string;
}

/**
 * A published single-correct question where option **A is correct** and B is wrong, so a
 * test answers correctly with `{ optionKeys: ['A'] }` and incorrectly with `['B']`.
 * Difficulty and calibration are set directly, which is what the K-factor tests need.
 *
 * The question and its options go in one transaction: `questions_publishable` (migration
 * 0004) is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so a published question
 * without options is only legal until the transaction commits.
 */
export async function insertPracticeQuestion(tenant: TenantFixture, subtopicId: string, opts: PracticeQuestionOptions = {}): Promise<string> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO questions (tenant_id, primary_subtopic_id, type, stem, difficulty_label, difficulty_b, calibration_n,
                              expected_time_seconds, duplicate_group_id, status, published_at)
       VALUES ($1, $2, 'single_correct', $3, $4, $5, $6, $7, $8, 'published', now()) RETURNING id`,
      [
        tenant.id,
        subtopicId,
        opts.stem ?? `Practice question ${uniq('q')}`,
        opts.label ?? 2,
        opts.b ?? 1000,
        opts.calibrationN ?? 50,
        opts.expectedTimeSeconds ?? 60,
        opts.duplicateGroupId ?? null,
      ],
    );
    const questionId = rows[0]!.id;
    await client.query(
      `INSERT INTO question_options (tenant_id, question_id, option_key, body, is_correct, sort_order)
       VALUES ($1, $2, 'A', 'The correct option', true, 0), ($1, $2, 'B', 'A wrong option', false, 1)`,
      [tenant.id, questionId],
    );
    await client.query('COMMIT');
    return questionId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Overrides the ability projection, for tests that need a particular starting state. */
export async function setAbility(
  tenant: TenantFixture,
  userId: string,
  subtopicId: string,
  patch: Partial<{ theta: number; level: number; gradedCount: number; attemptsCount: number; correctCount: number; placementStatus: string; ladderResetAt: Date | null }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [tenant.id, userId, subtopicId];
  const add = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.theta !== undefined) add('theta', patch.theta);
  if (patch.level !== undefined) add('level', patch.level);
  if (patch.gradedCount !== undefined) add('graded_count', patch.gradedCount);
  if (patch.attemptsCount !== undefined) add('attempts_count', patch.attemptsCount);
  if (patch.correctCount !== undefined) add('correct_count', patch.correctCount);
  if (patch.placementStatus !== undefined) add('placement_status', patch.placementStatus);
  if (patch.ladderResetAt !== undefined) add('ladder_reset_at', patch.ladderResetAt);
  if (sets.length === 0) return;
  await db().query(
    `UPDATE ability_scores SET ${sets.join(', ')} WHERE tenant_id = $1 AND user_id = $2 AND subtopic_id = $3`,
    values,
  );
}

export async function abilityRow(tenant: TenantFixture, userId: string, subtopicId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db().query<Record<string, unknown>>(
    `SELECT * FROM ability_scores WHERE tenant_id = $1 AND user_id = $2 AND subtopic_id = $3`,
    [tenant.id, userId, subtopicId],
  );
  return rows[0];
}

/**
 * A finished attempt from the past: a completed session, its served item and the attempt,
 * all with backdated timestamps. `attempts` is append-only, so history is inserted, never
 * edited — which is exactly how the exclusion-window tests need it.
 */
export async function insertHistoricalAttempt(
  tenant: TenantFixture,
  userId: string,
  subtopicId: string,
  questionId: string,
  engineConfigId: string,
  opts: {
    daysAgo: number;
    correct?: boolean;
    skippedOnly?: boolean;
    totalTimeMs?: number;
    probableGuess?: boolean;
    /** What the attempt recorded as the question's level. Defaults to 2, as it always did. */
    difficultyLabel?: number;
  },
): Promise<void> {
  const when = `now() - interval '${opts.daysAgo} days'`;
  const { rows: sessionRows } = await db().query<{ id: string }>(
    `INSERT INTO sessions (tenant_id, user_id, subtopic_id, engine_config_id, focus_tracking_enabled, status, started_at,
                           last_activity_at, ended_at, served_count, answered_count)
     VALUES ($1, $2, $3, $4, false, 'completed', ${when}, ${when}, ${when}, 1, $5) RETURNING id`,
    [tenant.id, userId, subtopicId, engineConfigId, opts.skippedOnly ? 0 : 1],
  );
  const sessionId = sessionRows[0]!.id;
  const { rows: itemRows } = await db().query<{ id: string }>(
    `INSERT INTO session_items (tenant_id, session_id, user_id, subtopic_id, question_id, position, selection_reason,
                                difficulty_b_at_serve, theta_at_serve, status, served_at, answered_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'adaptive', 1000, 1000, $6, ${when}, CASE WHEN $6 = 'answered' THEN ${when} END)
     RETURNING id`,
    [tenant.id, sessionId, userId, subtopicId, questionId, opts.skippedOnly ? 'skipped' : 'answered'],
  );
  if (opts.skippedOnly) return;

  const correct = opts.correct ?? true;
  await db().query(
    `INSERT INTO attempts (tenant_id, user_id, question_id, question_version, subtopic_id, session_id, session_item_id,
                           idempotency_key, response, outcome, score, total_time_ms, difficulty_b_at_attempt,
                           difficulty_label_at_attempt, theta_before, expected_score, calibration_n_at_attempt,
                           expected_time_seconds_at_attempt, engine_config_id, probable_guess, created_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $11::jsonb, $8, $9, $12, 1000, $14, 1000, 0.5, 50, 60, $10, $13, ${when})`,
    [
      tenant.id,
      userId,
      questionId,
      subtopicId,
      sessionId,
      itemRows[0]!.id,
      uniq('history-key'),
      correct ? 'correct' : 'incorrect',
      correct ? 1 : 0,
      engineConfigId,
      // The recorded response has to agree with the outcome: option A is the correct one, so a
      // wrong attempt records B. Anything reading the response back (the distractor variant an
      // explanation is written for) would otherwise see a contradiction.
      correct ? '{"option_keys":["A"]}' : '{"option_keys":["B"]}',
      // Defaults preserved: existing callers get the 40 s attempt they always got.
      opts.totalTimeMs ?? 40000,
      opts.probableGuess ?? false,
      opts.difficultyLabel ?? 2,
    ],
  );
}

/**
 * Makes a served question look as if it had been open for `ms` already.
 *
 * The server will not believe a reported answer time longer than the question has actually been open (a browser
 * could otherwise claim any pace it liked), so a test that wants to submit "a 40-second answer" has to let 40
 * seconds have passed. It moves `served_at` back instead of sleeping.
 */
export async function ageServedItem(itemId: string, ms: number): Promise<void> {
  await db().query(`UPDATE session_items SET served_at = served_at - make_interval(secs => $2::float8 / 1000) WHERE id = $1`, [itemId, ms]);
}
