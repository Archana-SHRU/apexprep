import { AI_PRIMARY_PROVIDER, AiProviderError } from '../../src/ai/ai-provider';
import { GENERAL_KNOWLEDGE_NOTICE } from '../../src/explanations/visibility';
import {
  auditActions,
  bearer,
  closeDb,
  createEngineConfig,
  createSubtopic,
  createSyllabus,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertContentBlock,
  insertHistoricalAttempt,
  insertPracticeQuestion,
  login,
  uniq,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
  type UserFixture,
} from './helpers';
import { FakeAiProvider } from './fake-ai';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The explanation system end to end.
 *
 * The whole real path runs here — controller, guards, validation pipe, service, repository,
 * PostgreSQL, the grounding formula, the answer matcher, the visibility rules and the cache.
 * Only the provider at the network edge is replaced (`FakeAiProvider`), because no AI
 * credentials exist in this environment and a faked successful external call would prove
 * nothing. `fake.callCount` is what proves the cache: a regeneration would show up there.
 *
 * pgvector is not installed on this server, so semantic retrieval cannot run and the hybrid
 * search falls back to its keyword half. The tests assert that this is *reported* rather than
 * hidden, and the vector half is covered by the unit tests over the SQL it builds.
 */

interface TheoryBlock {
  text: string;
  title?: string;
  subtopicId?: string;
}

/** Theory the fake explanation is genuinely supported by, so grounding is earned, not stubbed. */
const THEORY: TheoryBlock = {
  title: 'Angular momentum about the contact point',
  text:
    'For a body rolling without slipping, friction acts at the contact point. Taking torque about the contact point therefore ' +
    'gives zero moment for friction, so angular momentum about the contact point is conserved throughout the motion. ' +
    'Solve the conservation equation for omega to obtain the final angular speed.',
};

/** A stem that shares stemmed terms with THEORY, so keyword retrieval can find it. */
const STEM = 'A ring rolls without slipping. Using angular momentum about the contact point, find the final angular speed omega.';

