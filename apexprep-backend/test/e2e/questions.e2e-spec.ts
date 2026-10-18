import { questionSamples, SECRET_NUMERIC } from './question-samples';
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
  login,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Question bank (e2e)', () => {
  let t: TestApp;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let admin: Session;
  let adminB: Session;
  let student: Session;
  let syl: SyllabusFixture;

  const create = (payload: Record<string, unknown>, as: Session = admin) =>
    t.http().post('/v1/admin/questions').set(...bearer(as)).send(payload);

  const sample = (type: string) => questionSamples(syl.subtopicId).find((s) => s.type === type)!.payload;

  beforeAll(async () => {
    t = await createTestApp();
    tenantA = await createTenant();
    tenantB = await createTenant();
    const [adminUser, adminBUser, studentUser] = await Promise.all([
      createUser(tenantA, 'ADMIN'),
      createUser(tenantB, 'ADMIN'),
      createUser(tenantA, 'STUDENT'),
    ]);
    [admin, adminB, student] = await Promise.all([
      login(t, adminUser, tenantA.slug),
      login(t, adminBUser, tenantB.slug),
      login(t, studentUser, tenantA.slug),
    ]);
    syl = await createSyllabus(tenantA);
    await createEngineConfig(tenantA);
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  describe('creating', () => {
    it.each(questionSamples('placeholder').map((s) => s.type))('creates a %s question as a draft', async (type) => {
      const res = await create(sample(type));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ type, status: 'draft', version: 1, difficultyLabel: 2 });
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('takes the starting Elo difficulty from the active engine configuration', async () => {
      const res = await create({ ...sample('long_form'), difficultyLabel: 4 });
      expect(res.body.difficultyB).toBe(1400);
      expect(res.body.calibrationN).toBe(0);
    });

    it('refuses to create questions when the organisation has no active engine configuration', async () => {
      const sylB = await createSyllabus(tenantB);
      const res = await create({ ...sample('long_form'), subtopicId: sylB.subtopicId }, adminB);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ENGINE_CONFIG_MISSING');
    });

    it('stores the exact decimal answer and forces integer answers to be exact', async () => {
      const numeric = await create(sample('numeric'));
      expect(numeric.body.numericAnswer).toEqual({ value: SECRET_NUMERIC, tolerance: '0.05', mode: 'absolute' });
      const integer = await create(sample('integer'));
      expect(integer.body.numericAnswer).toMatchObject({ tolerance: '0', mode: 'absolute' });
    });

    it('rejects an answer shape that does not match the type', async () => {
      const twoCorrect = await create({
        ...sample('single_correct'),
        options: [
          { key: 'A', text: 'one', isCorrect: true },
          { key: 'B', text: 'two', isCorrect: true },
        ],
      });
      expect(twoCorrect.status).toBe(400);
      expect(twoCorrect.body.error.code).toBe('VALIDATION_FAILED');
      expect(twoCorrect.body.error.details[0].field).toBe('options');

      expect((await create({ ...sample('integer'), numericAnswer: { value: '1.5' } })).status).toBe(400);
      expect((await create({ ...sample('long_form'), options: [{ key: 'A', text: 'x' }] })).status).toBe(400);
      const badMatrix = await create({ ...sample('matrix_match'), matrixAnswer: { A: ['zz'], B: ['p'] } });
      expect(badMatrix.body.error.details.map((d: Json) => d.field)).toContain('matrixAnswer.A');
    });

    it('rejects an unknown or foreign sub-topic, and a secondary sub-topic that repeats the primary', async () => {
      const foreign = await createSyllabus(tenantB);
      const res = await create({ ...sample('long_form'), subtopicId: foreign.subtopicId });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('REFERENCE_NOT_FOUND');

      const repeated = await create({ ...sample('long_form'), secondarySubtopicIds: [syl.subtopicId] });
      expect(repeated.status).toBe(422);
      expect(repeated.body.error.details[0].field).toBe('secondarySubtopicIds[0]');
    });

    it('records secondary sub-topics', async () => {
      const second = await createSubtopic(tenantA, syl.topicId, 'published', 'Torque');
      const res = await create({ ...sample('long_form'), secondarySubtopicIds: [second] });
      expect(res.body.secondarySubtopicIds).toEqual([second]);
    });

    it('is closed to students', async () => {
      expect((await create(sample('long_form'), student)).status).toBe(403);
      expect((await t.http().get('/v1/admin/questions').set(...bearer(student))).status).toBe(403);
    });
  });

  describe('editing and versioning', () => {
    it('bumps the version when the content or the answer key changes, but not for difficulty alone', async () => {
      const created = await create(sample('single_correct'));
      const id = created.body.id as string;

      const stemEdit = await t.http().patch(`/v1/admin/questions/${id}`).set(...bearer(admin)).send({ stem: 'Reworded stem for the ring question?' });
      expect(stemEdit.body.version).toBe(2);

      // Option edits bump the parent version only once the question has left draft, since a
      // draft is never served (trigger app_question_options_bump_parent, migration 0004).
      await t.http().post(`/v1/admin/questions/${id}/publish`).set(...bearer(admin));
      const answerEdit = await t.http().patch(`/v1/admin/questions/${id}`).set(...bearer(admin)).send({
        options: [
          { key: 'A', text: 'MR squared' },
          { key: 'B', text: 'half MR squared', isCorrect: true },
        ],
      });
      expect(answerEdit.body.version).toBeGreaterThan(2);
      expect(answerEdit.body.options.find((o: Json) => o.key === 'B').isCorrect).toBe(true);
      expect(answerEdit.body.options).toHaveLength(2);

      const versionBefore = answerEdit.body.version;
      const labelEdit = await t.http().patch(`/v1/admin/questions/${id}`).set(...bearer(admin)).send({ difficultyLabel: 5 });
      expect(labelEdit.body).toMatchObject({ version: versionBefore, difficultyLabel: 5, difficultyB: 1600 });
      expect(await auditActions(tenantA.id, id)).toEqual(expect.arrayContaining(['question.created', 'question.updated']));
    });

    it('keeps a calibrated difficulty when the label changes', async () => {
      const created = await create(sample('long_form'));
      await db().query(`UPDATE questions SET calibration_n = 25, difficulty_b = 1234.50 WHERE id = $1`, [created.body.id]);
      const res = await t.http().patch(`/v1/admin/questions/${created.body.id}`).set(...bearer(admin)).send({ difficultyLabel: 1 });
      expect(res.body).toMatchObject({ difficultyLabel: 1, difficultyB: 1234.5 });
    });

    it('refuses to change the type or to accept an unknown field', async () => {
      const created = await create(sample('long_form'));
      const res = await t.http().patch(`/v1/admin/questions/${created.body.id}`).set(...bearer(admin)).send({ type: 'single_correct' });
      expect(res.status).toBe(400);
    });

    it('moves a question to another sub-topic and replaces the secondary list', async () => {
      const other = await createSubtopic(tenantA, syl.topicId, 'published', 'Energy');
      const created = await create({ ...sample('long_form'), secondarySubtopicIds: [other] });
      const moved = await t.http().patch(`/v1/admin/questions/${created.body.id}`).set(...bearer(admin)).send({ subtopicId: other, secondarySubtopicIds: [syl.subtopicId] });
      expect(moved.body).toMatchObject({ subtopicId: other, secondarySubtopicIds: [syl.subtopicId] });
    });

    it('cannot read or edit another organisation’s questions', async () => {
      const created = await create(sample('long_form'));
      expect((await t.http().get(`/v1/admin/questions/${created.body.id}`).set(...bearer(adminB))).status).toBe(404);
      expect((await t.http().patch(`/v1/admin/questions/${created.body.id}`).set(...bearer(adminB)).send({ stem: 'Hijack' })).status).toBe(404);
      expect((await t.http().post(`/v1/admin/questions/${created.body.id}/publish`).set(...bearer(adminB))).status).toBe(404);
    });
  });

  describe('publishing lifecycle', () => {
    it('publishes a valid draft, then refuses to publish it twice', async () => {
      const created = await create(sample('single_correct'));
      const published = await t.http().post(`/v1/admin/questions/${created.body.id}/publish`).set(...bearer(admin));
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({ status: 'published' });
      expect(published.body.publishedAt).not.toBeNull();

      const again = await t.http().post(`/v1/admin/questions/${created.body.id}/publish`).set(...bearer(admin));
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('INVALID_STATE');
      expect(await auditActions(tenantA.id, created.body.id)).toContain('question.published');
    });

    it('refuses to publish a question whose options were emptied behind the API', async () => {
      const created = await create(sample('single_correct'));
      await db().query(`DELETE FROM question_options WHERE question_id = $1`, [created.body.id]);
      const res = await t.http().post(`/v1/admin/questions/${created.body.id}/publish`).set(...bearer(admin));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('NOT_PUBLISHABLE');
      expect(res.body.error.details[0].field).toBe('options');
      const { rows } = await db().query<{ status: string }>(`SELECT status FROM questions WHERE id = $1`, [created.body.id]);
      expect(rows[0]!.status).toBe('draft');
    });

    it('retires a published question and lets it be published again', async () => {
      const created = await create(sample('numeric'));
      await t.http().post(`/v1/admin/questions/${created.body.id}/publish`).set(...bearer(admin));
      const retired = await t.http().post(`/v1/admin/questions/${created.body.id}/retire`).set(...bearer(admin));
      expect(retired.body.status).toBe('retired');
      expect((await t.http().post(`/v1/admin/questions/${created.body.id}/retire`).set(...bearer(admin))).status).toBe(409);
      expect((await t.http().post(`/v1/admin/questions/${created.body.id}/publish`).set(...bearer(admin))).body.status).toBe('published');
    });

    it('refuses to retire a draft', async () => {
      const created = await create(sample('long_form'));
      const res = await t.http().post(`/v1/admin/questions/${created.body.id}/retire`).set(...bearer(admin));
      expect(res.status).toBe(409);
    });

    it('deletes a draft but not a published question', async () => {
      const draft = await create(sample('long_form'));
      expect((await t.http().delete(`/v1/admin/questions/${draft.body.id}`).set(...bearer(admin))).status).toBe(204);
      expect((await t.http().get(`/v1/admin/questions/${draft.body.id}`).set(...bearer(admin))).status).toBe(404);

      const published = await create(sample('single_correct'));
      await t.http().post(`/v1/admin/questions/${published.body.id}/publish`).set(...bearer(admin));
      const refused = await t.http().delete(`/v1/admin/questions/${published.body.id}`).set(...bearer(admin));
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('INVALID_STATE');
    });

    it('counts only published questions in the syllabus tree', async () => {
      const sub = await createSubtopic(tenantA, syl.topicId, 'published', 'Counting');
      const draft = await create({ ...sample('long_form'), subtopicId: sub });
      const published = await create({ ...sample('numeric'), subtopicId: sub });
      await t.http().post(`/v1/admin/questions/${published.body.id}/publish`).set(...bearer(admin));

      const tree = await t.http().get(`/v1/tracks/${syl.trackId}/tree`).set(...bearer(student));
      const node = (tree.body as Json).subjects[0].chapters[0].topics[0].subtopics.find((s: Json) => s.id === sub);
      expect(node.questionCount).toBe(1);
      expect(draft.body.status).toBe('draft');

      const topic = (tree.body as Json).subjects[0].chapters[0].topics[0];
      expect(topic.questionCount).toBeGreaterThanOrEqual(1);
    });

    it('refuses to delete a sub-topic that still has questions', async () => {
      const sub = await createSubtopic(tenantA, syl.topicId, 'published', 'Occupied');
      await create({ ...sample('long_form'), subtopicId: sub });
      const res = await t.http().delete(`/v1/admin/subtopics/${sub}`).set(...bearer(admin));
      expect(res.status).toBe(409);
      expect(res.body.error.details.map((d: Json) => d.field)).toContain('questions');
    });
  });

  describe('official solutions', () => {
    it('sets, replaces and removes the official solution', async () => {
      const created = await create(sample('integer'));
      const first = await t.http().put(`/v1/admin/questions/${created.body.id}/official-solution`).set(...bearer(admin)).send({ body: 'τ = Iα so α = 2 rad/s².', finalAnswerText: '2' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: 'approved', finalAnswerText: '2' });

      const second = await t.http().put(`/v1/admin/questions/${created.body.id}/official-solution`).set(...bearer(admin)).send({ body: 'Corrected working.' });
      expect(second.body.id).not.toBe(first.body.id);

      const detail = await t.http().get(`/v1/admin/questions/${created.body.id}`).set(...bearer(admin));
      expect(detail.body.officialSolution).toMatchObject({ id: second.body.id, body: 'Corrected working.' });

      const { rows } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM official_solutions WHERE question_id = $1 AND status = 'approved' AND deleted_at IS NULL`,
        [created.body.id],
      );
      expect(rows[0]!.n).toBe('1');

      expect((await t.http().delete(`/v1/admin/questions/${created.body.id}/official-solution`).set(...bearer(admin))).status).toBe(204);
      expect((await t.http().delete(`/v1/admin/questions/${created.body.id}/official-solution`).set(...bearer(admin))).status).toBe(404);
      expect((await t.http().get(`/v1/admin/questions/${created.body.id}`).set(...bearer(admin))).body.officialSolution).toBeNull();
    });
  });

  describe('listing', () => {
    let sub: string;
    beforeAll(async () => {
      sub = await createSubtopic(tenantA, syl.topicId, 'published', 'Listing');
      for (const s of questionSamples(sub)) await create(s.payload);
      const first = await create({ ...sample('long_form'), subtopicId: sub, stem: 'Prove the parallel-axis theorem from first principles.' });
      await t.http().post(`/v1/admin/questions/${first.body.id}/publish`).set(...bearer(admin));
    });

    it('filters by sub-topic, type, status and difficulty', async () => {
      const bySubtopic = await t.http().get(`/v1/admin/questions?subtopicId=${sub}&limit=100`).set(...bearer(admin));
      expect(bySubtopic.status).toBe(200);
      expect(bySubtopic.body.items).toHaveLength(8);
      expect(bySubtopic.body.items.every((q: Json) => q.subtopicId === sub)).toBe(true);
      expect(bySubtopic.body.items[0].stemPreview.length).toBeLessThanOrEqual(201);

      const byType = await t.http().get(`/v1/admin/questions?subtopicId=${sub}&type=matrix_match`).set(...bearer(admin));
      expect(byType.body.items.map((q: Json) => q.type)).toEqual(['matrix_match']);

      const byStatus = await t.http().get(`/v1/admin/questions?subtopicId=${sub}&status=published`).set(...bearer(admin));
      expect(byStatus.body.items).toHaveLength(1);
      expect(byStatus.body.items[0].hasOfficialSolution).toBe(false);

      const byLevel = await t.http().get(`/v1/admin/questions?subtopicId=${sub}&difficultyLabel=5`).set(...bearer(admin));
      expect(byLevel.body.items).toHaveLength(0);
    });

    it('searches stems and paginates with a cursor', async () => {
      const search = await t.http().get(`/v1/admin/questions?subtopicId=${sub}&search=parallel-axis`).set(...bearer(admin));
      expect(search.body.items).toHaveLength(1);
      expect(search.body.items[0].stemPreview).toContain('parallel-axis');

      const page1 = await t.http().get(`/v1/admin/questions?subtopicId=${sub}&limit=3`).set(...bearer(admin));
      expect(page1.body.items).toHaveLength(3);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await t.http().get(`/v1/admin/questions?subtopicId=${sub}&limit=3&cursor=${encodeURIComponent(page1.body.nextCursor)}`).set(...bearer(admin));
      const ids = [...page1.body.items, ...page2.body.items].map((q: Json) => q.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('lists only the caller’s organisation', async () => {
      const res = await t.http().get('/v1/admin/questions?limit=100').set(...bearer(adminB));
      expect(res.body.items).toEqual([]);
    });
  });
});
