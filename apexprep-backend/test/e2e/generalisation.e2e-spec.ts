import {
  ageServedItem,
  bearer,
  closeDb,
  createEngineConfig,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertContentBlock,
  insertPracticeQuestion,
  login,
  uniq,
  type Session,
  type TenantFixture,
  type TestApp,
} from './helpers';
import { AI_PRIMARY_PROVIDER } from '../../src/ai/ai-provider';
import { FakeAiProvider } from './fake-ai';

/**
 * Phase 8: the platform is a general adaptive learning platform, and JEE/NEET/Olympiad are examples
 * of learning tracks rather than the shape of the product.
 *
 * That claim is only worth making if a Class 5 learner works through exactly the same code as a JEE
 * learner — not a parallel path, not a special case. These tests take a primary-school learner all
 * the way through: enrol, practise, be graded, be placed on the ladder, read an explanation. If any
 * exam assumption were left in the engine, the selection rules, the grading weights or the explanation
 * path, one of these would fail.
 *
 * They also pin down what must NOT have changed. Every track that existed before migration 0013 has
 * no learning context at all, and a platform that behaved differently for those tracks would have
 * broken Phases 1–7 while claiming to generalise them.
 */
describe('A general learning platform (e2e)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;

  beforeAll(async () => {
    fake = new FakeAiProvider();
    t = await createTestApp({}, [{ token: AI_PRIMARY_PROVIDER, value: fake }]);
  });
  afterAll(async () => {
    await t.close();
    await closeDb();
  });
  beforeEach(() => {
    fake.reset();
  });

  /** A complete school syllabus path: Class 5 Mathematics → … → Perimeter of a Rectangle. */
  async function schoolSyllabus(tenant: TenantFixture, grade = 5) {
    const one = async (sql: string, params: unknown[]): Promise<string> =>
      (await db().query<{ id: string }>(sql, params)).rows[0]!.id;
    const trackId = await one(
      `INSERT INTO tracks (tenant_id, slug, name, kind, education_stage, grade_label, grade_ordinal, curriculum, locale, status)
       VALUES ($1, $2, $3, 'school', 'primary', $4, $5, 'CBSE', 'en-IN', 'published') RETURNING id`,
      [tenant.id, uniq('class-maths'), `Class ${grade} Mathematics`, `Class ${grade}`, grade],
    );
    const subjectId = await one(
      `INSERT INTO subjects (tenant_id, track_id, slug, name, status) VALUES ($1, $2, $3, 'Mathematics', 'published') RETURNING id`,
      [tenant.id, trackId, uniq('mathematics')],
    );
    const chapterId = await one(
      `INSERT INTO chapters (tenant_id, subject_id, slug, name, status) VALUES ($1, $2, $3, 'Shapes and Fractions', 'published') RETURNING id`,
      [tenant.id, subjectId, uniq('shapes')],
    );
    const topicId = await one(
      `INSERT INTO topics (tenant_id, chapter_id, slug, name, status) VALUES ($1, $2, $3, 'Perimeter', 'published') RETURNING id`,
      [tenant.id, chapterId, uniq('perimeter')],
    );
    const subtopicId = await one(
      `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Perimeter of a Rectangle', 'published') RETURNING id`,
      [tenant.id, topicId, uniq('perimeter-rectangle')],
    );
    return { trackId, subjectId, chapterId, topicId, subtopicId };
  }

  async function arrange(options: { questions?: number; grade?: number } = {}) {
    const tenant = await createTenant();
    const student = await createUser(tenant, 'STUDENT');
    const adminUser = await createUser(tenant, 'ADMIN');
    const [session, admin] = await Promise.all([login(t, student, tenant.slug), login(t, adminUser, tenant.slug)]);
    const syllabus = await schoolSyllabus(tenant, options.grade ?? 5);
    const engineConfigId = await createEngineConfig(tenant, {});
    const questionIds: string[] = [];
    for (let i = 0; i < (options.questions ?? 6); i += 1) {
      questionIds.push(
        await insertPracticeQuestion(tenant, syllabus.subtopicId, {
          b: 900 + i * 20,
          stem: `A rectangle is ${8 + i} cm long and 5 cm wide. What is its perimeter, in centimetres?`,
        }),
      );
    }
    return { tenant, student, session, admin, syllabus, engineConfigId, questionIds };
  }

  // ------------------------------------------------------------------ the whole journey

  it('takes a Class 5 learner from enrolment to a graded attempt through the ordinary path', async () => {
    const f = await arrange();

    // 1. The learner enrols in a school track. Nothing about enrolment mentions exams.
    const enrolled = await t
      .http()
      .post('/v1/me/tracks')
      .set(...bearer(f.session))
      .send({ trackId: f.syllabus.trackId, goalText: 'Get confident with perimeter' });
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.track).toMatchObject({ kind: 'school', gradeLabel: 'Class 5', gradeOrdinal: 5 });

    // 2. The syllabus reads the same as any other.
    const tree = await t
      .http()
      .get(`/v1/tracks/${f.syllabus.trackId}/tree`)
      .set(...bearer(f.session));
    expect(tree.status).toBe(200);
    expect(JSON.stringify(tree.body)).toContain('Perimeter of a Rectangle');
    // The track's own learning context travels with the tree the Learn pages render.
    expect(tree.body.track ?? tree.body).toMatchObject({ kind: 'school', gradeLabel: 'Class 5' });

    // 3. Practice starts, and the engine places the learner exactly as it would anywhere else.
    const started = await t
      .http()
      .post('/v1/practice/sessions')
      .set(...bearer(f.session))
      .send({ subtopicId: f.syllabus.subtopicId });
    expect(started.status).toBe(201);
    expect(started.body.session.mode).toBe('placement');

    const served = await t
      .http()
      .get(`/v1/practice/sessions/${started.body.session.id}/next`)
      .set(...bearer(f.session));
    expect(served.status).toBe(200);
    // The same safety rule as everywhere: no answer key reaches a learner, whatever their age.
    expect(JSON.stringify(served.body)).not.toMatch(/isCorrect|correctOptionKeys|difficultyB|calibrationN/);

    // 4. An answer is graded and moves the learner's ability.
    await ageServedItem(served.body.item.id as string, 40_000);
    const answered = await t
      .http()
      .post('/v1/practice/attempts')
      .set(...bearer(f.session))
      .set('Idempotency-Key', uniq('class5'))
      .send({ sessionItemId: served.body.item.id, response: { optionKeys: ['A'] }, totalTimeMs: 40_000 });
    expect(answered.status).toBe(201);
    expect(answered.body).toMatchObject({ correct: true });
    // The learner is on the same L1–L5 ladder as every other learner: the engine has no notion of
    // school or exam, so there is nothing else it could put them on.
    expect(answered.body.progress.level).toBeGreaterThanOrEqual(1);
    expect(answered.body.progress.level).toBeLessThanOrEqual(5);
    expect(answered.body.progress.attemptsCount).toBe(1);

    const { rows } = await db().query<{ subtopic_id: string; attempts_count: number }>(
      `SELECT subtopic_id, attempts_count FROM ability_scores WHERE user_id = $1`,
      [f.student.id],
    );
    expect(rows).toEqual([expect.objectContaining({ subtopic_id: f.syllabus.subtopicId, attempts_count: 1 })]);
  });

  it('explains a Class 5 question from the notes behind it, with no exam framing anywhere', async () => {
    const f = await arrange({ questions: 1 });
    await insertContentBlock(f.tenant, f.syllabus.subtopicId, {
      title: 'Perimeter',
      text:
        'The perimeter of a shape is the total distance all the way around it. For a rectangle you add all four sides, ' +
        'so the perimeter is length + width + length + width. That is the same as two lots of the length and width ' +
        'together: perimeter = 2 x (length + width). Always give the answer in the same unit as the sides.',
      sortOrder: 0,
    });

    // The learner has to have attempted the question, which is the same floor as anywhere.
    const started = await t
      .http()
      .post('/v1/practice/sessions')
      .set(...bearer(f.session))
      .send({ subtopicId: f.syllabus.subtopicId });
    const served = await t
      .http()
      .get(`/v1/practice/sessions/${started.body.session.id}/next`)
      .set(...bearer(f.session));
    await ageServedItem(served.body.item.id as string, 50_000);
    await t
      .http()
      .post('/v1/practice/attempts')
      .set(...bearer(f.session))
      .set('Idempotency-Key', uniq('class5-explain'))
      .send({ sessionItemId: served.body.item.id, response: { optionKeys: ['B'] }, totalTimeMs: 50_000 });

    // The reply's claim terms all appear in the theory above, so the grounding score is earned by the
    // real formula over real text — exactly as the explanation tests do it for physics.
    fake.reply({
      summary: 'Add all four sides of the rectangle: the perimeter is length + width + length + width.',
      steps: [
        'The perimeter of a shape is the total distance all the way around it.',
        'For a rectangle that is two lots of the length and width together: perimeter = 2 x (length + width).',
      ],
      keyConcept: 'perimeter of a rectangle',
      commonMistake: null,
      finalAnswer: { optionKeys: ['A'] },
      citedBlockIds: [],
    });

    const explanation = await t
      .http()
      .get(`/v1/questions/${f.questionIds[0]}/explanation`)
      .set(...bearer(f.session));
    expect(explanation.status).toBe(200);
    // Grounded in the school track's own notes, and — the point of the test — not held for Olympiad
    // approval, because `kind` is 'school'.
    expect(explanation.body.source).toBe('notes_only');
    expect(explanation.body.notice).toBeNull();
  });

  // ------------------------------------------------------------------ grade is not difficulty

  describe('a grade orders tracks and nothing else', () => {
    it('does not change the difficulty a learner is served', async () => {
      // Two identical tracks that differ only by grade. If `grade_ordinal` leaked into the engine as
      // a difficulty, the question served first would differ between them.
      const tenant = await createTenant();
      const engineConfigId = await createEngineConfig(tenant, {});
      const first = await schoolSyllabus(tenant, 1);
      const twelfth = await schoolSyllabus(tenant, 12);

      const servedLevels: number[] = [];
      for (const syllabus of [first, twelfth]) {
        for (const b of [800, 1000, 1200]) await insertPracticeQuestion(tenant, syllabus.subtopicId, { b });
        const student = await createUser(tenant, 'STUDENT');
        const session = await login(t, student, tenant.slug);
        const started = await t
          .http()
          .post('/v1/practice/sessions')
          .set(...bearer(session))
          .send({ subtopicId: syllabus.subtopicId });
        const served = await t
          .http()
          .get(`/v1/practice/sessions/${started.body.session.id}/next`)
          .set(...bearer(session));
        expect(served.status).toBe(200);
        servedLevels.push(served.body.question.difficultyLabel as number);
      }
      // The cold-start level comes from the engine configuration, which knows nothing about grades.
      expect(servedLevels[0]).toBe(servedLevels[1]);
      expect(engineConfigId).toBeTruthy();
    });

    it('is refused on a track that is not a school track, with the field named', async () => {
      const tenant = await createTenant();
      const adminUser = await createUser(tenant, 'ADMIN');
      const admin = await login(t, adminUser, tenant.slug);
      const res = await t
        .http()
        .post('/v1/admin/tracks')
        .set(...bearer(admin))
        .send({ slug: uniq('bad-grade'), name: 'Exam with a grade', kind: 'competitive_exam', gradeOrdinal: 9 });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toMatchObject({ field: 'gradeOrdinal' });
    });

    it('is refused when a later edit moves the kind away from school', async () => {
      const tenant = await createTenant();
      const adminUser = await createUser(tenant, 'ADMIN');
      const admin = await login(t, adminUser, tenant.slug);
      const created = await t
        .http()
        .post('/v1/admin/tracks')
        .set(...bearer(admin))
        .send({ slug: uniq('school-track'), name: 'Class 9 Science', kind: 'school', gradeLabel: 'Class 9', gradeOrdinal: 9 });
      expect(created.status).toBe(201);

      const res = await t
        .http()
        .patch(`/v1/admin/tracks/${created.body.id}`)
        .set(...bearer(admin))
        .send({ kind: 'other' });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toMatchObject({ field: 'gradeOrdinal' });
    });
  });

  // ------------------------------------------------------------------ admin track metadata

  describe('an admin describes what a track is', () => {
    it('stores every part of the learning context, and returns it', async () => {
      const tenant = await createTenant();
      const adminUser = await createUser(tenant, 'ADMIN');
      const admin = await login(t, adminUser, tenant.slug);
      const body = {
        slug: uniq('class-7-science'),
        name: 'Class 7 Science',
        kind: 'school',
        educationStage: 'middle',
        gradeLabel: 'Class 7',
        gradeOrdinal: 7,
        curriculum: 'ICSE',
        locale: 'en-IN',
      };
      const created = await t
        .http()
        .post('/v1/admin/tracks')
        .set(...bearer(admin))
        .send(body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject(body);
      expect(created.body.examFamily).toBeNull();

      const listed = await t
        .http()
        .get('/v1/admin/tracks')
        .set(...bearer(admin));
      expect(listed.status).toBe(200);
      // The admin list and the student-facing list share TrackDto, so the context reaches both.
      const tracks = listed.body.items as { id: string }[];
      expect(tracks.find((tr) => tr.id === created.body.id)).toMatchObject(body);
    });

    it('refuses a kind it does not know rather than storing it', async () => {
      const tenant = await createTenant();
      const adminUser = await createUser(tenant, 'ADMIN');
      const admin = await login(t, adminUser, tenant.slug);
      const res = await t
        .http()
        .post('/v1/admin/tracks')
        .set(...bearer(admin))
        .send({ slug: uniq('odd'), name: 'Odd', kind: 'bootcamp' });
      expect(res.status).toBe(400);
    });

    it('refuses a locale that is not a language tag', async () => {
      const tenant = await createTenant();
      const adminUser = await createUser(tenant, 'ADMIN');
      const admin = await login(t, adminUser, tenant.slug);
      const res = await t
        .http()
        .post('/v1/admin/tracks')
        .set(...bearer(admin))
        .send({ slug: uniq('loc'), name: 'Locale', locale: 'English (India)' });
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ nothing regressed

  describe('a track that predates the learning context behaves exactly as before', () => {
    it('practises, grades and explains with every metadata column null', async () => {
      // This is the state of every track in an existing database after migration 0013: no kind, no
      // grade, no curriculum. Phase 8 must not have made such a track a second-class citizen.
      const tenant = await createTenant();
      const student = await createUser(tenant, 'STUDENT');
      const session = await login(t, student, tenant.slug);
      const one = async (sql: string, params: unknown[]): Promise<string> =>
        (await db().query<{ id: string }>(sql, params)).rows[0]!.id;
      const trackId = await one(
        `INSERT INTO tracks (tenant_id, slug, name, status) VALUES ($1, $2, 'JEE Advanced 2027', 'published') RETURNING id`,
        [tenant.id, uniq('legacy')],
      );
      const subjectId = await one(
        `INSERT INTO subjects (tenant_id, track_id, slug, name, status) VALUES ($1, $2, $3, 'Physics', 'published') RETURNING id`,
        [tenant.id, trackId, uniq('physics')],
      );
      const chapterId = await one(
        `INSERT INTO chapters (tenant_id, subject_id, slug, name, status) VALUES ($1, $2, $3, 'Mechanics', 'published') RETURNING id`,
        [tenant.id, subjectId, uniq('mechanics')],
      );
      const topicId = await one(
        `INSERT INTO topics (tenant_id, chapter_id, slug, name, status) VALUES ($1, $2, $3, 'Rotation', 'published') RETURNING id`,
        [tenant.id, chapterId, uniq('rotation')],
      );
      const subtopicId = await one(
        `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Angular Momentum', 'published') RETURNING id`,
        [tenant.id, topicId, uniq('angular')],
      );
      await createEngineConfig(tenant, {});
      await insertPracticeQuestion(tenant, subtopicId, { b: 1000 });

      const { rows } = await db().query<{ kind: string | null; grade_ordinal: number | null }>(
        `SELECT kind, grade_ordinal FROM tracks WHERE id = $1`,
        [trackId],
      );
      expect(rows[0]).toEqual({ kind: null, grade_ordinal: null }); // genuinely uncategorised

      const started = await t
        .http()
        .post('/v1/practice/sessions')
        .set(...bearer(session))
        .send({ subtopicId });
      expect(started.status).toBe(201);
      const served = await t
        .http()
        .get(`/v1/practice/sessions/${started.body.session.id}/next`)
        .set(...bearer(session));
      expect(served.status).toBe(200);
      await ageServedItem(served.body.item.id as string, 40_000);
      const answered = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .set('Idempotency-Key', uniq('legacy-attempt'))
        .send({ sessionItemId: served.body.item.id, response: { optionKeys: ['A'] }, totalTimeMs: 40_000 });
      expect(answered.status).toBe(201);
      expect(answered.body.correct).toBe(true);
    });

    it('is enrollable, and reports its context as not stated', async () => {
      const tenant = await createTenant();
      const student = await createUser(tenant, 'STUDENT');
      const session: Session = await login(t, student, tenant.slug);
      const { rows } = await db().query<{ id: string }>(
        `INSERT INTO tracks (tenant_id, slug, name, status) VALUES ($1, $2, 'NEET 2027', 'published') RETURNING id`,
        [tenant.id, uniq('legacy-neet')],
      );
      const res = await t
        .http()
        .post('/v1/me/tracks')
        .set(...bearer(session))
        .send({ trackId: rows[0]!.id });
      expect(res.status).toBe(201);
      expect(res.body.track.kind).toBeNull();
    });
  });
});