describe('Explanations (e2e)', () => {
  let t: TestApp;
  let noAi: TestApp;
  const fake = new FakeAiProvider();

  beforeAll(async () => {
    [t, noAi] = await Promise.all([createTestApp({}, [{ token: AI_PRIMARY_PROVIDER, value: fake }]), createTestApp()]);
  });
  afterAll(async () => {
    await Promise.all([t.close(), noAi.close()]);
    await closeDb();
  });
  beforeEach(() => {
    fake.reset();
  });

  interface Fixture {
    tenant: TenantFixture;
    student: UserFixture;
    session: Session;
    admin: Session;
    syllabus: SyllabusFixture;
    questionId: string;
    engineConfigId: string;
  }

  /**
   * A student who has answered a published question that has theory behind it — the state in
   * which an explanation is legitimately available.
   */
  async function arrange(
    options: {
      theory?: TheoryBlock[];
      params?: Record<string, unknown>;
      trackSlug?: string;
      trackKind?: string;
      correct?: boolean;
    } = {},
  ): Promise<Fixture> {
    const tenant = await createTenant();
    const student = await createUser(tenant, 'STUDENT');
    const adminUser = await createUser(tenant, 'ADMIN');
    const [session, admin, syllabus] = await Promise.all([
      login(t, student, tenant.slug),
      login(t, adminUser, tenant.slug),
      createSyllabus(tenant),
    ]);
    if (options.trackSlug) {
      await db().query(`UPDATE tracks SET slug = $2 WHERE id = $1`, [syllabus.trackId, options.trackSlug]);
    }
    if (options.trackKind) {
      await db().query(`UPDATE tracks SET kind = $2 WHERE id = $1`, [syllabus.trackId, options.trackKind]);
    }
    const engineConfigId = await createEngineConfig(tenant, options.params ?? {});
    const questionId = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: STEM });

    for (const [i, block] of (options.theory ?? [THEORY]).entries()) {
      await insertContentBlock(tenant, block.subtopicId ?? syllabus.subtopicId, { title: block.title ?? null, text: block.text, sortOrder: i });
    }
    await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, questionId, engineConfigId, {
      daysAgo: 1,
      correct: options.correct ?? true,
    });
    return { tenant, student, session, admin, syllabus, questionId, engineConfigId };
  }

  const explanation = (s: Session, questionId: string, app: TestApp = t) =>
    app.http().get(`/v1/questions/${questionId}/explanation`).set(...bearer(s));

  const adminExplanation = (s: Session, questionId: string, query = '') =>
    t.http().get(`/v1/admin/questions/${questionId}/explanation${query}`).set(...bearer(s));

  const report = (s: Session, questionId: string, body: Json = { reason: 'wrong_solution' }) =>
    t.http().post(`/v1/questions/${questionId}/report`).set(...bearer(s)).send(body);

  const approvedSolution = async (tenant: TenantFixture, questionId: string, body: string) => {
    await db().query(
      `INSERT INTO official_solutions (tenant_id, question_id, body, status, approved_at)
       VALUES ($1, $2, $3, 'approved', now())`,
      [tenant.id, questionId, body],
    );
  };

  const storedExplanations = async (tenant: TenantFixture, questionId: string) =>
    (
      await db().query<Json>(
        `SELECT id, source_tier, status, option_key, grounding_score, retrieval_scope, provider, model, prompt_version,
                grounding_block_ids, content
           FROM explanations WHERE tenant_id = $1 AND question_id = $2 ORDER BY generated_at, id`,
        [tenant.id, questionId],
      )
    ).rows;

  const reviewTasks = async (tenant: TenantFixture, questionId: string) =>
    (
      await db().query<Json>(
        `SELECT kind, status, priority, reason, explanation_id, reporter_user_id FROM review_tasks
          WHERE tenant_id = $1 AND question_id = $2 ORDER BY created_at, id`,
        [tenant.id, questionId],
      )
    ).rows;

  // ------------------------------------------------------------------ A: official solution wins

  describe('an approved official solution wins outright', () => {
    it('is served as the official solution, with no provider call at all', async () => {
      const f = await arrange();
      await approvedSolution(f.tenant, f.questionId, 'Take torque about the contact point. Angular momentum is conserved. Hence omega = v / R.');

      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ source: 'official_solution', notice: null, questionId: f.questionId, optionKey: null });
      expect(res.body.summary).toContain('Take torque about the contact point.');
      expect(fake.callCount).toBe(0);

      const rows = await storedExplanations(f.tenant, f.questionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source_tier: 'official_solution', status: 'active', provider: null, grounding_score: null });
    });

    it('beats the notes even when strong theory exists', async () => {
      const f = await arrange();
      await approvedSolution(f.tenant, f.questionId, 'The official worked solution, step by step. Therefore omega = v / R.');
      const res = await explanation(f.session, f.questionId);
      expect(res.body.source).toBe('official_solution');
      expect(fake.callCount).toBe(0);
    });

    it('is cached under no option key, so a student who answered wrongly still gets it from the cache', async () => {
      // An official solution has no per-distractor variants (the database forbids them), so it
      // has to be read back under a null option key whatever the student chose. Resolving it
      // under their wrong option would miss the cache on every single request.
      const f = await arrange({ correct: false });
      await approvedSolution(f.tenant, f.questionId, 'The official worked solution. Therefore omega = v / R.');

      const first = await explanation(f.session, f.questionId);
      expect(first.body).toMatchObject({ source: 'official_solution', optionKey: null });
      const second = await explanation(f.session, f.questionId);
      expect(second.body.id).toBe(first.body.id);
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(1);
    });

    it('is not resurrected as a new explanation once students have had it unpublished', async () => {
      const f = await arrange({ correct: false });
      await approvedSolution(f.tenant, f.questionId, 'The official worked solution. Therefore omega = v / R.');
      const served = await explanation(f.session, f.questionId);

      const sessions = [f.session];
      for (let i = 0; i < 2; i += 1) sessions.push(await login(t, await createUser(f.tenant, 'STUDENT'), f.tenant.slug));
      for (const s of sessions) await report(s, f.questionId);

      const after = await explanation(f.session, f.questionId);
      expect(after.status).toBe(409);
      expect(after.body.error.details[0]).toMatchObject({ message: 'unpublished_after_reports' });
      const rows = await storedExplanations(f.tenant, f.questionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: served.body.id, status: 'flagged' });
    });

    it('is not held for review even on a mandatory-approval track: a human wrote it', async () => {
      const f = await arrange({ trackSlug: `physics-olympiad-${uniq('x')}` });
      await approvedSolution(f.tenant, f.questionId, 'An official solution for an Olympiad question. Therefore omega = v / R.');
      expect((await explanation(f.session, f.questionId)).body.source).toBe('official_solution');
    });
  });

  // ------------------------------------------------------------------ B-F: generated tiers

  describe('with no official solution, an explanation is generated and scored', () => {
    it('grounds it in the retrieved theory and serves it as notes-only', async () => {
      const f = await arrange();
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ source: 'notes_only', notice: null, underReview: false });
      expect(fake.callCount).toBe(1);
      expect(fake.calls[0]!.mode).toBe('grounded');
      expect(fake.calls[0]!.chunks.length).toBeGreaterThan(0);

      const [row] = await storedExplanations(f.tenant, f.questionId);
      expect(row).toMatchObject({ source_tier: 'rag_grounded', status: 'active', retrieval_scope: 'subtopic', provider: 'gemini' });
      expect(Number(row!.grounding_score)).toBeGreaterThanOrEqual(0.75);
      expect(row!.grounding_block_ids.length).toBeGreaterThan(0);
    });

    it('serves a partially supported explanation as mostly-notes', async () => {
      const f = await arrange();
      // Three claim terms the notes support (conserved, throughout, motion) against two they
      // do not (matters, relevant): 0.6, inside the 0.50-0.75 band.
      fake.reply({
        summary: 'Angular momentum is conserved throughout the motion.',
        steps: ['The contact point matters.', 'Also relevant.'],
        keyConcept: null,
        commonMistake: null,
      });
      const res = await explanation(f.session, f.questionId);
      expect(res.body.source).toBe('mostly_notes');
      expect(res.body.notice).toBeNull();
      const [row] = await storedExplanations(f.tenant, f.questionId);
      expect(Number(row!.grounding_score)).toBeGreaterThanOrEqual(0.5);
      expect(Number(row!.grounding_score)).toBeLessThan(0.75);
    });

    it('falls back to general knowledge below the band, with the product wording and a review task', async () => {
      const f = await arrange();
      fake.reply({
        summary: 'Chromatic aberration governs the spectral distribution of the refracted beam entirely.',
        steps: ['Enzymatic catalysis lowers activation barriers.', 'Mitochondrial respiration yields adenosine triphosphate.'],
        keyConcept: null,
        commonMistake: null,
      });

      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ source: 'general_knowledge', notice: GENERAL_KNOWLEDGE_NOTICE, underReview: true });
      // Generated twice: once grounded (which scored too low), then again without the notes,
      // so nothing the notes did not support can be implied to come from them.
      expect(fake.callCount).toBe(2);
      expect(fake.calls[1]!.mode).toBe('general');
      expect(fake.calls[1]!.chunks).toEqual([]);

      const [row] = await storedExplanations(f.tenant, f.questionId);
      expect(row).toMatchObject({ source_tier: 'general_ai', status: 'active', retrieval_scope: null });
      expect(row!.grounding_block_ids).toEqual([]);

      const tasks = await reviewTasks(f.tenant, f.questionId);
      expect(tasks.some((task) => task.kind === 'explanation_review' && task.status === 'open')).toBe(true);
    });

    it('uses the exact product wording, character for character', async () => {
      const f = await arrange({ theory: [{ text: 'Entirely unrelated notes about optics, lenses and refraction indices.' }] });
      const res = await explanation(f.session, f.questionId);
      expect(res.body.notice).toBe('Not from official notes — pending review');
    });

    it('never puts retrieval, grounding or provider detail in the student payload', async () => {
      const f = await arrange();
      const res = await explanation(f.session, f.questionId);
      expect(Object.keys(res.body).sort()).toEqual(
        ['commonMistake', 'generatedAt', 'id', 'keyConcept', 'notice', 'optionKey', 'questionId', 'questionVersion', 'source', 'steps', 'summary', 'underReview'].sort(),
      );
      const body = JSON.stringify(res.body);
      for (const leak of ['groundingScore', 'grounding_score', 'diagnostics', 'provider', 'model', 'retrievalScope', 'blockId', 'citedBlockIds', 'finalAnswer']) {
        expect(body).not.toContain(leak);
      }
    });
  });

  // ------------------------------------------------------------------ G: answer mismatch

  describe('the answer-mismatch hard block', () => {
    it('never serves an explanation that argues for the wrong answer, and records why', async () => {
      const f = await arrange();
      fake.reply({ finalAnswer: { optionKeys: ['B'] } }); // option A is the correct one

      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'EXPLANATION_UNAVAILABLE' });
      expect(res.body.error.details[0]).toMatchObject({ field: 'reason', message: 'failed_validation' });
      // The unsafe text never reaches the student.
      expect(JSON.stringify(res.body)).not.toContain('contact point');

      const [row] = await storedExplanations(f.tenant, f.questionId);
      expect(row).toMatchObject({ status: 'rejected' });
      expect(row!.content.diagnostics.validation.failures[0].check).toBe('answer_match');

      const tasks = await reviewTasks(f.tenant, f.questionId);
      expect(tasks[0]).toMatchObject({ kind: 'explanation_review', status: 'open', priority: 1 });
      expect(tasks[0]!.reason).toMatch(/argues for an answer the question marks wrong/);
      expect(await auditActions(f.tenant.id, row!.id)).toContain('explanation.answer_mismatch_blocked');
    });

    it('takes the authoritative answer from the question, never from the model', async () => {
      const f = await arrange();
      // The model insists, confidently and at length, on the wrong option.
      fake.reply({ summary: 'The answer is definitely option B, as the notes make abundantly clear.', finalAnswer: { optionKeys: ['B'] } });
      expect((await explanation(f.session, f.questionId)).status).toBe(409);
    });

    it('blocks an explanation that will not commit to an answer', async () => {
      const f = await arrange();
      fake.reply({ finalAnswer: null });
      expect((await explanation(f.session, f.questionId)).status).toBe(409);
      const [row] = await storedExplanations(f.tenant, f.questionId);
      expect(row!.content.diagnostics.validation.failures[0].detail).toMatch(/states no final answer/);
    });

    it('does not ask the provider again on the next request: the failure is remembered', async () => {
      const f = await arrange();
      fake.reply({ finalAnswer: { optionKeys: ['B'] } });
      await explanation(f.session, f.questionId);
      expect(fake.callCount).toBe(1);
      expect((await explanation(f.session, f.questionId)).status).toBe(409);
      expect(fake.callCount).toBe(1);
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ H, I, W: caching

  describe('caching', () => {
    it('serves a second request from the cache without regenerating', async () => {
      const f = await arrange();
      const first = await explanation(f.session, f.questionId);
      const second = await explanation(f.session, f.questionId);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(fake.callCount).toBe(1);
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(1);
    });

    it('caches a distractor variant separately from the question-level explanation', async () => {
      const f = await arrange({ correct: false }); // the student's last attempt chose the wrong option B
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body.optionKey).toBe('B');
      expect(fake.calls[0]!.distractorKey).toBe('B');

      // Same student again: the variant is cached, not rebuilt.
      await explanation(f.session, f.questionId);
      expect(fake.callCount).toBe(1);

      // A student who answered correctly gets the question-level explanation, generated once.
      const other = await createUser(f.tenant, 'STUDENT');
      const otherSession = await login(t, other, f.tenant.slug);
      await insertHistoricalAttempt(f.tenant, other.id, f.syllabus.subtopicId, f.questionId, f.engineConfigId, { daysAgo: 1, correct: true });
      const main = await explanation(otherSession, f.questionId);
      expect(main.body.optionKey).toBeNull();
      expect(fake.callCount).toBe(2);

      const rows = await storedExplanations(f.tenant, f.questionId);
      expect(rows.map((r) => r.option_key).sort()).toEqual(['B', null]);
      expect(rows.every((r) => r.status === 'active')).toBe(true);
    });

    it('regenerates when the theory it was grounded in is edited', async () => {
      const f = await arrange();
      const first = await explanation(f.session, f.questionId);
      expect(fake.callCount).toBe(1);

      await db().query(`UPDATE content_blocks SET updated_at = now() + interval '1 second' WHERE tenant_id = $1`, [f.tenant.id]);
      const second = await explanation(f.session, f.questionId);
      expect(fake.callCount).toBe(2);
      expect(second.body.id).not.toBe(first.body.id);

      const rows = await storedExplanations(f.tenant, f.questionId);
      expect(rows.map((r) => r.status)).toEqual(['superseded', 'active']);
      expect(await auditActions(f.tenant.id, first.body.id as string)).toContain('explanation.superseded');
    });

    it('regenerates when a new engine configuration is activated', async () => {
      const f = await arrange();
      await explanation(f.session, f.questionId);
      expect(fake.callCount).toBe(1);

      await db().query(`UPDATE engine_config SET is_active = false WHERE tenant_id = $1`, [f.tenant.id]);
      await db().query(
        `INSERT INTO engine_config (tenant_id, version, params, change_note, is_active, activated_at)
         SELECT tenant_id, 2, params, 'phase 6 test: reactivated', true, now() + interval '1 second'
           FROM engine_config WHERE tenant_id = $1 AND version = 1`,
        [f.tenant.id],
      );
      await explanation(f.session, f.questionId);
      expect(fake.callCount).toBe(2);
    });

    it('does not reuse an explanation written for an older question version', async () => {
      const f = await arrange();
      await explanation(f.session, f.questionId);
      const admin = f.admin;
      const edited = await t
        .http()
        .patch(`/v1/admin/questions/${f.questionId}`)
        .set(...bearer(admin))
        .send({ stem: `${STEM} State the answer in radians per second.` });
      expect(edited.body.version).toBeGreaterThan(1);

      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body.questionVersion).toBe(edited.body.version);
      expect(fake.callCount).toBe(2);
    });
  });

  // ------------------------------------------------------------------ J, K: reporting

  describe('reporting an explanation', () => {
    it('stores the report as a review task, audits it, and counts it', async () => {
      const f = await arrange();
      await explanation(f.session, f.questionId);

      const res = await report(f.session, f.questionId, { reason: 'wrong_solution', comment: 'The third step does not follow.' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ reason: 'wrong_solution', reportCount: 1, explanationUnpublished: false });

      const tasks = await reviewTasks(f.tenant, f.questionId);
      const reportTask = tasks.find((task) => task.kind === 'student_report')!;
      expect(reportTask).toMatchObject({ status: 'open', priority: 1, reason: 'wrong_solution', reporter_user_id: f.student.id });
      expect(reportTask.explanation_id).not.toBeNull();
      expect(await auditActions(f.tenant.id, f.questionId)).toContain('question.reported');
    });

    it('refuses a second report from the same student rather than letting them inflate the count', async () => {
      const f = await arrange();
      await explanation(f.session, f.questionId);
      expect((await report(f.session, f.questionId)).status).toBe(201);
      const again = await report(f.session, f.questionId, { reason: 'typo' });
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/already reported/);
      expect((await reviewTasks(f.tenant, f.questionId)).filter((task) => task.kind === 'student_report')).toHaveLength(1);
    });

    it('unpublishes the explanation on the third distinct report, keeping the record', async () => {
      const f = await arrange();
      const served = await explanation(f.session, f.questionId);
      const explanationId = served.body.id as string;

      const reporters: Session[] = [f.session];
      for (let i = 0; i < 2; i += 1) {
        const user = await createUser(f.tenant, 'STUDENT');
        reporters.push(await login(t, user, f.tenant.slug));
      }

      const results: Json[] = [];
      for (const reporter of reporters) results.push((await report(reporter, f.questionId)).body);
      expect(results.map((r) => r.reportCount)).toEqual([1, 2, 3]);
      expect(results.map((r) => r.explanationUnpublished)).toEqual([false, false, true]);

      // The row is still there — unpublished, not deleted — and its history is auditable.
      const rows = await storedExplanations(f.tenant, f.questionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: explanationId, status: 'flagged' });
      expect(await auditActions(f.tenant.id, explanationId)).toContain('explanation.unpublished');

      const tasks = await reviewTasks(f.tenant, f.questionId);
      expect(tasks.filter((task) => task.kind === 'student_report')).toHaveLength(3);
      expect(tasks.some((task) => task.kind === 'explanation_review' && task.reason?.includes('unpublished automatically after 3'))).toBe(true);
    });

    it('does not show an unpublished explanation to a student, and does not quietly rebuild it', async () => {
      const f = await arrange();
      await explanation(f.session, f.questionId);
      const sessions = [f.session];
      for (let i = 0; i < 2; i += 1) sessions.push(await login(t, await createUser(f.tenant, 'STUDENT'), f.tenant.slug));
      for (const s of sessions) await report(s, f.questionId);

      const callsBefore = fake.callCount;
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(409);
      expect(res.body.error.details[0]).toMatchObject({ message: 'unpublished_after_reports' });
      expect(fake.callCount).toBe(callsBefore);
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(1);
    });

    it('keeps an unpublished explanation unpublished even after the theory is edited', async () => {
      // Regenerating here would republish what three students reported as wrong, with no human
      // having looked at it — and a review task is already open. A reviewer is the way back.
      const f = await arrange();
      await explanation(f.session, f.questionId);
      const sessions = [f.session];
      for (let i = 0; i < 2; i += 1) sessions.push(await login(t, await createUser(f.tenant, 'STUDENT'), f.tenant.slug));
      for (const s of sessions) await report(s, f.questionId);

      await db().query(`UPDATE content_blocks SET updated_at = now() + interval '1 second' WHERE tenant_id = $1`, [f.tenant.id]);
      const callsBefore = fake.callCount;
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(409);
      expect(res.body.error.details[0]).toMatchObject({ message: 'unpublished_after_reports' });
      expect(fake.callCount).toBe(callsBefore);
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(1);
    });

    it('does retry one that failed automated validation, once its inputs change', async () => {
      const f = await arrange();
      fake.reply({ finalAnswer: { optionKeys: ['B'] } }); // blocked by the answer matcher
      expect((await explanation(f.session, f.questionId)).status).toBe(409);
      expect(fake.callCount).toBe(1);

      fake.reply({}); // the provider would now answer correctly
      await db().query(`UPDATE content_blocks SET updated_at = now() + interval '1 second' WHERE tenant_id = $1`, [f.tenant.id]);
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(fake.callCount).toBe(2);
    });

    it('rejects a reason the review queue does not accept', async () => {
      const f = await arrange();
      expect((await report(f.session, f.questionId, { reason: 'i just do not like it' })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ L: mandatory approval

  describe('mandatory human approval', () => {
    it('holds a generated Olympiad explanation until a reviewer releases it', async () => {
      const f = await arrange({ trackSlug: `astronomy-olympiad-${uniq('y')}` });

      const held = await explanation(f.session, f.questionId);
      expect(held.status).toBe(409);
      expect(held.body.error.details[0]).toMatchObject({ message: 'pending_human_approval' });
      expect(fake.callCount).toBe(1); // it was generated and cached, just not shown

      const rows = await storedExplanations(f.tenant, f.questionId);
      expect(rows[0]).toMatchObject({ status: 'active' }); // valid, but not visible
      const tasks = await reviewTasks(f.tenant, f.questionId);
      expect(tasks.some((task) => task.reason?.includes('requires a human to approve'))).toBe(true);

      const approved = await t
        .http()
        .post(`/v1/admin/explanations/${rows[0]!.id}/review`)
        .set(...bearer(f.admin))
        .send({ decision: 'approve', note: 'Checked against the textbook.' });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ studentVisible: true, blockedReason: null });

      const released = await explanation(f.session, f.questionId);
      expect(released.status).toBe(200);
      expect(released.body.source).toBe('notes_only');
      expect(fake.callCount).toBe(1); // released from the cache, not regenerated
      expect(await auditActions(f.tenant.id, rows[0]!.id as string)).toContain('explanation.approved');
    });

    // Migration 0013 made `tracks.kind` the safety check rather than the track's name. These two
    // tests are the whole point of that change: before it, renaming a track switched the rule off.
    it('holds a generated explanation on a track marked kind = olympiad, whatever it is called', async () => {
      // The slug says nothing about Olympiads, so a hold here can only come from `kind`.
      const f = await arrange({ trackSlug: `imo-selection-${uniq('k')}`, trackKind: 'olympiad' });
      const held = await explanation(f.session, f.questionId);
      expect(held.status).toBe(409);
      expect(held.body.error.details[0]).toMatchObject({ message: 'pending_human_approval' });
      const tasks = await reviewTasks(f.tenant, f.questionId);
      expect(tasks.some((task) => task.reason?.includes('requires a human to approve'))).toBe(true);
    });

    it('does not hold a school track, which is what most learners are in', async () => {
      const f = await arrange({ trackSlug: `class-5-mathematics-${uniq('s')}`, trackKind: 'school' });
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('notes_only');
    });

    it('keeps a rejected explanation out of circulation without deleting it', async () => {
      const f = await arrange();
      const served = await explanation(f.session, f.questionId);
      const rejected = await t
        .http()
        .post(`/v1/admin/explanations/${served.body.id}/review`)
        .set(...bearer(f.admin))
        .send({ decision: 'reject', note: 'Step two is wrong.' });
      expect(rejected.body).toMatchObject({ status: 'rejected', studentVisible: false, blockedReason: 'failed_validation' });

      expect((await explanation(f.session, f.questionId)).status).toBe(409);
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(1);
      expect(await auditActions(f.tenant.id, served.body.id as string)).toContain('explanation.rejected');
    });

    it('is closed to students', async () => {
      const f = await arrange();
      const served = await explanation(f.session, f.questionId);
      expect((await t.http().get(`/v1/admin/questions/${f.questionId}/explanation`).set(...bearer(f.session))).status).toBe(403);
      expect(
        (await t.http().post(`/v1/admin/explanations/${served.body.id}/review`).set(...bearer(f.session)).send({ decision: 'approve' })).status,
      ).toBe(403);
    });
  });

  // ------------------------------------------------------------------ P, Q: retrieval

  describe('retrieval respects the syllabus, and widens deliberately', () => {
    it('widens from the sub-topic to the parent topic, and records why', async () => {
      const tenant = await createTenant();
      const student = await createUser(tenant, 'STUDENT');
      const adminUser = await createUser(tenant, 'ADMIN');
      const [session, admin, syllabus] = await Promise.all([login(t, student, tenant.slug), login(t, adminUser, tenant.slug), createSyllabus(tenant)]);
      const engineConfigId = await createEngineConfig(tenant);
      const questionId = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: STEM });
      // Nothing under the question's own sub-topic; three blocks under a sibling of the same topic.
      const sibling = await createSubtopic(tenant, syllabus.topicId, 'published', 'Neighbouring sub-topic');
      for (let i = 0; i < 3; i += 1) await insertContentBlock(tenant, sibling, { text: `${THEORY.text} Variation ${i}.`, sortOrder: i });
      await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, questionId, engineConfigId, { daysAgo: 1 });

      const res = await explanation(session, questionId);
      expect(res.status).toBe(200);
      const view = await adminExplanation(admin, questionId);
      expect(view.body.retrievalScope).toBe('topic');
      const trail = view.body.diagnostics.retrieval.trail as Json[];
      expect(trail.map((step) => step.scope)).toEqual(['subtopic', 'topic']);
      expect(trail[0]!.widenedBecause).toMatch(/chunks cleared the score floor at subtopic level/);
    });

    it('widens on to the chapter when the topic has nothing either', async () => {
      const tenant = await createTenant();
      const student = await createUser(tenant, 'STUDENT');
      const adminUser = await createUser(tenant, 'ADMIN');
      const [session, admin, syllabus] = await Promise.all([login(t, student, tenant.slug), login(t, adminUser, tenant.slug), createSyllabus(tenant)]);
      const engineConfigId = await createEngineConfig(tenant);
      const questionId = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: STEM });

      const { rows } = await db().query<{ id: string }>(
        `INSERT INTO topics (tenant_id, chapter_id, slug, name, status) VALUES ($1, $2, $3, 'Other Topic', 'published') RETURNING id`,
        [tenant.id, syllabus.chapterId, uniq('topic')],
      );
      const farSubtopic = await createSubtopic(tenant, rows[0]!.id, 'published', 'Far sub-topic');
      for (let i = 0; i < 3; i += 1) await insertContentBlock(tenant, farSubtopic, { text: `${THEORY.text} Chapter variation ${i}.`, sortOrder: i });
      await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, questionId, engineConfigId, { daysAgo: 1 });

      expect((await explanation(session, questionId)).status).toBe(200);
      const view = await adminExplanation(admin, questionId);
      expect(view.body.retrievalScope).toBe('chapter');
      expect((view.body.diagnostics.retrieval.trail as Json[]).map((s) => s.scope)).toEqual(['subtopic', 'topic', 'chapter']);
    });

    it('never grounds in another chapter’s notes, however similar they are', async () => {
      const tenant = await createTenant();
      const student = await createUser(tenant, 'STUDENT');
      const adminUser = await createUser(tenant, 'ADMIN');
      const [session, admin, syllabus] = await Promise.all([login(t, student, tenant.slug), login(t, adminUser, tenant.slug), createSyllabus(tenant)]);
      const other = await createSyllabus(tenant); // a whole separate track → chapter
      const engineConfigId = await createEngineConfig(tenant);
      const questionId = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: STEM });
      // Word-for-word the same theory, but filed under another chapter entirely.
      const foreign = await insertContentBlock(tenant, other.subtopicId, { text: THEORY.text, title: THEORY.title });
      await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, questionId, engineConfigId, { daysAgo: 1 });

      const res = await explanation(session, questionId);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('general_knowledge'); // nothing in scope, so it cannot claim the notes
      const view = await adminExplanation(admin, questionId);
      expect(view.body.groundingBlockIds).not.toContain(foreign);
      expect((view.body.diagnostics.retrieval.chunks as Json[])).toEqual([]);
    });

    it('does not retrieve a question or solution block as theory', async () => {
      const tenant = await createTenant();
      const student = await createUser(tenant, 'STUDENT');
      const adminUser = await createUser(tenant, 'ADMIN');
      const [session, admin, syllabus] = await Promise.all([login(t, student, tenant.slug), login(t, adminUser, tenant.slug), createSyllabus(tenant)]);
      const engineConfigId = await createEngineConfig(tenant);
      const questionId = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: STEM });
      await insertContentBlock(tenant, syllabus.subtopicId, { kind: 'solution', text: THEORY.text });
      await insertContentBlock(tenant, syllabus.subtopicId, { kind: 'theory', text: THEORY.text, status: 'needs_review' });
      await insertHistoricalAttempt(tenant, student.id, syllabus.subtopicId, questionId, engineConfigId, { daysAgo: 1 });

      expect((await explanation(session, questionId)).body.source).toBe('general_knowledge');
      const view = await adminExplanation(admin, questionId);
      expect(view.body.groundingBlockIds).toEqual([]);
    });

    it('reports that semantic retrieval did not run rather than pretending it did', async () => {
      const f = await arrange();
      await explanation(f.session, f.questionId);
      const view = await adminExplanation(f.admin, f.questionId);
      expect(view.body.diagnostics.retrieval.semanticUsed).toBe(false);
      // Truthful either way. Without pgvector the vector half cannot run and says so. With it (the
      // docker-compose image) the vector half does run, finds no indexed embeddings for these notes,
      // and so reports no skip reason — while `semanticUsed` above still says no chunk was ranked by it.
      const pgvector = (await db().query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok")).rows[0]!.ok;
      expect(view.body.diagnostics.retrieval.semanticSkippedBecause).toBe(pgvector ? null : 'pgvector unavailable on this server');
    });

    it('still answers when there is no theory at all, labelled as general knowledge', async () => {
      const f = await arrange({ theory: [] });
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ source: 'general_knowledge', notice: GENERAL_KNOWLEDGE_NOTICE });
      expect(fake.callCount).toBe(1); // nothing to ground in, so no grounded attempt was made
      expect(fake.calls[0]!.mode).toBe('general');
      expect((await reviewTasks(f.tenant, f.questionId)).some((task) => task.kind === 'explanation_review')).toBe(true);
    });
  });

  // ------------------------------------------------------------------ R: provider failure

  describe('when the provider cannot be reached', () => {
    it('reports a service error and stores nothing', async () => {
      const f = await arrange();
      fake.reply(new AiProviderError('gemini', 'unavailable', 'connection reset'));
      const res = await explanation(f.session, f.questionId);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(res.body.error.message).not.toContain('connection reset');
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(0);
    });

    it('serves the official solution even with the provider down', async () => {
      const f = await arrange();
      await approvedSolution(f.tenant, f.questionId, 'The official solution, which needs no provider. Therefore omega = v / R.');
      fake.reply(new AiProviderError('gemini', 'unavailable', 'down'));
      expect((await explanation(f.session, f.questionId)).body.source).toBe('official_solution');
    });

    it('says so plainly when no provider is configured at all', async () => {
      const f = await arrange();
      const res = await explanation(f.session, f.questionId, noAi);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
      expect(await storedExplanations(f.tenant, f.questionId)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ M, N, U: access control

  describe('access control', () => {
    it('refuses a student who has not answered the question: the explanation is the answer', async () => {
      const f = await arrange();
      const other = await createUser(f.tenant, 'STUDENT');
      const otherSession = await login(t, other, f.tenant.slug);
      const res = await explanation(otherSession, f.questionId);
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/Answer this question first/);
      expect(fake.callCount).toBe(0);
      expect(JSON.stringify(res.body)).not.toContain('contact point');
    });

    it('lets a student read it once they have attempted, even if they got it wrong', async () => {
      const f = await arrange({ correct: false });
      expect((await explanation(f.session, f.questionId)).status).toBe(200);
    });

    // The gate is a floor, not a setting. `require_attempt: false` must not open the oracle,
    // whichever way it gets into the configuration.
    it('cannot have the attempt requirement switched off in an active configuration at all', async () => {
      const f = await arrange();

      // First route: edit the live row. The database refuses — an activated engine_config version
      // is immutable, which is a Phase 4 guarantee and the first of three independent protections.
      await expect(
        db().query(`UPDATE engine_config SET params = jsonb_set(params, '{explanation,require_attempt}', 'false'::jsonb) WHERE id = $1`, [
          f.engineConfigId,
        ]),
      ).rejects.toThrow(/immutable/);

      // Second route: publish a new version carrying the unsafe value, which is the supported way
      // to change configuration and bypasses the immutability rule entirely.
      await db().query(`UPDATE engine_config SET is_active = false WHERE tenant_id = $1`, [f.tenant.id]);
      await db().query(
        `INSERT INTO engine_config (tenant_id, version, params, change_note, is_active, activated_at)
         SELECT tenant_id, 2, jsonb_set(params, '{explanation,require_attempt}', 'false'::jsonb),
                'phase 8 test: attempts to disable the attempt requirement', true, now() + interval '1 second'
           FROM engine_config WHERE tenant_id = $1 AND version = 1`,
        [f.tenant.id],
      );
      const stored = await db().query<{ value: boolean }>(
        `SELECT (params #>> '{explanation,require_attempt}')::boolean AS value
           FROM engine_config WHERE tenant_id = $1 AND is_active`,
        [f.tenant.id],
      );
      expect(stored.rows[0]?.value).toBe(false); // the unsafe value really is live in the database

      // A student who has not attempted the question still cannot read an explanation...
      const other = await createUser(f.tenant, 'STUDENT');
      const otherSession = await login(t, other, f.tenant.slug);
      const res = await explanation(otherSession, f.questionId);
      expect(res.status).not.toBe(200);
      expect(fake.callCount).toBe(0);
      expect(JSON.stringify(res.body)).not.toContain('contact point');

      // ...and neither can the student who did, because the slice refuses to parse the value:
      // fail closed rather than serve an answer key.
      const attempted = await explanation(f.session, f.questionId);
      expect(attempted.status).toBe(422);
      expect(JSON.stringify(attempted.body)).toContain('require_attempt');

      // The blast radius is the explanation endpoints and nothing else: the slices are independent,
      // so starting a practice session still works with an unsafe explanation configuration.
      const practice = await t
        .http()
        .post('/v1/practice/sessions')
        .set(...bearer(f.session))
        .send({ subtopicId: f.syllabus.subtopicId });
      expect(practice.status).toBe(201);
    });

    it('hides another organisation’s question entirely', async () => {
      const [a, b] = [await arrange(), await arrange()];
      await explanation(a.session, a.questionId);
      expect((await explanation(b.session, a.questionId)).status).toBe(404);
      expect((await report(b.session, a.questionId)).status).toBe(404);
      expect((await adminExplanation(b.admin, a.questionId)).status).toBe(404);
    });

    it('never writes or reads an explanation across organisations', async () => {
      const [a, b] = [await arrange(), await arrange()];
      await explanation(a.session, a.questionId);
      await explanation(b.session, b.questionId);
      const { rows } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM explanations e JOIN questions q ON q.id = e.question_id WHERE e.tenant_id <> q.tenant_id`,
      );
      expect(rows[0]!.n).toBe('0');
      expect(await storedExplanations(a.tenant, a.questionId)).toHaveLength(1);
      expect(await storedExplanations(b.tenant, a.questionId)).toHaveLength(0);
    });

    it('refuses an admin review of another organisation’s explanation', async () => {
      const [a, b] = [await arrange(), await arrange()];
      const served = await explanation(a.session, a.questionId);
      const res = await t
        .http()
        .post(`/v1/admin/explanations/${served.body.id}/review`)
        .set(...bearer(b.admin))
        .send({ decision: 'approve' });
      expect(res.status).toBe(404);
    });

    it('needs a token, and rejects a malformed question id', async () => {
      const f = await arrange();
      expect((await t.http().get(`/v1/questions/${f.questionId}/explanation`)).status).toBe(401);
      expect((await explanation(f.session, 'not-a-uuid')).status).toBe(400);
    });

    it('does not serve an explanation for an unpublished question', async () => {
      const f = await arrange();
      await db().query(`UPDATE questions SET status = 'retired' WHERE id = $1`, [f.questionId]);
      expect((await explanation(f.session, f.questionId)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ V: audit

  describe('audit trail', () => {
    it('records every state change with the actor and the reason', async () => {
      const f = await arrange({ trackSlug: `maths-olympiad-${uniq('z')}` });
      const held = await explanation(f.session, f.questionId);
      expect(held.status).toBe(409);
      const [row] = await storedExplanations(f.tenant, f.questionId);

      await t.http().post(`/v1/admin/explanations/${row!.id}/review`).set(...bearer(f.admin)).send({ decision: 'approve' });
      await report(f.session, f.questionId, { reason: 'unclear' });

      expect(await auditActions(f.tenant.id, row!.id as string)).toEqual(expect.arrayContaining(['explanation.generated', 'explanation.approved']));
      expect(await auditActions(f.tenant.id, f.questionId)).toContain('question.reported');

      const { rows } = await db().query<Json>(
        `SELECT actor_user_id, action, after FROM audit_log WHERE tenant_id = $1 AND action = 'explanation.approved'`,
        [f.tenant.id],
      );
      expect(rows[0]!.actor_user_id).toBeTruthy();
    });
  });

  // ------------------------------------------------------------------ admin view

  describe('the reviewer’s view', () => {
    it('shows the provenance a student never sees', async () => {
      const f = await arrange();
      await explanation(f.session, f.questionId);
      const res = await adminExplanation(f.admin, f.questionId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sourceTier: 'rag_grounded',
        status: 'active',
        provider: 'gemini',
        model: 'fake-explain-1',
        retrievalScope: 'subtopic',
        studentVisible: true,
        blockedReason: null,
      });
      expect(res.body.groundingScore).toBeGreaterThanOrEqual(0.75);
      expect(res.body.diagnostics.validation.ok).toBe(true);
      expect(res.body.diagnostics.modelFinalAnswer).toEqual({ optionKeys: ['A'] });
      expect(res.body.promptVersion).toMatch(/^exp-/);
    });

    it('reads a named distractor variant, and refuses an option the question does not have', async () => {
      const f = await arrange({ correct: false });
      await explanation(f.session, f.questionId);
      expect((await adminExplanation(f.admin, f.questionId, '?optionKey=B')).body.optionKey).toBe('B');
      const bad = await adminExplanation(f.admin, f.questionId, '?optionKey=Z');
      expect(bad.status).toBe(400);
      expect(bad.body.error.details[0].field).toBe('optionKey');
    });

    it('reports why a blocked explanation is blocked', async () => {
      const f = await arrange();
      fake.reply({ finalAnswer: { optionKeys: ['B'] } });
      await explanation(f.session, f.questionId);
      const res = await adminExplanation(f.admin, f.questionId);
      expect(res.body).toMatchObject({ status: 'rejected', studentVisible: false, blockedReason: 'failed_validation' });
      expect(res.body.diagnostics.validation.failures[0].check).toBe('answer_match');
    });
  });
});
