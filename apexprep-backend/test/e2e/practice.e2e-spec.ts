import { randomUUID } from 'node:crypto';
import { AbilityRebuildService } from '../../src/practice/ability-rebuild.service';
import {
  ageServedItem,
  abilityRow,
  bearer,
  closeDb,
  createEngineConfig,
  createSubtopic,
  createSyllabus,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertHistoricalAttempt,
  insertPracticeQuestion,
  login,
  setAbility,
  uniq,
  type PracticeQuestionOptions,
  type Session,
  type TestApp,
} from './helpers';
import { questionSamples } from './question-samples';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * End-to-end practice flow: the Phase 4 engine driven entirely through the HTTP API.
 *
 * Every adaptive number asserted here follows from the engine parameters the fixture posts
 * (`test/fixtures/engine-params.ts`) — no threshold is copied out of the engine, and a test
 * that depends on one overrides that parameter explicitly.
 */

/** Keys that must never appear anywhere in a payload served to a student. */
const FORBIDDEN_KEY =
  /^(isCorrect|is_correct|correct|correctKey|correctValue|correctNumeric|answer|answerKey|numericAnswer|tolerance|toleranceMode|matrixAnswer|solution|explanation|difficultyB|difficulty_b|calibrationN|calibration_n|hints|targetB|thetaAtServe)$/;

function forbiddenKeyPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeyPaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []),
      ...forbiddenKeyPaths(v, `${path}.${k}`),
    ]);
  }
  return [];
}

