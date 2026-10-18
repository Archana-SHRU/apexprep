import {
  bearer,
  closeDb,
  createSyllabus,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertPracticeQuestion,
  login,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Mock tests against a real database: the deadline, the answer key, closing a paper once, and timing the
 * server measures itself. Time-dependent behaviour is exercised by moving rows' timestamps in the past, not by
 * sleeping, and the application's own clock is never mocked — the database's clock decides, which is the point.
 */
describe('mock tests (e2e)', () => {
  let t: TestApp;
  let tenant: TenantFixture;
  let syllabus: SyllabusFixture;
  let student: Session;
  let studentId: string;
  let other: Session;

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant();
    syllabus = await createSyllabus(tenant);
    const [s, o] = await Promise.all([createUser(tenant, 'STUDENT'), createUser(tenant, 'STUDENT')]);
    studentId = s.id;
    [student, other] = await Promise.all([login(t, s, tenant.slug), login(t, o, tenant.slug)]);
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  interface PaperFixture {
    testId: string;
    questionIds: string[];
  }

  /** A published paper of `count` single-correct questions (option A is right), one section, +4 / −1. */
  async function createPaper(count = 3, opts: { durationMinutes?: number; withSolution?: boolean } = {}): Promise<PaperFixture> {
    const questionIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: `Mock question ${i + 1} ${Math.random()}` });
      questionIds.push(id);
      if (opts.withSolution !== false) {
        await db().query(
          `INSERT INTO official_solutions (tenant_id, question_id, body, final_answer_text, status, approved_at)
           VALUES ($1, $2, $3, 'A', 'approved', now())`,
          [tenant.id, id, `Worked solution for question ${i + 1}`],
        );
      }
    }
    const { rows: testRows } = await db().query<{ id: string }>(
      `INSERT INTO mock_tests (tenant_id, title, kind, duration_minutes, total_marks, status)
       VALUES ($1, $2, 'full_length', $3, $4, 'published') RETURNING id`,
      [tenant.id, `Paper ${Math.random()}`, opts.durationMinutes ?? 60, count * 4],
    );
    const testId = testRows[0]!.id;
    const { rows: sectionRows } = await db().query<{ id: string }>(
      `INSERT INTO test_sections (test_id, name, sort_order) VALUES ($1, 'Physics', 0) RETURNING id`,
      [testId],
    );
    for (const [index, questionId] of questionIds.entries()) {
      await db().query(
        `INSERT INTO test_items (test_id, section_id, question_id, sort_order, positive_marks, negative_marks)
         VALUES ($1, $2, $3, $4, 4, 1)`,
        [testId, sectionRows[0]!.id, questionId, index],
      );
    }
    return { testId, questionIds };
  }

  const start = (who: Session, testId: string) => t.http().post(`/v1/tests/${testId}/start`).set(...bearer(who));
  const itemsOf = (state: Json): Json[] => (state.sections as Json[]).flatMap((s) => s.questions as Json[]);
  const save = (who: Session, sessionId: string, body: Json) => t.http().post(`/v1/tests/sessions/${sessionId}/answer`).set(...bearer(who)).send(body);
  const focus = (who: Session, sessionId: string, testItemId: string | null) =>
    t.http().post(`/v1/tests/sessions/${sessionId}/focus`).set(...bearer(who)).send({ testItemId });
  const submit = (who: Session, sessionId: string) => t.http().post(`/v1/tests/sessions/${sessionId}/submit`).set(...bearer(who));
  const result = (who: Session, sessionId: string) => t.http().get(`/v1/tests/sessions/${sessionId}/result`).set(...bearer(who));
  const sessionRow = async (id: string) => (await db().query(`SELECT * FROM test_sessions WHERE id = $1`, [id])).rows[0] as Json;
  const responseRow = async (sessionId: string, itemId: string) =>
    (await db().query(`SELECT * FROM test_item_responses WHERE test_session_id = $1 AND test_item_id = $2`, [sessionId, itemId])).rows[0] as Json;
  const expire = (sessionId: string, secondsAgo = 120) =>
    db().query(
      `UPDATE test_sessions SET started_at = now() - make_interval(secs => $2 + 600), ends_at = now() - make_interval(secs => $2) WHERE id = $1`,
      [sessionId, secondsAgo],
    );

  describe('answer protection', () => {
    it('serves questions without any answer key, hint text or solution', async () => {
      const paper = await createPaper();
      const res = await start(student, paper.testId);
      expect(res.status).toBe(200);
      const json = JSON.stringify(res.body);
      expect(json).not.toMatch(/isCorrect|is_correct|correctOption|correctNumeric|Worked solution|finalAnswerText|difficultyB/);
      expect(itemsOf(res.body)).toHaveLength(3);
    });

    it('refuses the result — and so the answer key and solutions — while the paper is open', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const res = await result(student, state.sessionId as string);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
      expect(JSON.stringify(res.body)).not.toMatch(/Worked solution|isCorrect|correctAnswer/);
    });

    it('does not let the open paper be read as a result even after answers are saved', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const [first] = itemsOf(state);
      await save(student, state.sessionId as string, { testItemId: first!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      expect((await result(student, state.sessionId as string)).status).toBe(409);
    });

    it('gives the answer key and solutions after a legitimate submission', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const res = await submit(student, state.sessionId as string);
      expect(res.status).toBe(200);
      const question = (res.body.questions as Json[])[0]!;
      expect(question.options.some((o: Json) => o.isCorrect === true)).toBe(true);
      expect(question.solution.body).toMatch(/Worked solution/);
      expect((await result(student, state.sessionId as string)).status).toBe(200);
    });

    it('treats another student\'s session like a missing one for every session endpoint', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [first] = itemsOf(state);
      const attempts = [
        t.http().get(`/v1/tests/sessions/${id}`).set(...bearer(other)),
        save(other, id, { testItemId: first!.testItemId, response: null, status: 'not_answered' }),
        focus(other, id, first!.testItemId as string),
        submit(other, id),
        result(other, id),
      ];
      for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
      expect((await sessionRow(id)).status).toBe('in_progress');
    });
  });

  describe('starting and resuming', () => {
    it('opens exactly one session however many starts arrive together', async () => {
      const paper = await createPaper();
      const responses = await Promise.all(Array.from({ length: 6 }, () => start(student, paper.testId)));
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(new Set(responses.map((r) => r.body.sessionId as string)).size).toBe(1);
      const { rows } = await db().query(`SELECT count(*)::int AS n FROM test_sessions WHERE test_id = $1 AND status = 'in_progress'`, [paper.testId]);
      expect(rows[0].n).toBe(1);
    });

    it('refuses, at the database, a second open session for the same student and test', async () => {
      const paper = await createPaper();
      await start(student, paper.testId);
      await expect(
        db().query(
          `INSERT INTO test_sessions (tenant_id, user_id, test_id, status, ends_at) VALUES ($1, $2, $3, 'in_progress', now() + interval '1 hour')`,
          [tenant.id, studentId, paper.testId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('resumes the same session on refresh without resetting the clock, and keeps saved answers and the open question', async () => {
      const paper = await createPaper();
      const { body: first } = await start(student, paper.testId);
      const items = itemsOf(first);
      await save(student, first.sessionId as string, { testItemId: items[1]!.testItemId, response: { optionKeys: ['B'] }, status: 'answered' });
      await focus(student, first.sessionId as string, items[1]!.testItemId as string);

      const { body: again } = await start(student, paper.testId);
      expect(again.sessionId).toBe(first.sessionId);
      expect(again.endsAt).toBe(first.endsAt);
      expect(again.remainingSeconds).toBeLessThanOrEqual(first.remainingSeconds as number);
      expect(again.activeTestItemId).toBe(items[1]!.testItemId);
      expect(itemsOf(again)[1]!.currentResponse).toEqual({ optionKeys: ['B'] });
    });

    it('computes the deadline on the server: duration × 60 seconds from the start', async () => {
      const paper = await createPaper(2, { durationMinutes: 90 });
      const { body } = await start(student, paper.testId);
      expect(body.remainingSeconds).toBeGreaterThan(90 * 60 - 10);
      expect(body.remainingSeconds).toBeLessThanOrEqual(90 * 60);
    });
  });

  describe('answers', () => {
    it('stores an answer, and rejects a question that is not part of the session instead of pretending', async () => {
      const paper = await createPaper();
      const other2 = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const { body: stateOther } = await start(student, other2.testId);
      const [first] = itemsOf(state);

      const ok = await save(student, state.sessionId as string, { testItemId: first!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true });
      expect(ok.body.remainingSeconds).toBeGreaterThan(0);
      expect((await responseRow(state.sessionId as string, first!.testItemId as string)).response).toEqual({ optionKeys: ['A'] });

      const foreign = itemsOf(stateOther)[0]!;
      const bad = await save(student, state.sessionId as string, { testItemId: foreign.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      const stranger = await save(student, state.sessionId as string, { testItemId: '11111111-1111-4111-8111-111111111111', response: null, status: 'not_answered' });
      expect(stranger.status).toBe(400);
    });

    it('validates what it is given: a non-object response, an unknown status and an oversized body are refused', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const item = itemsOf(state)[0]!.testItemId as string;
      expect((await save(student, id, { testItemId: item, response: 'A', status: 'answered' })).status).toBe(400);
      expect((await save(student, id, { testItemId: item, response: { optionKeys: ['A'] }, status: 'nonsense' })).status).toBe(400);
      expect((await save(student, id, { testItemId: item, response: { text: 'x'.repeat(30_000) }, status: 'answered' })).status).toBe(400);
    });
  });

  describe('time spent is measured by the server', () => {
    it('marks a question visited when it is opened, even if nothing is answered', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const [first] = itemsOf(state);
      expect(first!.status).toBe('not_visited');
      const res = await focus(student, state.sessionId as string, first!.testItemId as string);
      expect(res.status).toBe(200);
      expect((await responseRow(state.sessionId as string, first!.testItemId as string)).status).toBe('not_answered');
    });

    it('adds up the time a question was open when the student moves on, without any client-reported figure', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a, b] = itemsOf(state);

      await focus(student, id, a!.testItemId as string);
      await db().query(`UPDATE test_sessions SET started_at = started_at - interval '10 minutes', active_since = now() - interval '30 seconds' WHERE id = $1`, [id]);
      await focus(student, id, b!.testItemId as string);

      const first = await responseRow(id, a!.testItemId as string);
      expect(first.time_spent_ms).toBeGreaterThan(29_000);
      expect(first.time_spent_ms).toBeLessThan(33_000);
      expect(first.time_spent_sec).toBeGreaterThanOrEqual(29);
      expect((await responseRow(id, b!.testItemId as string)).time_spent_ms).toBe(0);
    });

    it('ignores time the client claims, in either direction, and cannot be made to go backwards', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a, b] = itemsOf(state);

      await focus(student, id, a!.testItemId as string);
      await db().query(`UPDATE test_sessions SET started_at = started_at - interval '10 minutes', active_since = now() - interval '20 seconds' WHERE id = $1`, [id]);
      await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered', timeSpentSec: 999_999 });
      await focus(student, id, b!.testItemId as string);
      const afterInflate = (await responseRow(id, a!.testItemId as string)).time_spent_ms as number;
      expect(afterInflate).toBeGreaterThan(19_000);
      expect(afterInflate).toBeLessThan(23_000);

      await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered', timeSpentSec: 0 });
      expect((await responseRow(id, a!.testItemId as string)).time_spent_ms).toBe(afterInflate);
    });

    it('cannot be double counted by two tabs: there is one open question, and total time never exceeds the session\'s age', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a, b] = itemsOf(state);

      await focus(student, id, a!.testItemId as string);
      // One minute passes with question A open, in a session that is two minutes old.
      await db().query(
        `UPDATE test_sessions SET started_at = now() - interval '2 minutes', active_since = now() - interval '60 seconds' WHERE id = $1`,
        [id],
      );
      // Two tabs now take turns claiming the clock, concurrently.
      await Promise.all([a, b, a, b, a, b, a, b].map((x) => focus(student, id, x!.testItemId as string)));
      const { rows } = await db().query(
        `SELECT coalesce(sum(r.time_spent_ms), 0)::int AS spent, (extract(epoch FROM (now() - s.started_at)) * 1000)::int AS age
           FROM test_item_responses r JOIN test_sessions s ON s.id = r.test_session_id WHERE s.id = $1 GROUP BY s.started_at`,
        [id],
      );
      // The minute is counted once — not once per focus call — and never exceeds the session's age.
      expect(rows[0].spent).toBeGreaterThan(59_000);
      expect(rows[0].spent).toBeLessThan(63_000);
      expect(rows[0].spent).toBeLessThanOrEqual(rows[0].age);
    });

    it('records the time on the question that was open at the moment of submission', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a] = itemsOf(state);
      await focus(student, id, a!.testItemId as string);
      await db().query(`UPDATE test_sessions SET started_at = started_at - interval '10 minutes', active_since = now() - interval '45 seconds' WHERE id = $1`, [id]);

      const res = await submit(student, id);
      expect(res.status).toBe(200);
      const first = (res.body.questions as Json[]).find((q) => q.testItemId === a!.testItemId)!;
      expect(first.timeSpentSec).toBeGreaterThanOrEqual(44);
      expect(first.timeSpentSec).toBeLessThanOrEqual(48);
      expect(res.body.timeSpentSec).toBeGreaterThanOrEqual(44);
      expect((await sessionRow(id)).active_item_id).toBeNull();
    });

    it('stops timing at submission: later focus calls are refused and nothing accrues', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a] = itemsOf(state);
      await focus(student, id, a!.testItemId as string);
      await submit(student, id);
      const before = (await responseRow(id, a!.testItemId as string)).time_spent_ms;

      const late = await focus(student, id, a!.testItemId as string);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('SESSION_CLOSED');
      expect((await responseRow(id, a!.testItemId as string)).time_spent_ms).toBe(before);
    });

    it('never credits time beyond the deadline, however long the question stayed open', async () => {
      const paper = await createPaper();
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a] = itemsOf(state);
      await focus(student, id, a!.testItemId as string);
      // Open since an hour ago; the deadline passed 30 minutes ago.
      await db().query(
        `UPDATE test_sessions SET started_at = now() - interval '2 hours', ends_at = now() - interval '30 minutes', active_since = now() - interval '1 hour' WHERE id = $1`,
        [id],
      );
      const res = await result(student, id);
      expect(res.status).toBe(200);
      const spent = (await responseRow(id, a!.testItemId as string)).time_spent_ms as number;
      expect(spent).toBeGreaterThan(29 * 60_000);
      expect(spent).toBeLessThanOrEqual(30 * 60_000 + 1000);
    });
  });

  describe('closing a paper', () => {
    it('grades with the established marking scheme and stores one result', async () => {
      const paper = await createPaper(3);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a, b] = itemsOf(state);
      await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' }); // +4
      await save(student, id, { testItemId: b!.testItemId, response: { optionKeys: ['B'] }, status: 'answered' }); // −1

      const res = await submit(student, id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'completed', totalScore: 3, rawScore: 3, maxScore: 12, correctCount: 1, incorrectCount: 1, unattemptedCount: 1, accuracy: 50 });
    });

    it('floors a negative paper at zero and shows the unfloored score', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      for (const item of itemsOf(state)) await save(student, id, { testItemId: item.testItemId, response: { optionKeys: ['B'] }, status: 'answered' });
      const res = await submit(student, id);
      expect(res.body).toMatchObject({ totalScore: 0, rawScore: -2 });
    });

    it('is safe against simultaneous and repeated submissions: one grading, identical results', async () => {
      const paper = await createPaper(3);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a] = itemsOf(state);
      await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });

      const responses = await Promise.all(Array.from({ length: 6 }, () => submit(student, id)));
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
      for (const r of responses) expect(r.body).toEqual(responses[0]!.body);
      const again = await submit(student, id);
      expect(again.body).toEqual(responses[0]!.body);
      expect(responses[0]!.body.totalScore).toBe(4);
    });

    it('freezes answers: nothing can be saved or changed after the paper is closed', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a] = itemsOf(state);
      await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      await submit(student, id);

      const late = await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['B'] }, status: 'answered' });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('SESSION_CLOSED');
      expect((await responseRow(id, a!.testItemId as string)).response).toEqual({ optionKeys: ['A'] });
      expect((await result(student, id)).body.totalScore).toBe(4);
    });

    it('starts a new attempt only after the previous one is closed', async () => {
      const paper = await createPaper(2);
      const { body: first } = await start(student, paper.testId);
      await submit(student, first.sessionId as string);
      const { body: second } = await start(student, paper.testId);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.status).toBe('in_progress');
    });
  });

  describe('the deadline', () => {
    it('closes an expired paper when it is read, reporting the status the database holds and no time left', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a] = itemsOf(state);
      await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      await expire(id);

      const res = await t.http().get(`/v1/tests/sessions/${id}`).set(...bearer(student));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'timed_out', remainingSeconds: 0, activeTestItemId: null });
      const row = await sessionRow(id);
      expect(row.status).toBe('timed_out');
      expect(Number(row.total_score)).toBe(4);
      // Stamped with the deadline, not with whenever the paper happened to be noticed.
      expect(new Date(row.submitted_at as string).getTime()).toBe(new Date(row.ends_at as string).getTime());
    });

    it('does not start a fresh attempt when an expired paper is reopened: it closes it and points to its result', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      await expire(id);

      const reopened = await start(student, paper.testId);
      expect(reopened.status).toBe(409);
      expect(reopened.body.error.code).toBe('SESSION_EXPIRED');
      expect(reopened.body.error.details).toEqual([{ field: 'sessionId', message: id }]);
      expect((await sessionRow(id)).status).toBe('timed_out');
      const { rows } = await db().query(`SELECT count(*)::int AS n FROM test_sessions WHERE test_id = $1`, [paper.testId]);
      expect(rows[0].n).toBe(1);
      expect((await result(student, id)).status).toBe(200);

      // A later, deliberate start is a new attempt.
      const next = await start(student, paper.testId);
      expect(next.status).toBe(200);
      expect(next.body.sessionId).not.toBe(id);
    });

    it('refuses an answer long after the deadline, closes the paper and grades only what was saved in time', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a, b] = itemsOf(state);
      await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      await expire(id);

      const late = await save(student, id, { testItemId: b!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('TIME_EXPIRED');
      const row = await sessionRow(id);
      expect(row.status).toBe('timed_out');
      expect(Number(row.total_score)).toBe(4);
      expect((await responseRow(id, b!.testItemId as string)).response).toBeNull();
    });

    it('tolerates the network: an answer arriving a moment after the deadline is still stored', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const id = state.sessionId as string;
      const [a] = itemsOf(state);
      await db().query(`UPDATE test_sessions SET started_at = now() - interval '1 hour', ends_at = now() - interval '1 second' WHERE id = $1`, [id]);
      const res = await save(student, id, { testItemId: a!.testItemId, response: { optionKeys: ['A'] }, status: 'answered' });
      expect(res.status).toBe(200);
      expect(res.body.remainingSeconds).toBe(0);
      const closed = await submit(student, id);
      expect(closed.body).toMatchObject({ status: 'timed_out', totalScore: 4 });
    });

    it('lets the owner read the result of a paper whose deadline passed without anyone closing it', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      await expire(state.sessionId as string);
      const res = await result(student, state.sessionId as string);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('timed_out');
    });

    it('closes the learner\'s expired papers when their test list is read, so the history is true', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      await expire(state.sessionId as string);
      const list = await t.http().get('/v1/tests').set(...bearer(student));
      const entry = (list.body as Json[]).find((x) => x.id === paper.testId)!;
      expect(entry.lastAttempt.status).toBe('timed_out');
    });

    it('closes expired papers nobody touches, through the sweep, and leaves open ones alone', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const live = await createPaper(2);
      const { body: liveState } = await start(student, live.testId);
      await expire(state.sessionId as string);

      const { MockTestsService } = await import('../../src/mock-tests/mock-tests.service');
      const closed = await t.app.get(MockTestsService).finalizeExpiredSessions(500);
      expect(closed).toBeGreaterThanOrEqual(1);
      expect((await sessionRow(state.sessionId as string)).status).toBe('timed_out');
      expect((await sessionRow(liveState.sessionId as string)).status).toBe('in_progress');
      // Running it again closes nothing twice.
      expect(await t.app.get(MockTestsService).finalizeExpiredSessions(500)).toBe(0);
    });

    it('closes them on its own schedule too: a running application sweeps without anyone calling it', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      await expire(state.sessionId as string);

      const { createTestApp } = await import('./helpers');
      const sweeping = await createTestApp({ SWEEP_INTERVAL_SECONDS: '1' });
      try {
        // The sweep runs once at start-up and then every second; wait for it rather than calling it.
        const deadline = Date.now() + 8000;
        let status = (await sessionRow(state.sessionId as string)).status;
        while (status === 'in_progress' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          status = (await sessionRow(state.sessionId as string)).status;
        }
        expect(status).toBe('timed_out');
      } finally {
        await sweeping.close();
      }
    });
  });

  describe('compatibility', () => {
    it('still accepts the old client body that carried timeSpentSec', async () => {
      const paper = await createPaper(2);
      const { body: state } = await start(student, paper.testId);
      const res = await save(student, state.sessionId as string, {
        testItemId: itemsOf(state)[0]!.testItemId,
        response: { optionKeys: ['A'] },
        status: 'answered',
        timeSpentSec: 12,
      });
      expect(res.status).toBe(200);
    });

    it('requires authentication and the practice permission', async () => {
      const paper = await createPaper(1);
      expect((await t.http().post(`/v1/tests/${paper.testId}/start`)).status).toBe(401);
    });
  });
});
