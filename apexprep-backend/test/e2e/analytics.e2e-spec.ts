import {
  bearer,
  closeDb,
  createEngineConfig,
  createSyllabus,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertHistoricalAttempt,
  insertPracticeQuestion,
  login,
  uniq,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
} from './helpers';

/**
 * A learner's own figures (`GET /v1/me/summary`, `/me/analytics`, `/me/recommendations`).
 *
 * These endpoints exist so the dashboard and analytics screens can stop showing invented numbers. The tests
 * below are mostly about the two ways such an endpoint goes wrong:
 *
 *   * **Fabrication** — reporting `0%` to a learner who has answered nothing, drawing a trend line over a
 *     week with no data, or naming a "weakest topic" on the strength of one unlucky question.
 *   * **Leakage** — computing one learner's figures from another's rows, or from another organisation's.
 */
describe('Learner analytics (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  async function arrange() {
    const tenant = await createTenant();
    const student = await createUser(tenant, 'STUDENT');
    const session = await login(t, student, tenant.slug);
    const syllabus = await createSyllabus(tenant);
    const engineConfigId = await createEngineConfig(tenant, {});
    await db().query(`UPDATE users SET primary_track_id = $2 WHERE id = $1`, [student.id, syllabus.trackId]);
    return { tenant, student, session, syllabus, engineConfigId };
  }

  const summary = (s: Session) => t.http().get('/v1/me/summary').set(...bearer(s));
  const analytics = (s: Session, query = '') => t.http().get(`/v1/me/analytics${query}`).set(...bearer(s));
  const recommendations = (s: Session) => t.http().get('/v1/me/recommendations').set(...bearer(s));

  /** One graded attempt, `daysAgo` days back, at a given difficulty and time. */
  async function attempt(
    f: { tenant: TenantFixture; student: { id: string }; syllabus: SyllabusFixture; engineConfigId: string },
    opts: { daysAgo: number; correct: boolean; totalTimeMs?: number; difficulty?: number; subtopicId?: string },
  ) {
    const questionId = await insertPracticeQuestion(f.tenant, opts.subtopicId ?? f.syllabus.subtopicId, {
      b: 1000,
      label: opts.difficulty ?? 3,
    });
    await insertHistoricalAttempt(f.tenant, f.student.id, opts.subtopicId ?? f.syllabus.subtopicId, questionId, f.engineConfigId, {
      daysAgo: opts.daysAgo,
      correct: opts.correct,
      totalTimeMs: opts.totalTimeMs ?? 60_000,
      difficultyLabel: opts.difficulty ?? 3,
    });
    return questionId;
  }

  // ------------------------------------------------------------------ the empty state

  describe('a learner who has answered nothing', () => {
    it('is told they have no figures yet, not that they scored zero', async () => {
      const f = await arrange();
      const res = await summary(f.session);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        solvedToday: 0,
        todayAccuracy: null, // NOT 0 — this is the whole point
        studyMinutesToday: 0,
        streakDays: 0,
        questionsSolvedTotal: 0,
      });
    });

    it('has null analytics rather than zeroed analytics', async () => {
      const f = await arrange();
      const res = await analytics(f.session);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        overallAccuracy: null,
        accuracyDelta: null,
        questionsSolved: 0,
        paceSeconds: null,
      });
      // The five level rows are present so the UI's five rows do not shift, each with no accuracy.
      expect(res.body.levelAccuracy).toHaveLength(5);
      expect(res.body.levelAccuracy.every((r: { accuracy: number | null }) => r.accuracy === null)).toBe(true);
      // Every week of the window is present, and none of them claims a figure.
      expect(res.body.trend.length).toBeGreaterThan(0);
      expect(res.body.trend.every((p: { accuracy: number | null; questions: number }) => p.accuracy === null && p.questions === 0)).toBe(true);
      expect(res.body.weakSubtopics).toEqual([]);
      expect(res.body.strongSubtopics).toEqual([]);
      expect(res.body.subtopicPerformance).toEqual([]);
    });

    it('gets no recommendations rather than an invented one', async () => {
      const f = await arrange();
      const res = await recommendations(f.session);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('still lists the subjects of their track, so the progress panel is not empty', async () => {
      const f = await arrange();
      const res = await analytics(f.session);
      expect(res.body.subjectSummary).toHaveLength(1);
      expect(res.body.subjectSummary[0]).toMatchObject({ name: 'Physics', accuracy: null, level: null, questions: 0 });
    });
  });

  // ------------------------------------------------------------------ real figures

  describe('figures over real attempts', () => {
    it('counts today’s work and computes today’s accuracy', async () => {
      const f = await arrange();
      await attempt(f, { daysAgo: 0, correct: true, totalTimeMs: 90_000 });
      await attempt(f, { daysAgo: 0, correct: true, totalTimeMs: 90_000 });
      await attempt(f, { daysAgo: 0, correct: false, totalTimeMs: 60_000 });
      await attempt(f, { daysAgo: 5, correct: true }); // not today

      const res = await summary(f.session);
      expect(res.body).toMatchObject({
        solvedToday: 3,
        todayAccuracy: 66.7, // 2 of 3, to one decimal
        studyMinutesToday: 4, // 90+90+60 s = 4 minutes
        questionsSolvedTotal: 4,
      });
    });

    it('computes overall accuracy, pace and per-level accuracy from the attempt rows', async () => {
      const f = await arrange();
      await attempt(f, { daysAgo: 1, correct: true, difficulty: 2, totalTimeMs: 40_000 });
      await attempt(f, { daysAgo: 1, correct: true, difficulty: 2, totalTimeMs: 60_000 });
      await attempt(f, { daysAgo: 2, correct: false, difficulty: 4, totalTimeMs: 200_000 });

      const res = await analytics(f.session);
      expect(res.body.overallAccuracy).toBe(66.7);
      expect(res.body.questionsSolved).toBe(3);
      expect(res.body.paceSeconds).toBe(60); // median of 40/60/200
      const l2 = res.body.levelAccuracy.find((r: { level: number }) => r.level === 2);
      const l4 = res.body.levelAccuracy.find((r: { level: number }) => r.level === 4);
      expect(l2).toMatchObject({ attempted: 2, correct: 2, accuracy: 100 });
      expect(l4).toMatchObject({ attempted: 1, correct: 0, accuracy: 0 });
    });

    it('reads the L1–L5 level from the engine rather than inventing a mastery percentage', async () => {
      const f = await arrange();
      await attempt(f, { daysAgo: 1, correct: true });
      // The engine's own row, as the adaptive engine would have written it. The endpoint must report
      // this number and not derive one of its own.
      await db().query(
        `INSERT INTO ability_scores (tenant_id, user_id, subtopic_id, theta, level, engine_config_id)
         VALUES ($1, $2, $3, 1350, 4, $4)
         ON CONFLICT (tenant_id, user_id, subtopic_id) DO UPDATE SET level = 4, theta = 1350`,
        [f.tenant.id, f.student.id, f.syllabus.subtopicId, f.engineConfigId],
      );

      const res = await analytics(f.session);
      const subject = res.body.subjectSummary[0];
      expect(subject.level).toBe(4);
      // No mastery percentage anywhere in the payload: the requirements define none.
      expect(JSON.stringify(res.body)).not.toMatch(/"mastery"|"masteryPct"|"overallMastery"/);
    });

    it('excludes probable guesses from the pace, so rushing does not flatter it', async () => {
      const f = await arrange();
      const q = await insertPracticeQuestion(f.tenant, f.syllabus.subtopicId, { b: 1000 });
      await insertHistoricalAttempt(f.tenant, f.student.id, f.syllabus.subtopicId, q, f.engineConfigId, {
        daysAgo: 1,
        correct: true,
        totalTimeMs: 120_000,
      });
      const guess = await insertPracticeQuestion(f.tenant, f.syllabus.subtopicId, { b: 1000 });
      await insertHistoricalAttempt(f.tenant, f.student.id, f.syllabus.subtopicId, guess, f.engineConfigId, {
        daysAgo: 1,
        correct: false,
        totalTimeMs: 2_000,
        probableGuess: true,
      });

      expect((await analytics(f.session)).body.paceSeconds).toBe(120);
    });

    it('does not rank a sub-topic as weakest on the strength of one question', async () => {
      const f = await arrange();
      // One wrong answer in a second sub-topic: genuinely 0%, but not evidence of a weakness.
      const other = await db().query<{ id: string }>(
        `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Rolling', 'published') RETURNING id`,
        [f.tenant.id, f.syllabus.topicId, uniq('rolling')],
      );
      await attempt(f, { daysAgo: 1, correct: false, subtopicId: other.rows[0]!.id });
      for (let i = 0; i < 6; i += 1) await attempt(f, { daysAgo: 1, correct: i < 3 });

      const res = await analytics(f.session);
      // The 6-attempt sub-topic is rankable; the 1-attempt one is not.
      expect(res.body.weakSubtopics).toHaveLength(1);
      expect(res.body.weakSubtopics[0]).toMatchObject({ subtopicName: 'Angular Momentum', questions: 6, accuracy: 50 });

      /**
       * But the unranked one is still reported, unranked.
       *
       * The syllabus pages label each sub-topic with the learner's level, and the Reports table lists every
       * sub-topic they have touched. Were this list a top-five slice, a sub-topic with real attempts would be
       * shown as blank — which reads as "never practised" rather than "not enough attempts to rank".
       */
      expect(res.body.subtopicPerformance).toHaveLength(2);
      expect(res.body.subtopicPerformance.map((p: { subtopicName: string }) => p.subtopicName).sort()).toEqual(['Angular Momentum', 'Rolling']);
      const rolling = res.body.subtopicPerformance.find((p: { subtopicName: string }) => p.subtopicName === 'Rolling');
      expect(rolling).toMatchObject({ questions: 1, accuracy: 0 });
    });

    it('puts attempts in the right week and leaves quiet weeks null', async () => {
      const f = await arrange();
      await attempt(f, { daysAgo: 0, correct: true });
      await attempt(f, { daysAgo: 21, correct: false });

      const res = await analytics(f.session, '?range=90d');
      const withData = res.body.trend.filter((p: { questions: number }) => p.questions > 0);
      expect(withData).toHaveLength(2);
      const quiet = res.body.trend.filter((p: { questions: number }) => p.questions === 0);
      expect(quiet.every((p: { accuracy: number | null }) => p.accuracy === null)).toBe(true);
    });

    it('honours the range window', async () => {
      const f = await arrange();
      await attempt(f, { daysAgo: 2, correct: true });
      await attempt(f, { daysAgo: 40, correct: false });

      expect((await analytics(f.session, '?range=7d')).body.questionsSolved).toBe(1);
      expect((await analytics(f.session, '?range=90d')).body.questionsSolved).toBe(2);
      expect((await analytics(f.session, '?range=all')).body.questionsSolved).toBe(2);
      expect((await analytics(f.session, '?range=nonsense')).status).toBe(400);
    });

    it('recommends where they last practised and their weakest sub-topic, each with a stated reason', async () => {
      const f = await arrange();
      for (let i = 0; i < 6; i += 1) await attempt(f, { daysAgo: 3, correct: i < 2 });
      // A session makes this the "continue" sub-topic.
      await db().query(
        `INSERT INTO sessions (tenant_id, user_id, subtopic_id, engine_config_id, focus_tracking_enabled, status, ended_at, last_activity_at)
         VALUES ($1, $2, $3, $4, false, 'completed', now(), now())`,
        [f.tenant.id, f.student.id, f.syllabus.subtopicId, f.engineConfigId],
      );

      const res = await recommendations(f.session);
      expect(res.body.items.length).toBeGreaterThan(0);
      const kinds = res.body.items.map((i: { kind: string }) => i.kind);
      expect(kinds).toContain('continue');
      for (const item of res.body.items) {
        expect(item.reason).toBeTruthy(); // every recommendation states why
        expect(item.subtopicId).toMatch(/[0-9a-f-]{36}/);
        expect(item.questionCount).toBeGreaterThanOrEqual(0);
      }
    });

    it('computes §10 coverage against published sub-topics', async () => {
      const f = await arrange();
      // The track has one published sub-topic. Ten attempts on it covers 100%.
      for (let i = 0; i < 10; i += 1) await attempt(f, { daysAgo: 1, correct: true });
      expect((await analytics(f.session)).body.coveragePct).toBe(100);
    });
  });

  // ------------------------------------------------------------------ isolation

  describe('a learner sees only their own figures', () => {
    it('does not count another learner in the same organisation', async () => {
      const f = await arrange();
      const other = await createUser(f.tenant, 'STUDENT');
      const otherSession = await login(t, other, f.tenant.slug);
      await db().query(`UPDATE users SET primary_track_id = $2 WHERE id = $1`, [other.id, f.syllabus.trackId]);

      for (let i = 0; i < 5; i += 1) await attempt(f, { daysAgo: 0, correct: true });

      expect((await summary(f.session)).body.solvedToday).toBe(5);
      // The other learner in the same tenant, same track, same sub-topic: still zero.
      const theirs = await summary(otherSession);
      expect(theirs.body).toMatchObject({ solvedToday: 0, todayAccuracy: null, questionsSolvedTotal: 0 });
      expect((await analytics(otherSession)).body.overallAccuracy).toBeNull();
      expect((await recommendations(otherSession)).body.items).toEqual([]);
    });

    it('does not count a learner from another organisation', async () => {
      const a = await arrange();
      const b = await arrange();
      for (let i = 0; i < 4; i += 1) await attempt(a, { daysAgo: 0, correct: true });

      expect((await summary(a.session)).body.questionsSolvedTotal).toBe(4);
      expect((await summary(b.session)).body.questionsSolvedTotal).toBe(0);
    });

    it('takes no user id from the request: there is nowhere to put one', async () => {
      const f = await arrange();
      const other = await createUser(f.tenant, 'STUDENT');
      for (let i = 0; i < 3; i += 1) await attempt(f, { daysAgo: 0, correct: true });
      // Anything a client might try is simply ignored — the learner comes from the token.
      const res = await t.http().get(`/v1/me/summary?userId=${other.id}`).set(...bearer(f.session));
      expect(res.status).toBe(200);
      expect(res.body.solvedToday).toBe(3);
    });
  });

  // ------------------------------------------------------------------ access

  describe('access control', () => {
    it('needs a signed-in learner', async () => {
      expect((await t.http().get('/v1/me/summary')).status).toBe(401);
      expect((await t.http().get('/v1/me/analytics')).status).toBe(401);
      expect((await t.http().get('/v1/me/recommendations')).status).toBe(401);
    });

    it('is not an admin endpoint: these are a learner’s own figures', async () => {
      const f = await arrange();
      const adminUser = await createUser(f.tenant, 'ADMIN');
      const adminSession = await login(t, adminUser, f.tenant.slug);
      expect((await summary(adminSession)).status).toBe(403);
      expect((await analytics(adminSession)).status).toBe(403);
      expect((await recommendations(adminSession)).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------ profile-derived

  it('counts down to the learner’s own target exam date, and reports none when unset', async () => {
    const f = await arrange();
    expect((await summary(f.session)).body.daysToTargetExam).toBeNull();

    await t
      .http()
      .patch('/v1/me/profile')
      .set(...bearer(f.session))
      .send({ targetExamDate: '2027-05-23', dailyQuestionGoal: 40 });

    const res = await summary(f.session);
    expect(res.body.dailyQuestionGoal).toBe(40);
    expect(typeof res.body.daysToTargetExam).toBe('number');
    expect(res.body.daysToTargetExam).toBeGreaterThan(0);
  });
});