describe('Practice flow (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  /** A student, a published sub-topic, an active engine configuration and `questions` questions. */
  async function arrange(options: { questions?: number; params?: Record<string, unknown>; question?: PracticeQuestionOptions } = {}) {
    const tenant = await createTenant();
    const student = await createUser(tenant, 'STUDENT');
    const [session, syllabus] = await Promise.all([login(t, student, tenant.slug), createSyllabus(tenant)]);
    const engineConfigId = await createEngineConfig(tenant, options.params ?? {});
    const questionIds: string[] = [];
    for (let i = 0; i < (options.questions ?? 6); i += 1) {
      questionIds.push(await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 900 + i * 20, ...options.question }));
    }
    return { tenant, student, session, syllabus, engineConfigId, questionIds };
  }

  const start = (s: Session, subtopicId: string, body: Json = {}) =>
    t.http().post('/v1/practice/sessions').set(...bearer(s)).send({ subtopicId, ...body });

  const next = (s: Session, sessionId: string, query = '') =>
    t.http().get(`/v1/practice/sessions/${sessionId}/next${query}`).set(...bearer(s));

  const answer = async (s: Session, itemId: string, response: unknown, opts: { totalTimeMs?: number; key?: string } = {}) => {
    const totalTimeMs = opts.totalTimeMs ?? 40_000;
    // The server does not believe a time longer than the question has been open, so let that time have passed.
    await ageServedItem(itemId, totalTimeMs);
    return t
      .http()
      .post('/v1/practice/attempts')
      .set(...bearer(s))
      .set('Idempotency-Key', opts.key ?? uniq('attempt'))
      .send({ sessionItemId: itemId, response, totalTimeMs });
  };

  /** Serve one question and answer it. Option A is the correct one, B the wrong one. */
  async function play(s: Session, sessionId: string, correct: boolean, opts: { totalTimeMs?: number } = {}) {
    const served = await next(s, sessionId);
    expect(served.status).toBe(200);
    const result = await answer(s, served.body.item.id as string, { optionKeys: [correct ? 'A' : 'B'] }, opts);
    expect(result.status).toBe(201);
    return { served: served.body as Json, result: result.body as Json };
  }

  // ------------------------------------------------------------------ sessions

  describe('starting a session', () => {
    it('starts a new student at L2 with the cold-start ability', async () => {
      const { session, syllabus } = await arrange();
      const res = await start(session, syllabus.subtopicId);
      expect(res.status).toBe(201);
      expect(res.body.progress).toMatchObject({ level: 2, theta: 1000, attemptsCount: 0, gradedCount: 0, correctCount: 0, placementStatus: 'in_progress' });
      expect(res.body.session).toMatchObject({ mode: 'placement', status: 'active', servedCount: 0, answeredCount: 0, resumed: false, paused: false });
      expect(res.body.decayApplied).toBe(0);
    });

    it('seeds θ from the parent topic when the student has already practised a sibling sub-topic', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 0 });
      const sibling = await createSubtopic(tenant, syllabus.topicId, 'published', 'Sibling');
      await start(session, sibling); // creates the sibling ability row
      await setAbility(tenant, student.id, sibling, { theta: 1320, level: 4 });

      const res = await start(session, syllabus.subtopicId);
      expect(res.body.progress).toMatchObject({ theta: 1320, level: 4 });
    });

    it('resumes the session that is already open instead of starting a second one', async () => {
      const { session, syllabus } = await arrange();
      const first = await start(session, syllabus.subtopicId);
      const second = await start(session, syllabus.subtopicId);
      expect(second.body.session).toMatchObject({ id: first.body.session.id, resumed: true });
      const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM sessions WHERE id = $1`, [first.body.session.id]);
      expect(rows[0]!.n).toBe('1');
    });

    it('decays θ when the student has been away past the grace window', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 1 });
      const first = await start(session, syllabus.subtopicId);
      await play(session, first.body.session.id as string, true); // gives the ability row a last attempt
      // ability_scores_last_pair keeps the id and the timestamp together, so only the time moves.
      await db().query(
        `UPDATE ability_scores SET theta = 1200, last_attempt_at = now() - interval '40 days' WHERE tenant_id = $1 AND user_id = $2`,
        [tenant.id, student.id],
      );
      await db().query(`UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = $1`, [first.body.session.id]);

      // 40 days away, 21-day grace, 7-day periods, 10 points each → 3 periods → 30 points.
      const res = await start(session, syllabus.subtopicId);
      expect(res.body.decayApplied).toBe(30);
      expect(res.body.progress.theta).toBe(1170);
      expect((await abilityRow(tenant, student.id, syllabus.subtopicId))!.last_decay_applied_at).not.toBeNull();
    });

    it('refuses a sub-topic the student cannot see', async () => {
      const { session, tenant, syllabus } = await arrange({ questions: 0 });
      const draft = await createSubtopic(tenant, syllabus.topicId, 'draft');
      expect((await start(session, draft)).status).toBe(404);
      expect((await start(session, randomUUID())).status).toBe(404);
    });

    it('will not run without an active engine configuration', async () => {
      const tenant = await createTenant();
      const session = await login(t, await createUser(tenant, 'STUDENT'), tenant.slug);
      const syllabus = await createSyllabus(tenant);
      const res = await start(session, syllabus.subtopicId);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'ENGINE_CONFIG_MISSING' });
      expect(res.body.error.requestId).toBeTruthy();
    });

    it('is closed to staff accounts, and students are closed out of admin data', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      const admin = await login(t, await createUser(tenant, 'ADMIN'), tenant.slug);
      expect((await start(admin, syllabus.subtopicId)).status).toBe(403);
      expect((await t.http().get('/v1/admin/questions').set(...bearer(session))).status).toBe(403);
    });

    it('needs a token at all', async () => {
      const { syllabus } = await arrange({ questions: 0 });
      expect((await t.http().post('/v1/practice/sessions').send({ subtopicId: syllabus.subtopicId })).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------ serving

  describe('serving questions', () => {
    it('serves a student-safe payload with no answer key and no engine difficulty', async () => {
      const { session, syllabus } = await arrange();
      const s = await start(session, syllabus.subtopicId);
      const res = await next(session, s.body.session.id as string);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.question).sort()).toEqual(
        ['difficultyLabel', 'expectedTimeSeconds', 'hintCount', 'id', 'options', 'stem', 'stemJson', 'subtopicId', 'type', 'version'].sort(),
      );
      expect(forbiddenKeyPaths(res.body)).toEqual([]);
      expect(res.body.item).toMatchObject({ position: 1, selectionReason: 'cold_start' });
      expect(res.body.session).toMatchObject({ servedCount: 1, answeredCount: 0 });
      expect(res.body.progress).toMatchObject({ theta: 1000, level: 2 });
    });

    it('returns the same question until it is answered, and marks it skipped on request', async () => {
      const { session, syllabus } = await arrange();
      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      const first = await next(session, sessionId);
      const again = await next(session, sessionId);
      expect(again.body.item.id).toBe(first.body.item.id);
      expect(again.body.session.servedCount).toBe(1);

      const skipped = await next(session, sessionId, '?skip=true');
      expect(skipped.body.item.id).not.toBe(first.body.item.id);
      expect(skipped.body.item.position).toBe(2);
      const { rows } = await db().query<{ status: string }>(`SELECT status FROM session_items WHERE id = $1`, [first.body.item.id]);
      expect(rows[0]!.status).toBe('skipped');
    });

    it('aims at the difficulty where the student has about a 72% chance', async () => {
      // b* = θ + 400·log10(1/0.72 − 1) ≈ 1000 − 164 ≈ 836, so 840 beats 600 and 1200.
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 600, stem: 'far too easy' });
      const target = await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 840, stem: 'about right' });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1200, stem: 'too hard' });
      const s = await start(session, syllabus.subtopicId);
      expect((await next(session, s.body.session.id as string)).body.question.id).toBe(target);
    });

    it('runs the configured number of placement questions before going adaptive', async () => {
      const { session, syllabus } = await arrange({ questions: 6, params: { placement: { question_count: 3 } } });
      const s = await start(session, syllabus.subtopicId);
      expect(s.body.session.mode).toBe('placement');
      const sessionId = s.body.session.id as string;
      const reasons: string[] = [];
      for (let i = 0; i < 4; i += 1) reasons.push((await play(session, sessionId, true)).served.item.selectionReason as string);
      expect(reasons).toEqual(['cold_start', 'placement', 'placement', 'adaptive']);
      const { rows } = await db().query<{ placement_status: string; placement_answered: number }>(
        `SELECT placement_status, placement_answered FROM ability_scores WHERE subtopic_id = $1`,
        [syllabus.subtopicId],
      );
      expect(rows[0]).toMatchObject({ placement_status: 'completed', placement_answered: 3 });
    });

    it('makes every 5th question of the session a probe, aimed above the usual target', async () => {
      const { session, syllabus } = await arrange({ questions: 8, params: { placement: { enabled: false } } });
      const s = await start(session, syllabus.subtopicId);
      expect(s.body.session.mode).toBe('adaptive');
      const sessionId = s.body.session.id as string;
      const reasons: string[] = [];
      for (let i = 0; i < 5; i += 1) reasons.push((await play(session, sessionId, true)).served.item.selectionReason as string);
      expect(reasons).toEqual(['cold_start', 'adaptive', 'adaptive', 'adaptive', 'probe']);

      const { rows } = await db().query<{ position: number; target_b: string; theta_at_serve: string }>(
        `SELECT position, target_b, theta_at_serve FROM session_items WHERE session_id = $1 ORDER BY position`,
        [sessionId],
      );
      const probe = rows[4]!;
      // half a level above b*; the configured bands are 200 θ points wide
      expect(Number(probe.target_b)).toBeCloseTo(Number(probe.theta_at_serve) + 400 * Math.log10(1 / 0.72 - 1) + 100, 1);
    });

    it('never serves the same question twice inside a session', async () => {
      const { session, syllabus } = await arrange({ questions: 6 });
      const s = await start(session, syllabus.subtopicId);
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push((await play(session, s.body.session.id as string, i % 2 === 0)).served.question.id as string);
      expect(new Set(ids).size).toBe(5);
    });
  });

  // ------------------------------------------------------------------ exclusions

  describe('exclusions and the content gap', () => {
    it('does not serve a question attempted inside the 30-day window, but does serve one from before it', async () => {
      const { tenant, student, session, syllabus, engineConfigId } = await arrange({ questions: 0 });
      const recent = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: 'seen 10 days ago' });
      const old = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: 'seen 40 days ago' });
      await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, recent, engineConfigId, { daysAgo: 10 });
      await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, old, engineConfigId, { daysAgo: 40 });

      const s = await start(session, syllabus.subtopicId);
      expect((await next(session, s.body.session.id as string)).body.question.id).toBe(old);
    });

    it('does not serve a near-duplicate of a question the student has already seen', async () => {
      const { tenant, student, session, syllabus, engineConfigId } = await arrange({ questions: 0 });
      const group = randomUUID();
      const seen = await insertPracticeQuestion(tenant, syllabus.subtopicId, { duplicateGroupId: group, stem: 'the original' });
      const duplicate = await insertPracticeQuestion(tenant, syllabus.subtopicId, { duplicateGroupId: group, stem: 'a near duplicate' });
      const unrelated = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: 'a different question' });
      await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, seen, engineConfigId, { daysAgo: 3 });

      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      expect(served.body.question.id).toBe(unrelated);
      expect(served.body.question.id).not.toBe(duplicate);
    });

    it('widens to the parent topic and opens one content-gap task when fewer than 5 are eligible', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 2 });
      const sibling = await createSubtopic(tenant, syllabus.topicId, 'published', 'Neighbouring sub-topic');
      for (let i = 0; i < 4; i += 1) await insertPracticeQuestion(tenant, sibling, { b: 830 + i, stem: `sibling question ${i}` });

      const s = await start(session, syllabus.subtopicId);
      const res = await next(session, s.body.session.id as string);
      expect(res.status).toBe(200);
      expect(res.body.contentGap).toMatchObject({ minEligible: 5, widenedToParentTopic: true });
      expect(res.body.contentGap.eligibleCount).toBe(6);

      const openTasks = async () =>
        (
          await db().query<{ n: string }>(
            `SELECT count(*) AS n FROM review_tasks WHERE tenant_id = $1 AND subtopic_id = $2 AND kind = 'content_gap' AND status = 'open'`,
            [tenant.id, syllabus.subtopicId],
          )
        ).rows[0]!.n;
      expect(await openTasks()).toBe('1');
      await next(session, s.body.session.id as string, '?skip=true');
      expect(await openTasks()).toBe('1'); // asking again does not pile up alerts
    });

    it('reports no content gap when the sub-topic has a healthy pool', async () => {
      const { session, syllabus } = await arrange({ questions: 6 });
      const s = await start(session, syllabus.subtopicId);
      expect((await next(session, s.body.session.id as string)).body.contentGap).toBeUndefined();
    });

    it('says plainly when a sub-topic has nothing to practise', async () => {
      const { session, syllabus } = await arrange({ questions: 0 });
      const s = await start(session, syllabus.subtopicId);
      const res = await next(session, s.body.session.id as string);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'NO_ELIGIBLE_QUESTIONS' });
    });
  });

  // ------------------------------------------------------------------ attempts

  describe('attempts and the ability update', () => {
    it('updates θ on a correct answer with K_s = 32 for a new student', async () => {
      // θ = b = 1000 → E = 0.5; K_s = 32 (first 20 attempts), question calibrated → θ' = 1016
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, calibrationN: 50 });
      const s = await start(session, syllabus.subtopicId);
      const { result } = await play(session, s.body.session.id as string, true);
      // θ' = 1016 is 1000 + 32 × (1 − E) with E = 0.5, so the assertion below is what proves the
      // engine used E = 0.5 — and E itself is deliberately not in the payload (see the next test).
      expect(result.progress).toMatchObject({ theta: 1016, attemptsCount: 1, gradedCount: 1, correctCount: 1 });
      expect(result).toMatchObject({ outcome: 'correct', score: 1, correct: true, probableGuess: false, replayed: false });
      expect(result.revealedAnswer).toEqual({ optionKeys: ['A'] });
    });

    it('never returns the expected score, which would let a student solve for the question difficulty', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, calibrationN: 50 });
      const s = await start(session, syllabus.subtopicId);
      const { result } = await play(session, s.body.session.id as string, true);

      // E = 1/(1+10^((b−θ)/elo_scale)) and θ is in `progress`, so publishing E publishes b —
      // and difficulty_b is a column the student projection forbids.
      expect(result).not.toHaveProperty('expectedScore');
      expect(JSON.stringify(result)).not.toContain('expectedScore');

      // It is still recorded on the attempt, which is what the ability projection replays from.
      const { rows } = await db().query<{ expected_score: string }>(
        `SELECT expected_score FROM attempts WHERE id = $1`,
        [result.attemptId],
      );
      expect(Number(rows[0]!.expected_score)).toBeCloseTo(0.5, 6);
    });

    it('updates θ downwards on a wrong answer', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, calibrationN: 50 });
      const s = await start(session, syllabus.subtopicId);
      const { result } = await play(session, s.body.session.id as string, false);
      expect(result.progress).toMatchObject({ theta: 984, gradedCount: 1, correctCount: 0 });
      expect(result).toMatchObject({ outcome: 'incorrect', score: 0, correct: false });
    });

    it('drops K_s to 16 once the student is past their first 20 attempts', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, calibrationN: 50 });
      const s = await start(session, syllabus.subtopicId);
      await setAbility(tenant, student.id, syllabus.subtopicId, { gradedCount: 25, attemptsCount: 25, theta: 1000, placementStatus: 'completed' });
      expect((await play(session, s.body.session.id as string, true)).result.progress.theta).toBe(1008);
    });

    it('halves K_s against a barely calibrated question, which itself moves by K_q = 24', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      const q = await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, calibrationN: 4 });
      const s = await start(session, syllabus.subtopicId);
      expect((await play(session, s.body.session.id as string, true)).result.progress.theta).toBe(1008); // 32 × 0.5

      const { rows } = await db().query<{ difficulty_b: string; calibration_n: number }>(
        `SELECT difficulty_b, calibration_n FROM questions WHERE id = $1`,
        [q],
      );
      expect(Number(rows[0]!.difficulty_b)).toBe(988); // 1000 − 24 × 0.5
      expect(rows[0]!.calibration_n).toBe(5);
    });

    it('moves a calibrated question by K_q = 8', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      const q = await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, calibrationN: 60 });
      const s = await start(session, syllabus.subtopicId);
      await play(session, s.body.session.id as string, false);
      const { rows } = await db().query<{ difficulty_b: string; calibration_n: number }>(
        `SELECT difficulty_b, calibration_n FROM questions WHERE id = $1`,
        [q],
      );
      expect(Number(rows[0]!.difficulty_b)).toBe(1004); // 1000 + 8 × 0.5
      expect(rows[0]!.calibration_n).toBe(61);
    });

    it('stores everything needed to replay the update, and chains θ across attempts', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 3 });
      const s = await start(session, syllabus.subtopicId);
      const first = await play(session, s.body.session.id as string, true);
      const second = await play(session, s.body.session.id as string, false);

      const { rows } = await db().query<Json>(
        `SELECT theta_before, difficulty_b_at_attempt, difficulty_label_at_attempt, expected_score, engine_config_id,
                question_version, is_probe, is_placement, probable_guess, total_time_ms, answer_changes, hint_count,
                device_type, response, outcome
           FROM attempts WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, id`,
        [tenant.id, student.id],
      );
      expect(rows).toHaveLength(2);
      expect(Number(rows[0]!.theta_before)).toBe(1000);
      expect(Number(rows[1]!.theta_before)).toBe(first.result.progress.theta);
      expect(second.result.progress.theta).not.toBe(first.result.progress.theta);
      expect(rows[0]).toMatchObject({ is_probe: false, is_placement: false, probable_guess: false, device_type: 'unknown' });
      expect(rows[0]!.engine_config_id).toBeTruthy();
      const { rows: live } = await db().query<{ version: number }>(`SELECT version FROM questions WHERE id = $1`, [first.result.questionId]);
      expect(rows[0]!.question_version).toBe(live[0]!.version); // graded against the version that was served
      expect(rows[0]!.response).toEqual({ option_keys: ['A'] });
      expect(rows[1]).toMatchObject({ is_placement: true, outcome: 'incorrect' }); // the second question of the placement phase
      expect(Number(rows[0]!.difficulty_b_at_attempt)).toBeGreaterThan(0);
    });

    it('refuses to let a recorded attempt be changed or deleted', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 2 });
      const s = await start(session, syllabus.subtopicId);
      await play(session, s.body.session.id as string, true);
      const { rows } = await db().query<{ id: string }>(`SELECT id FROM attempts WHERE tenant_id = $1 AND user_id = $2`, [tenant.id, student.id]);
      const id = rows[0]!.id;
      await expect(db().query(`UPDATE attempts SET score = 0 WHERE id = $1`, [id])).rejects.toMatchObject({ code: 'AP001' });
      await expect(db().query(`DELETE FROM attempts WHERE id = $1`, [id])).rejects.toMatchObject({ code: 'AP001' });
    });

    it('grades on the server and refuses a payload that tries to assert correctness', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000 });
      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      const claimed = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .set('Idempotency-Key', uniq('claimed'))
        .send({ sessionItemId: served.body.item.id, response: { optionKeys: ['B'] }, totalTimeMs: 30_000, outcome: 'correct', score: 1, correct: true });
      expect(claimed.status).toBe(400);
      expect(claimed.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['outcome', 'score', 'correct']));

      const honest = await answer(session, served.body.item.id as string, { optionKeys: ['B'] });
      expect(honest.body).toMatchObject({ outcome: 'incorrect', score: 0, correct: false });
    });

    it('rejects a malformed answer with a field-level message', async () => {
      const { session, syllabus } = await arrange({ questions: 2 });
      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      const res = await answer(session, served.body.item.id as string, { optionKeys: ['Z'] });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toMatchObject({ field: 'response.optionKeys' });
    });

    it('is idempotent: the same key returns the stored attempt and never grades twice', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 2 });
      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      const key = uniq('idem');
      const first = await answer(session, served.body.item.id as string, { optionKeys: ['A'] }, { key });
      const replay = await answer(session, served.body.item.id as string, { optionKeys: ['B'] }, { key, totalTimeMs: 999 });
      expect(first.body).toMatchObject({ replayed: false, outcome: 'correct' });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ replayed: true, attemptId: first.body.attemptId, outcome: 'correct', score: 1 });
      expect(replay.body.progress).toEqual(first.body.progress);

      const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM attempts WHERE tenant_id = $1 AND user_id = $2`, [tenant.id, student.id]);
      expect(rows[0]!.n).toBe('1');
      expect((await abilityRow(tenant, student.id, syllabus.subtopicId))!.attempts_count).toBe(1);
    });

    it('refuses a second answer to the same served question under a different key', async () => {
      const { session, syllabus } = await arrange({ questions: 2 });
      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      await answer(session, served.body.item.id as string, { optionKeys: ['A'] });
      const second = await answer(session, served.body.item.id as string, { optionKeys: ['B'] });
      expect(second.status).toBe(409);
      expect(second.body.error).toMatchObject({ code: 'INVALID_STATE' });
    });

    it('refuses to replay one item’s result for a different item under the same key', async () => {
      // The idempotency key made the first answer safe to retry. Reusing it for a *different*
      // question used to return the first question's result — including whether it was correct —
      // so a client with a fixed key could read one answer and have it reported for another.
      const { tenant, session, syllabus } = await arrange({ questions: 3 });
      const s = await start(session, syllabus.subtopicId);
      const key = uniq('reused-key');

      const first = await next(session, s.body.session.id as string);
      const firstResult = await answer(session, first.body.item.id as string, { optionKeys: ['A'] }, { key });
      expect(firstResult.status).toBe(201);

      const second = await next(session, s.body.session.id as string);
      expect(second.body.item.id).not.toBe(first.body.item.id);
      const replayed = await answer(session, second.body.item.id as string, { optionKeys: ['A'] }, { key });

      expect(replayed.status).toBe(409);
      expect(replayed.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      // Nothing was recorded for the second item, and the first attempt is untouched.
      const { rows } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM attempts WHERE tenant_id = $1 AND session_item_id = $2`,
        [tenant.id, second.body.item.id],
      );
      expect(rows[0]!.n).toBe('0');
    });

    it('still replays the same item under the same key, which is what the key is for', async () => {
      const { session, syllabus } = await arrange({ questions: 2 });
      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      const key = uniq('retry-key');
      const first = await answer(session, served.body.item.id as string, { optionKeys: ['A'] }, { key });
      const retry = await answer(session, served.body.item.id as string, { optionKeys: ['A'] }, { key });
      expect(retry.status).toBe(201);
      expect(retry.body.attemptId).toBe(first.body.attemptId);
    });

    it('answers a malformed response with 400, never a server error', async () => {
      // These pass DTO validation — the envelope is right — and used to reach a string method on a
      // number inside the grader, surfacing as a 500.
      const { session, syllabus } = await arrange({ questions: 4 });
      const s = await start(session, syllabus.subtopicId);
      const malformed: unknown[] = [{ optionKeys: 'A' }, { optionKeys: [1] }, { optionKeys: [null] }, { value: 4 }];
      for (const response of malformed) {
        const served = await next(session, s.body.session.id as string);
        expect(served.status).toBe(200);
        const res = await answer(session, served.body.item.id as string, response);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        // Skip the item so the next iteration is served a different question.
        await next(session, s.body.session.id as string, '?skip=true');
      }
    });

    it('needs an idempotency key at all', async () => {
      const { session, syllabus } = await arrange({ questions: 2 });
      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      const res = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .send({ sessionItemId: served.body.item.id, response: { optionKeys: ['A'] }, totalTimeMs: 1000 });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('Idempotency-Key');
    });
  });

  // ------------------------------------------------------------------ §6.4 expected time

  describe('the expected time is replaced by the observed median', () => {
    /**
     * 29 answered attempts by other students, at known times, and `calibration_n` set to match.
     * The question is then one graded attempt away from the stated threshold of 30.
     */
    async function nearThreshold(times: number[], opts: { guessTimes?: number[] } = {}) {
      const f = await arrange({ questions: 1, question: { b: 1000, expectedTimeSeconds: 90 } });
      const questionId = f.questionIds[0]!;
      for (const [i, ms] of times.entries()) {
        const other = await createUser(f.tenant, 'STUDENT');
        await insertHistoricalAttempt(f.tenant, other.id, f.syllabus.subtopicId, questionId, f.engineConfigId, {
          daysAgo: 30 - i,
          correct: true,
          totalTimeMs: ms,
        });
      }
      for (const [i, ms] of (opts.guessTimes ?? []).entries()) {
        const other = await createUser(f.tenant, 'STUDENT');
        await insertHistoricalAttempt(f.tenant, other.id, f.syllabus.subtopicId, questionId, f.engineConfigId, {
          daysAgo: 60 - i,
          correct: false,
          totalTimeMs: ms,
          probableGuess: true,
        });
      }
      await db().query(`UPDATE questions SET calibration_n = $2 WHERE id = $1`, [questionId, times.length]);
      return { ...f, questionId };
    }

    const questionRow = async (questionId: string) => {
      const { rows } = await db().query<{ expected_time_seconds: number; version: number; calibration_n: number }>(
        `SELECT expected_time_seconds, version, calibration_n FROM questions WHERE id = $1`,
        [questionId],
      );
      return rows[0]!;
    };

    it('leaves the admin estimate alone below the stated threshold', async () => {
      // 28 attempts, so the attempt submitted below is the 29th: still short of 30.
      const f = await nearThreshold(Array.from({ length: 28 }, (_, i) => (100 + i) * 1000));
      const started = await start(f.session, f.syllabus.subtopicId);
      await play(f.session, started.body.session.id as string, true, { totalTimeMs: 128_000 });
      const row = await questionRow(f.questionId);
      expect(row.calibration_n).toBe(29);
      expect(row.expected_time_seconds).toBe(90); // what the admin set
    });

    it('replaces it with the observed median on the attempt that reaches the threshold', async () => {
      // 29 stored attempts at 100 s…128 s. The 30th, below, is answered in 129 s, so the median of
      // 100…129 is 114.5 s and the stored value becomes 115.
      const f = await nearThreshold(Array.from({ length: 29 }, (_, i) => (100 + i) * 1000));
      const versionBefore = (await questionRow(f.questionId)).version;
      const started = await start(f.session, f.syllabus.subtopicId);
      const { result } = await play(f.session, started.body.session.id as string, true, { totalTimeMs: 129_000 });

      const row = await questionRow(f.questionId);
      expect(row.calibration_n).toBe(30);
      expect(row.expected_time_seconds).toBe(115);

      // Replay determinism, the two halves of it.
      // Calibration is not an edit, so the version does not move and cached explanations survive.
      expect(row.version).toBe(versionBefore);
      const { rows: snapshot } = await db().query<{ expected_time_seconds_at_attempt: number }>(
        `SELECT expected_time_seconds_at_attempt FROM attempts WHERE id = $1`,
        [result.attemptId as string],
      );
      // The attempt that triggered the change is still measured against the value in force when the
      // student answered it — not against the value it caused.
      expect(snapshot[0]!.expected_time_seconds_at_attempt).toBe(90);

      // And it is on the record, attributed to the engine rather than to the student who happened
      // to submit the thirtieth attempt.
      const { rows: audit } = await db().query<{ actor_role: string; before: unknown; after: unknown }>(
        `SELECT actor_role, before, after FROM audit_log
          WHERE tenant_id = $1 AND entity_id = $2 AND action = 'question.expected_time_recalibrated'`,
        [f.tenant.id, f.questionId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_role).toBe('SYSTEM');
      expect(audit[0]!.before).toMatchObject({ expectedTimeSeconds: 90 });
      expect(audit[0]!.after).toMatchObject({ expectedTimeSeconds: 115 });
    });

    it('does not let rushed guesses drag the expected time down', async () => {
      // The same 29 attempts, plus ten three-second guesses. Counting the guesses would put the
      // median near 100 s; excluding them leaves it where the students who actually worked put it.
      const f = await nearThreshold(
        Array.from({ length: 29 }, (_, i) => (100 + i) * 1000),
        { guessTimes: Array.from({ length: 10 }, () => 3_000) },
      );
      const started = await start(f.session, f.syllabus.subtopicId);
      await play(f.session, started.body.session.id as string, true, { totalTimeMs: 129_000 });
      expect((await questionRow(f.questionId)).expected_time_seconds).toBe(115);
    });

    it('stops changing once the median has settled, rather than rewriting it per attempt', async () => {
      const f = await nearThreshold(Array.from({ length: 29 }, (_, i) => (100 + i) * 1000));
      const started = await start(f.session, f.syllabus.subtopicId);
      await play(f.session, started.body.session.id as string, true, { totalTimeMs: 129_000 });
      expect((await questionRow(f.questionId)).expected_time_seconds).toBe(115);

      // A 31st attempt answered at exactly the median leaves the median where it is.
      const other = await createUser(f.tenant, 'STUDENT');
      const otherSession = await login(t, other, f.tenant.slug);
      const started2 = await start(otherSession, f.syllabus.subtopicId);
      await play(otherSession, started2.body.session.id as string, true, { totalTimeMs: 115_000 });

      const row = await questionRow(f.questionId);
      expect(row.calibration_n).toBe(31);
      expect(row.expected_time_seconds).toBe(115);
      // One audit row, not two: the statement's own WHERE clause skipped the second write, so a
      // popular question does not accumulate an audit row per attempt for a value that never moved.
      // (test/sql/110 asserts the no-row property of the statement directly.)
      const { rows: audit } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE entity_id = $1 AND action = 'question.expected_time_recalibrated'`,
        [f.questionId],
      );
      expect(audit[0]!.n).toBe('1');
    });

    it('never stores a value outside the range an admin could have typed', async () => {
      // A cohort that answers in a second each. The configured floor is the same one the
      // questions_expected_time_range CHECK enforces, so calibration cannot drive the expected
      // time to zero and make every subsequent answer look like a guess.
      const f = await nearThreshold(Array.from({ length: 29 }, () => 1_000));
      const started = await start(f.session, f.syllabus.subtopicId);
      await play(f.session, started.body.session.id as string, true, { totalTimeMs: 1_000 });
      const row = await questionRow(f.questionId);
      expect(row.expected_time_seconds).toBe(5); // the floor, not 1
    });
  });

  // ------------------------------------------------------------------ probable guesses

  describe('probable guesses', () => {
    it('records a rushed wrong answer but leaves θ and the ladder untouched', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, expectedTimeSeconds: 60 });
      const s = await start(session, syllabus.subtopicId);
      const { result } = await play(session, s.body.session.id as string, false, { totalTimeMs: 5_000 }); // under 25% of 60s
      expect(result).toMatchObject({ probableGuess: true, outcome: 'incorrect', score: 0 });
      expect(result.progress).toMatchObject({ theta: 1000, attemptsCount: 1, gradedCount: 1 });

      expect((await abilityRow(tenant, student.id, syllabus.subtopicId))!.consecutive_incorrect).toBe(0);
      const { rows } = await db().query<{ probable_guess: boolean }>(`SELECT probable_guess FROM attempts WHERE user_id = $1`, [student.id]);
      expect(rows[0]!.probable_guess).toBe(true);
    });

    it('does not flag a fast CORRECT answer', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000, expectedTimeSeconds: 60 });
      const s = await start(session, syllabus.subtopicId);
      const { result } = await play(session, s.body.session.id as string, true, { totalTimeMs: 2_000 });
      expect(result.probableGuess).toBe(false);
      expect(result.progress.theta as number).toBeGreaterThan(1000);
    });

    it('pauses the session after three flagged guesses and serves nothing more', async () => {
      const { session, syllabus } = await arrange({ questions: 6, question: { expectedTimeSeconds: 60 } });
      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      for (let i = 0; i < 2; i += 1) {
        const { result } = await play(session, sessionId, false, { totalTimeMs: 3_000 });
        expect(result.session.paused).toBe(false);
      }
      const third = await play(session, sessionId, false, { totalTimeMs: 3_000 });
      expect(third.result.session.paused).toBe(true);
      expect(third.result.progress.level).toBe(2); // no demotion: guesses never reach the ladder

      const blocked = await next(session, sessionId);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatchObject({ code: 'SESSION_PAUSED' });
      expect((await t.http().get(`/v1/practice/sessions/${sessionId}`).set(...bearer(session))).body.paused).toBe(true);
    });
  });

  // ------------------------------------------------------------------ the ladder

  describe('the level ladder', () => {
    it('promotes after two consecutive correct answers inside the expected time', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 4, question: { expectedTimeSeconds: 60 } });
      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      expect((await play(session, sessionId, true, { totalTimeMs: 30_000 })).result.level.change).toBe('unchanged');
      const second = await play(session, sessionId, true, { totalTimeMs: 30_000 });
      expect(second.result.level).toMatchObject({ change: 'promoted', rule: 'consecutive_correct', blockedBy: null });
      expect(second.result.progress.level).toBe(3);

      const ability = (await abilityRow(tenant, student.id, syllabus.subtopicId))!;
      expect(ability.level).toBe(3);
      expect(ability.ladder_reset_at).not.toBeNull();
    });

    it('does not promote when the answers took longer than 1.25× the expected time', async () => {
      const { session, syllabus } = await arrange({ questions: 4, question: { expectedTimeSeconds: 60 } });
      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      await play(session, sessionId, true, { totalTimeMs: 200_000 });
      const second = await play(session, sessionId, true, { totalTimeMs: 200_000 });
      expect(second.result.level).toMatchObject({ change: 'unchanged', rule: null });
      expect(second.result.progress.level).toBe(2);
    });

    it('resets the ladder counters on a change, so the next level has to be earned again', async () => {
      const { session, syllabus } = await arrange({ questions: 8, question: { expectedTimeSeconds: 60 } });
      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      await play(session, sessionId, true, { totalTimeMs: 20_000 });
      expect((await play(session, sessionId, true, { totalTimeMs: 20_000 })).result.level.change).toBe('promoted');
      expect((await play(session, sessionId, true, { totalTimeMs: 20_000 })).result.level.change).toBe('unchanged');
      const fourth = await play(session, sessionId, true, { totalTimeMs: 20_000 });
      expect(fourth.result.level.change).toBe('promoted');
      expect(fourth.result.progress.level).toBe(4);
    });

    it('demotes after two consecutive wrong answers', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 4 });
      const s = await start(session, syllabus.subtopicId);
      await setAbility(tenant, student.id, syllabus.subtopicId, { level: 3, theta: 1200 });
      const sessionId = s.body.session.id as string;
      expect((await play(session, sessionId, false)).result.level.change).toBe('unchanged');
      const second = await play(session, sessionId, false);
      expect(second.result.level).toMatchObject({ change: 'demoted', rule: 'consecutive_incorrect' });
      expect(second.result.progress.level).toBe(2);
    });

    it('never demotes below L1', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 4 });
      const s = await start(session, syllabus.subtopicId);
      await setAbility(tenant, student.id, syllabus.subtopicId, { level: 1, theta: 800 });
      const sessionId = s.body.session.id as string;
      await play(session, sessionId, false);
      const second = await play(session, sessionId, false);
      expect(second.result.level).toMatchObject({ change: 'unchanged', rule: 'consecutive_incorrect', blockedBy: 'l1_protection' });
      expect(second.result.progress.level).toBe(1);
    });

    it('lets a failed probe move θ but keeps it out of the demotion counters', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 8, params: { probe: { every_n: 2 } } });
      const s = await start(session, syllabus.subtopicId);
      await setAbility(tenant, student.id, syllabus.subtopicId, {
        level: 3,
        theta: 1200,
        gradedCount: 10,
        attemptsCount: 10,
        placementStatus: 'completed',
      });
      const sessionId = s.body.session.id as string;

      const first = await play(session, sessionId, false);
      expect(first.served.item.selectionReason).toBe('adaptive');
      const probe = await play(session, sessionId, false);
      expect(probe.served.item.selectionReason).toBe('probe');
      expect(probe.result.level).toMatchObject({ change: 'unchanged', rule: null });
      expect(probe.result.progress.level).toBe(3);
      expect(probe.result.progress.theta as number).toBeLessThan(first.result.progress.theta as number);

      const { rows } = await db().query<{ is_probe: boolean }>(`SELECT is_probe FROM attempts WHERE user_id = $1 ORDER BY created_at, id`, [student.id]);
      expect(rows.map((r) => r.is_probe)).toEqual([false, true]);
    });
  });

  // ------------------------------------------------------------------ session state

  describe('session state', () => {
    it('counts what was served and answered, and ends cleanly', async () => {
      const { session, syllabus } = await arrange({ questions: 4 });
      const s = await start(session, syllabus.subtopicId, { targetQuestionCount: 10, deviceType: 'desktop' });
      const sessionId = s.body.session.id as string;
      await play(session, sessionId, true);
      await next(session, sessionId); // served, left unanswered

      const state = await t.http().get(`/v1/practice/sessions/${sessionId}`).set(...bearer(session));
      expect(state.body).toMatchObject({ servedCount: 2, answeredCount: 1, status: 'active', targetQuestionCount: 10 });

      const ended = await t.http().post(`/v1/practice/sessions/${sessionId}/end`).set(...bearer(session)).send({});
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({ status: 'completed' });
      expect(ended.body.endedAt).not.toBeNull();

      const { rows } = await db().query<{ status: string }>(`SELECT status FROM session_items WHERE session_id = $1 ORDER BY position`, [sessionId]);
      expect(rows.map((r) => r.status)).toEqual(['answered', 'abandoned']);
      expect((await next(session, sessionId)).status).toBe(409);
      expect((await t.http().post(`/v1/practice/sessions/${sessionId}/end`).set(...bearer(session)).send({})).status).toBe(409);
    });

    it('records focus events once, and only the event types the platform allows', async () => {
      const { session, syllabus } = await arrange({ questions: 2 });
      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      expect(s.body.session.focusTrackingEnabled).toBe(true);
      const event = { clientEventId: randomUUID(), eventType: 'visibility_hidden', occurredAt: new Date().toISOString(), durationMs: 4200 };

      const accepted = await t.http().post(`/v1/practice/sessions/${sessionId}/events`).set(...bearer(session)).send({ events: [event] });
      expect(accepted.status).toBe(202);
      expect(accepted.body).toMatchObject({ accepted: 1, received: 1 });

      const replayed = await t.http().post(`/v1/practice/sessions/${sessionId}/events`).set(...bearer(session)).send({ events: [event] });
      expect(replayed.body).toMatchObject({ accepted: 0, received: 1 });

      // no keystroke logging, no camera, no screen recording, no geolocation: those types do not exist
      for (const eventType of ['keystroke', 'screenshot', 'camera_frame', 'geolocation']) {
        const rejected = await t
          .http()
          .post(`/v1/practice/sessions/${sessionId}/events`)
          .set(...bearer(session))
          .send({ events: [{ clientEventId: randomUUID(), eventType, occurredAt: new Date().toISOString() }] });
        expect(rejected.status).toBe(400);
      }
    });

    it('refuses focus events when the organisation has tracking switched off', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 2 });
      await db().query(`UPDATE tenants SET focus_tracking_enabled = false WHERE id = $1`, [tenant.id]);
      const s = await start(session, syllabus.subtopicId);
      expect(s.body.session.focusTrackingEnabled).toBe(false);
      const res = await t
        .http()
        .post(`/v1/practice/sessions/${s.body.session.id}/events`)
        .set(...bearer(session))
        .send({ events: [{ clientEventId: randomUUID(), eventType: 'idle_start', occurredAt: new Date().toISOString() }] });
      expect(res.status).toBe(409);
    });
  });

  // ------------------------------------------------------------------ isolation

  describe('tenant and student isolation', () => {
    let a: Awaited<ReturnType<typeof arrange>>;
    let b: Awaited<ReturnType<typeof arrange>>;
    let sessionA: string;
    let itemA: string;

    beforeAll(async () => {
      a = await arrange({ questions: 3 });
      b = await arrange({ questions: 3 });
      const s = await start(a.session, a.syllabus.subtopicId);
      sessionA = s.body.session.id as string;
      itemA = (await next(a.session, sessionA)).body.item.id as string;
    });

    it('hides another organisation’s session', async () => {
      expect((await t.http().get(`/v1/practice/sessions/${sessionA}`).set(...bearer(b.session))).status).toBe(404);
      expect((await next(b.session, sessionA)).status).toBe(404);
      expect((await t.http().post(`/v1/practice/sessions/${sessionA}/end`).set(...bearer(b.session)).send({})).status).toBe(404);
      expect((await t.http().post(`/v1/practice/sessions/${sessionA}/events`).set(...bearer(b.session)).send({ events: [] })).status).toBe(404);
    });

    it('refuses an attempt against another organisation’s served question', async () => {
      expect((await answer(b.session, itemA, { optionKeys: ['A'] })).status).toBe(404);
    });

    it('refuses a session on another organisation’s sub-topic', async () => {
      expect((await start(b.session, a.syllabus.subtopicId)).status).toBe(404);
    });

    it('keeps one student out of another student’s session in the same organisation', async () => {
      const other = await login(t, await createUser(a.tenant, 'STUDENT'), a.tenant.slug);
      expect((await next(other, sessionA)).status).toBe(404);
      expect((await answer(other, itemA, { optionKeys: ['A'] })).status).toBe(404);
    });

    it('writes every practice row under the acting organisation', async () => {
      const { rows } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM sessions s
           JOIN session_items i ON i.session_id = s.id
          WHERE s.id = $1 AND (s.tenant_id <> $2 OR i.tenant_id <> $2)`,
        [sessionA, a.tenant.id],
      );
      expect(rows[0]!.n).toBe('0');
    });
  });

  // ------------------------------------------------------------------ the projection

  describe('the ability projection is only a projection', () => {
    const rebuilder = () => t.app.get(AbilityRebuildService);

    it('rebuilds to exactly the stored row after a mixed history', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 8, question: { expectedTimeSeconds: 60 } });
      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      await play(session, sessionId, true, { totalTimeMs: 20_000 }); // fast correct
      await play(session, sessionId, true, { totalTimeMs: 20_000 }); // promotes
      await play(session, sessionId, false, { totalTimeMs: 50_000 }); // slow wrong
      await play(session, sessionId, false, { totalTimeMs: 4_000 }); // probable guess
      await play(session, sessionId, true, { totalTimeMs: 90_000 }); // correct but slow

      const stored = (await abilityRow(tenant, student.id, syllabus.subtopicId))!;
      const outcome = await rebuilder().rebuild(tenant.id, student.id, syllabus.subtopicId);
      expect(outcome.differences).toEqual([]);
      expect(outcome).toMatchObject({ exact: true, unreplayableAttempts: 0, outOfBandThetaAdjustment: 0, guessVerdictMismatches: 0, written: false });
      expect(outcome.ability.theta).toBe(Number(stored.theta));
      expect(outcome.ability.level).toBe(stored.level);
      expect(outcome.ability.attemptsCount).toBe(5);
      expect(outcome.ability.gradedCount).toBe(5);
    });

    it('repairs a projection that was tampered with, from the attempts alone', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 4 });
      const s = await start(session, syllabus.subtopicId);
      await play(session, s.body.session.id as string, true);
      await play(session, s.body.session.id as string, false);
      const before = (await abilityRow(tenant, student.id, syllabus.subtopicId))!;

      await db().query(
        `UPDATE ability_scores SET theta = 1, level = 5, correct_count = 0, consecutive_correct = 2, consecutive_incorrect = 0
          WHERE tenant_id = $1 AND user_id = $2 AND subtopic_id = $3`,
        [tenant.id, student.id, syllabus.subtopicId],
      );
      const broken = await rebuilder().rebuild(tenant.id, student.id, syllabus.subtopicId);
      expect(broken.differences).toEqual(expect.arrayContaining(['theta', 'level', 'correct_count', 'consecutive_correct']));
      expect(broken.written).toBe(false); // a dry run changes nothing

      const repaired = await rebuilder().rebuild(tenant.id, student.id, syllabus.subtopicId, { write: true });
      expect(repaired.written).toBe(true);
      const after = (await abilityRow(tenant, student.id, syllabus.subtopicId))!;
      expect(Number(after.theta)).toBe(Number(before.theta));
      expect(after.level).toBe(before.level);
      expect(after.correct_count).toBe(before.correct_count);
      expect(after.consecutive_incorrect).toBe(before.consecutive_incorrect);
      expect((await rebuilder().rebuild(tenant.id, student.id, syllabus.subtopicId)).differences).toEqual([]);
    });

    it('accounts for inactivity decay instead of silently diverging', async () => {
      const { tenant, student, session, syllabus } = await arrange({ questions: 4 });
      const first = await start(session, syllabus.subtopicId);
      await play(session, first.body.session.id as string, true);
      await db().query(`UPDATE ability_scores SET last_attempt_at = now() - interval '40 days' WHERE tenant_id = $1 AND user_id = $2`, [
        tenant.id,
        student.id,
      ]);
      await db().query(`UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = $1`, [first.body.session.id]);
      const reopened = await start(session, syllabus.subtopicId);
      expect(reopened.body.decayApplied).toBe(30);
      await play(session, reopened.body.session.id as string, true);

      const outcome = await rebuilder().rebuild(tenant.id, student.id, syllabus.subtopicId);
      expect(outcome.differences).toEqual([]);
      expect(outcome.outOfBandThetaAdjustment).toBe(-30);
      expect(outcome.exact).toBe(true);
    });

    it('cannot reach another organisation’s attempts', async () => {
      const a = await arrange({ questions: 2 });
      const b = await arrange({ questions: 2 });
      const s = await start(a.session, a.syllabus.subtopicId);
      await play(a.session, s.body.session.id as string, true);

      await expect(rebuilder().rebuild(b.tenant.id, a.student.id, a.syllabus.subtopicId)).rejects.toThrow(/no attempts/);
      const own = await rebuilder().rebuild(a.tenant.id, a.student.id, a.syllabus.subtopicId);
      expect(own.ability.attemptsCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------ leakage

  // ------------------------------------------------------------------ the time the engine believes

  describe('the answer time the engine believes', () => {
    const storedAttempt = async (itemId: string) =>
      (await db().query(`SELECT total_time_ms, ttfi_ms, probable_guess FROM attempts WHERE session_item_id = $1`, [itemId])).rows[0] as Json;

    async function serveOne(options: Parameters<typeof arrange>[0] = { questions: 1 }) {
      const f = await arrange(options);
      const s = await start(f.session, f.syllabus.subtopicId);
      const served = await next(f.session, s.body.session.id as string);
      return { ...f, itemId: served.body.item.id as string };
    }

    it('cuts a reported time the clock cannot account for down to what the server saw', async () => {
      const { session, itemId } = await serveOne();
      // The question was served a moment ago, yet the browser claims 5 minutes — which would pass it off as a slow, careful answer.
      const res = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .set('Idempotency-Key', uniq('claimed-time'))
        .send({ sessionItemId: itemId, response: { optionKeys: ['A'] }, totalTimeMs: 300_000, ttfiMs: 250_000 });
      expect(res.status).toBe(201);
      const row = await storedAttempt(itemId);
      expect(row.total_time_ms).toBeLessThan(10_000);
      expect(row.ttfi_ms).toBeLessThanOrEqual(row.total_time_ms);
    });

    it('cannot be used to dodge the rushed-answer rule by claiming a long time', async () => {
      // A wrong answer given at once is a probable guess (under 25% of the expected 60 s). Claiming 4 minutes does not undo that.
      const { session, itemId } = await serveOne({ questions: 1, question: { expectedTimeSeconds: 60 } });
      const res = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .set('Idempotency-Key', uniq('dodge'))
        .send({ sessionItemId: itemId, response: { optionKeys: ['B'] }, totalTimeMs: 240_000 });
      expect(res.status).toBe(201);
      expect((await storedAttempt(itemId)).probable_guess).toBe(true);
    });

    it('keeps an honest time, including one shorter than the question was open (the tab was elsewhere)', async () => {
      const { session, itemId } = await serveOne();
      await ageServedItem(itemId, 90_000);
      const res = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .set('Idempotency-Key', uniq('honest'))
        .send({ sessionItemId: itemId, response: { optionKeys: ['A'] }, totalTimeMs: 42_000, ttfiMs: 5_000 });
      expect(res.status).toBe(201);
      expect(await storedAttempt(itemId)).toMatchObject({ total_time_ms: 42_000, ttfi_ms: 5_000 });
    });

    it('allows a few seconds of timer rounding beyond the server\'s own measurement', async () => {
      const { session, itemId } = await serveOne();
      await ageServedItem(itemId, 30_000);
      const res = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .set('Idempotency-Key', uniq('rounding'))
        .send({ sessionItemId: itemId, response: { optionKeys: ['A'] }, totalTimeMs: 31_500 });
      expect(res.status).toBe(201);
      expect((await storedAttempt(itemId)).total_time_ms).toBe(31_500);
    });
  });

  describe('answer leakage on the practice path', () => {
    it('never carries an answer key, for any question type', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      const admin = await login(t, await createUser(tenant, 'ADMIN'), tenant.slug);
      const samples = questionSamples(syllabus.subtopicId);
      for (const sample of samples) {
        const created = await t.http().post('/v1/admin/questions').set(...bearer(admin)).send(sample.payload);
        expect(created.status).toBe(201);
        expect((await t.http().post(`/v1/admin/questions/${created.body.id}/publish`).set(...bearer(admin))).status).toBe(200);
      }

      const s = await start(session, syllabus.subtopicId);
      const sessionId = s.body.session.id as string;
      const secrets = samples.flatMap((sample) => sample.secrets);
      for (let i = 0; i < samples.length; i += 1) {
        const served = await next(session, sessionId, i === 0 ? '' : '?skip=true');
        expect(served.status).toBe(200);
        expect(forbiddenKeyPaths(served.body)).toEqual([]);
        const body = JSON.stringify(served.body);
        for (const secret of secrets) expect(body).not.toContain(secret);
      }
    });

    it('discloses the answer key only in the attempt result', async () => {
      const { tenant, session, syllabus } = await arrange({ questions: 0 });
      await insertPracticeQuestion(tenant, syllabus.subtopicId, { b: 1000 });
      const s = await start(session, syllabus.subtopicId);
      const served = await next(session, s.body.session.id as string);
      expect(JSON.stringify(served.body)).not.toContain('isCorrect');
      const result = await answer(session, served.body.item.id as string, { optionKeys: ['B'] });
      expect(result.body.revealedAnswer).toEqual({ optionKeys: ['A'] });
      expect(result.body.explanationAvailable).toBe(false);
    });
  });
});
