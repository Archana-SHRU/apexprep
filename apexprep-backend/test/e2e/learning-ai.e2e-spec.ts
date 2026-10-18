import { coldStartTheta, levelForTheta, parseEngineParams, targetDifficulty } from '../../src/adaptive';
import { AI_FALLBACK_PROVIDER, AI_PRIMARY_PROVIDER, AiProviderError } from '../../src/ai/ai-provider';
import { JOB_QUEUE, type JobQueue } from '../../src/ingestion/job-queue';
import type { MemoryObjectStorage } from '../../src/storage/memory-object-storage';
import { OBJECT_STORAGE } from '../../src/storage/object-storage';
import { engineParamsJson } from '../fixtures/engine-params';
import { makePdf } from '../fixtures/make-pdf';
import { FakeAiProvider } from './fake-ai';
import {
  ageServedItem,
  auditActions,
  bearer,
  closeDb,
  createEngineConfig,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertContentBlock,
  login,
  uniq,
  type Session,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The learning-AI features end to end, on content that arrived the way real content does.
 *
 * An admin uploads a PDF for a **school** track (Class 5); the ingestion pipeline extracts, segments and
 * maps it onto the syllabus; a reviewer publishes the theory. From then on the same published blocks feed
 * revision notes, the tutor, question generation and visual explanations — and a generated question is
 * served by the adaptive engine and answered through the ordinary attempt API.
 *
 * Only the provider is replaced (`FakeAiProvider`), and it returns **raw text**, so the real parsers,
 * validators, leak checks, grounding measures, caches and database constraints all run.
 */

// A textbook page whose wording matches the syllabus below, so mapping is earned, not arranged.
const TEXTBOOK_PAGE = [
  'Perimeter of a Rectangle',
  '',
  'The perimeter of a rectangle is the total distance around its boundary. To find the perimeter, add the lengths of all four sides of the rectangle.',
  '',
  'For a rectangle, perimeter = 2 x (length + width). The perimeter of a rectangle is measured in units of length such as centimetres.',
  '',
  'A common mistake is to multiply the length and width of a rectangle. That gives the area of the rectangle, not its perimeter.',
].join('\n');

describe('learning AI (e2e)', () => {
  const fake = new FakeAiProvider();
  let t: TestApp;
  let tenant: TenantFixture;
  let admin: Session;
  let student: Session;
  let other: Session;
  let syllabus: { trackId: string; subjectId: string; chapterId: string; topicId: string; subtopicId: string; emptySubtopicId: string };
  let theoryBlockIds: string[];

  const http = () => t.http();

  beforeAll(async () => {
    t = await createTestApp({}, [{ token: AI_PRIMARY_PROVIDER, value: fake }]);
    tenant = await createTenant();
    await createEngineConfig(tenant);
    const [a, s, o] = await Promise.all([createUser(tenant, 'ADMIN'), createUser(tenant, 'STUDENT'), createUser(tenant, 'STUDENT')]);
    [admin, student, other] = await Promise.all([login(t, a, tenant.slug), login(t, s, tenant.slug), login(t, o, tenant.slug)]);
    syllabus = await schoolSyllabus(tenant);
    theoryBlockIds = await ingestAndPublish();
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  beforeEach(() => fake.reset());

  // ---------------------------------------------------------------- content pipeline (Feature 5)

  /** Class 5 › Mathematics › Measurement › Perimeter and Area › Perimeter of a Rectangle, plus an empty sibling. */
  async function schoolSyllabus(tn: TenantFixture) {
    const one = async (sql: string, params: unknown[]) => (await db().query<{ id: string }>(sql, params)).rows[0]!.id;
    const trackId = await one(
      `INSERT INTO tracks (tenant_id, slug, name, kind, education_stage, grade_label, grade_ordinal, status)
       VALUES ($1, $2, 'Class 5', 'school', 'school', 'Class 5', 5, 'published') RETURNING id`,
      [tn.id, uniq('class-5')],
    );
    const subjectId = await one(`INSERT INTO subjects (tenant_id, track_id, slug, name, status) VALUES ($1, $2, $3, 'Mathematics', 'published') RETURNING id`, [tn.id, trackId, uniq('maths')]);
    const chapterId = await one(`INSERT INTO chapters (tenant_id, subject_id, slug, name, status) VALUES ($1, $2, $3, 'Measurement', 'published') RETURNING id`, [tn.id, subjectId, uniq('measure')]);
    const topicId = await one(`INSERT INTO topics (tenant_id, chapter_id, slug, name, status) VALUES ($1, $2, $3, 'Perimeter and Area', 'published') RETURNING id`, [tn.id, chapterId, uniq('pa')]);
    const subtopicId = await one(
      `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Perimeter of a Rectangle', 'published') RETURNING id`,
      [tn.id, topicId, uniq('perimeter')],
    );
    const emptySubtopicId = await one(
      `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Volume of a Cuboid', 'published') RETURNING id`,
      [tn.id, topicId, uniq('volume')],
    );
    return { trackId, subjectId, chapterId, topicId, subtopicId, emptySubtopicId };
  }

  /** Upload → extraction → segmentation → classification → mapping → review → publish, through the admin API. */
  async function ingestAndPublish(): Promise<string[]> {
    const created = await http()
      .post(`/v1/admin/ingestion/assets?trackId=${syllabus.trackId}&subjectId=${syllabus.subjectId}`)
      .set(...bearer(admin))
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', 'class-5-perimeter.pdf')
      .send(makePdf({ pages: [TEXTBOOK_PAGE], compress: true }));
    expect(created.status).toBe(201);
    await t.app.get<JobQueue>(JOB_QUEUE).drain();

    const blocks = await http().get(`/v1/admin/ingestion/jobs/${created.body.jobId}/blocks`).set(...bearer(admin));
    expect(blocks.status).toBe(200);
    const theory = (blocks.body as Json[]).filter((b) => b.kind === 'theory');
    expect(theory.length).toBeGreaterThan(0);
    // Mapping chose the existing school sub-topic by its own wording.
    expect(theory.some((b) => b.subtopicId === syllabus.subtopicId)).toBe(true);

    const published: string[] = [];
    for (const block of theory) {
      if (block.subtopicId !== syllabus.subtopicId) {
        expect((await http().patch(`/v1/admin/ingestion/blocks/${block.id}`).set(...bearer(admin)).send({ subtopicId: syllabus.subtopicId })).status).toBe(200);
      }
      expect((await http().post(`/v1/admin/ingestion/blocks/${block.id}/approve`).set(...bearer(admin)).send({})).status).toBe(200);
      const res = await http().post(`/v1/admin/ingestion/blocks/${block.id}/publish`).set(...bearer(admin)).send({});
      expect(res.status).toBe(200);
      published.push(block.id as string);
    }
    return published;
  }

  it('A. content uploaded as a PDF reaches students as published theory on the school track', async () => {
    const res = await http().get(`/v1/subtopics/${syllabus.subtopicId}/theory`).set(...bearer(student));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/total distance around its boundary/);
    const track = await http().get(`/v1/tracks/${syllabus.trackId}/tree`).set(...bearer(student));
    expect(track.status).toBe(200);
    expect(JSON.stringify(track.body)).toContain('Perimeter of a Rectangle');
  });

  // ---------------------------------------------------------------- revision notes (Feature 1)

  const notesReply = (patch: Json = {}) => ({
    title: 'Perimeter of a rectangle',
    overview: 'The perimeter of a rectangle is the total distance around its boundary, found by adding all four sides.',
    keyPoints: [{ text: 'The perimeter of a rectangle is the total distance around its boundary.', sourceBlockIds: theoryBlockIds }],
    concepts: [{ term: 'Perimeter', explanation: 'The total distance around the boundary of a rectangle.', sourceBlockIds: theoryBlockIds }],
    formulas: [{ expression: 'perimeter = 2 x (length + width)', meaning: 'Perimeter of a rectangle', sourceBlockIds: theoryBlockIds }],
    commonMistakes: [{ text: 'Multiplying the length and width gives the area, not the perimeter.', sourceBlockIds: theoryBlockIds }],
    quickRevision: [{ text: 'Add all four sides of the rectangle.', sourceBlockIds: theoryBlockIds }],
    ...patch,
  });
  const notes = (s: Session, level: string, id: string) => http().post('/v1/revision-notes').set(...bearer(s)).send({ level, id });

  describe('revision notes', () => {
    it('B1. writes notes grounded in the published source, each item citing it, and caches them', async () => {
      fake.replyStructured('revision_notes', notesReply());
      const first = await notes(student, 'subtopic', syllabus.subtopicId);
      expect(first.status).toBe(200);
      expect(first.body.state).toBe('ready');
      expect(first.body.cached).toBe(false);
      expect(first.body.notes.formulas[0].expression).toBe('perimeter = 2 x (length + width)');
      for (const item of first.body.notes.keyPoints) expect(theoryBlockIds).toEqual(expect.arrayContaining(item.sourceBlockIds));
      // The prompt carried the published blocks, never more than the scope.
      expect(fake.structuredCallsFor('revision_notes')[0]!.prompt).toMatch(/total distance around its boundary/);

      const second = await notes(other, 'subtopic', syllabus.subtopicId);
      expect(second.body.cached).toBe(true);
      expect(fake.structuredCallsFor('revision_notes')).toHaveLength(1);

      const read = await http().get('/v1/revision-notes').query({ level: 'subtopic', id: syllabus.subtopicId }).set(...bearer(student));
      expect(read.body.state).toBe('ready');
    });

    it('B2. drops a formula the notes never state', async () => {
      await db().query(`UPDATE revision_notes SET status = 'superseded' WHERE tenant_id = $1`, [tenant.id]);
      fake.replyStructured('revision_notes', notesReply({ formulas: [{ expression: 'diagonal = sqrt(length^2 + width^2)', meaning: 'Diagonal', sourceBlockIds: theoryBlockIds }] }));
      const res = await notes(student, 'topic', syllabus.topicId);
      expect(res.status).toBe(200);
      expect(res.body.notes.formulas).toEqual([]);
    });

    it('B3. regenerates when the source content changes', async () => {
      fake.replyStructured('revision_notes', notesReply());
      await notes(student, 'chapter', syllabus.chapterId);
      await db().query(`UPDATE content_blocks SET content_hash = md5(random()::text) || md5(random()::text) WHERE id = $1`, [theoryBlockIds[0]]);
      const stale = await http().get('/v1/revision-notes').query({ level: 'chapter', id: syllabus.chapterId }).set(...bearer(student));
      expect(stale.body.state).toBe('outdated');
      const again = await notes(student, 'chapter', syllabus.chapterId);
      expect(again.body.cached).toBe(false);
      expect(fake.structuredCallsFor('revision_notes')).toHaveLength(2);
    });

    it('B4. refuses a scope with no published source, and never invents notes', async () => {
      const res = await notes(student, 'subtopic', syllabus.emptySubtopicId);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('NO_SOURCE_CONTENT');
      expect(fake.structuredCallsFor('revision_notes')).toHaveLength(0);
    });

    it('B5. rejects ungrounded notes, stores why, and does not retry immediately', async () => {
      await db().query(`UPDATE revision_notes SET status = 'superseded' WHERE tenant_id = $1 AND scope_level = 'track'`, [tenant.id]);
      fake.replyStructured('revision_notes', notesReply({ keyPoints: [{ text: 'Photosynthesis happens in chloroplasts.', sourceBlockIds: ['99999999-9999-4999-8999-999999999999'] }], concepts: [] }));
      const res = await notes(student, 'track', syllabus.trackId);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('AI_OUTPUT_REJECTED');
      const { rows } = await db().query(`SELECT status FROM revision_notes WHERE tenant_id = $1 AND scope_level = 'track'`, [tenant.id]);
      expect(rows.map((r) => r.status)).toContain('rejected');
      expect((await notes(student, 'track', syllabus.trackId)).status).toBe(422);
      expect(fake.structuredCallsFor('revision_notes')).toHaveLength(1);
    });

    it('B6. is invisible across organisations', async () => {
      const elsewhere = await createTenant();
      const outsider = await login(t, await createUser(elsewhere, 'STUDENT'), elsewhere.slug);
      expect((await notes(outsider, 'subtopic', syllabus.subtopicId)).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------- question generation (Feature 2) + adaptive practice

  const questionReply = (patch: Json = {}) => ({
    type: 'single_correct',
    stem: 'A rectangle has a length of 9 centimetres and a width of 4 centimetres. What is the total distance around its boundary?',
    options: [
      { key: 'A', text: '13 centimetres', isCorrect: false },
      { key: 'B', text: '26 centimetres', isCorrect: true },
      { key: 'C', text: '36 centimetres', isCorrect: false },
      { key: 'D', text: '22 centimetres', isCorrect: false },
    ],
    numericAnswer: null,
    hints: ['Add the lengths of all four sides of the rectangle.'],
    expectedTimeSeconds: 60,
    solution: {
      summary: 'The perimeter of a rectangle is the total distance around its boundary: 2 x (length + width).',
      steps: ['Add the length and width: 9 + 4 = 13 centimetres.', 'Multiply by 2 for all four sides: 2 x 13 = 26 centimetres.'],
      finalAnswer: { optionKeys: ['B'] },
    },
    sourceBlockIds: theoryBlockIds,
    ...patch,
  });
  const generate = (s: Session, body: Json = {}) => http().post('/v1/practice/generated-questions').set(...bearer(s)).send({ subtopicId: syllabus.subtopicId, ...body });

  describe('question generation with the adaptive engine', () => {
    let generatedId: string;

    it('C1. generates a validated question at the engine’s target level, with provenance and no answer in the response', async () => {
      fake.replyStructured('question_generation', questionReply());
      const res = await generate(student);
      expect(res.status).toBe(201);

      const params = parseEngineParams(engineParamsJson());
      if (!params.ok) throw new Error('fixture params invalid');
      const expectedLevel = levelForTheta(targetDifficulty(coldStartTheta(params.value, null), params.value), params.value);
      expect(res.body.targetLevel).toBe(expectedLevel);
      expect(res.body.generated).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toMatch(/isCorrect|correctNumeric|finalAnswer|26 centimetres/);
      generatedId = res.body.generated[0].questionId;

      const { rows } = await db().query(
        `SELECT q.status, q.difficulty_label, q.difficulty_b, g.provider, g.prompt_version, g.source_block_ids, g.target_level
           FROM questions q JOIN generated_questions g ON g.question_id = q.id WHERE q.id = $1`,
        [generatedId],
      );
      expect(rows[0]).toMatchObject({ status: 'published', difficulty_label: expectedLevel, target_level: expectedLevel, provider: 'gemini' });
      expect(Number(rows[0].difficulty_b)).toBe((engineParamsJson().initial_b_by_level as Record<string, number>)[String(expectedLevel)]);
      expect(rows[0].source_block_ids.length).toBeGreaterThan(0);
      expect(await auditActions(tenant.id, generatedId)).toContain('question.generated');
    });

    it('C2. the engine serves it, the attempt is graded by the existing API, and mastery moves', async () => {
      const session = await http().post('/v1/practice/sessions').set(...bearer(student)).send({ subtopicId: syllabus.subtopicId });
      expect(session.status).toBe(201);
      const next = await http().get(`/v1/practice/sessions/${session.body.session.id}/next`).set(...bearer(student));
      expect(next.status).toBe(200);
      expect(next.body.question.id).toBe(generatedId);
      expect(JSON.stringify(next.body.question)).not.toMatch(/isCorrect/);

      await ageServedItem(next.body.item.id as string, 45_000);
      const attempt = await http()
        .post('/v1/practice/attempts')
        .set(...bearer(student))
        .set('Idempotency-Key', uniq('gen-attempt'))
        .send({ sessionItemId: next.body.item.id, response: { optionKeys: ['B'] }, totalTimeMs: 45_000 });
      expect(attempt.status).toBe(201);
      expect(attempt.body).toMatchObject({ outcome: 'correct', correct: true });
      const { rows } = await db().query(`SELECT attempts_count FROM ability_scores WHERE tenant_id = $1 AND subtopic_id = $2`, [tenant.id, syllabus.subtopicId]);
      expect(Number(rows[0].attempts_count)).toBe(1);
    });

    it('C3. discards a question that leaks its answer, a near-duplicate, and a self-contradicting one', async () => {
      fake.replyStructured(
        'question_generation',
        questionReply({ hints: ['The answer is 26 centimetres.'], stem: 'A garden rectangle is 9 centimetres long and 4 centimetres wide; find the distance around its boundary.' }),
        questionReply(), // the stem already in the bank
        questionReply({ stem: 'A card rectangle is 12 centimetres by 5 centimetres. What is the total distance around its boundary?', solution: { ...questionReply().solution, finalAnswer: { optionKeys: ['C'] } } }),
      );
      const res = await generate(student);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('AI_OUTPUT_REJECTED');
      const { rows } = await db().query(`SELECT validation FROM generated_questions WHERE tenant_id = $1 AND status = 'rejected' ORDER BY created_at DESC LIMIT 3`, [tenant.id]);
      const failed = rows.flatMap((r) => (r.validation.failures as { check: string }[]).map((f) => f.check));
      expect(failed).toEqual(expect.arrayContaining(['answer_leak', 'duplicate', 'self_consistency']));
      const { rows: count } = await db().query(`SELECT count(*)::int AS n FROM questions WHERE tenant_id = $1`, [tenant.id]);
      expect(count[0].n).toBe(1);
    });

    it('C4. malformed provider output fails cleanly and practice continues', async () => {
      fake.replyStructured('question_generation', 'this is not JSON at all');
      const res = await generate(student);
      expect(res.status).toBe(503);
      const session = await http().post('/v1/practice/sessions').set(...bearer(other)).send({ subtopicId: syllabus.subtopicId });
      expect((await http().get(`/v1/practice/sessions/${session.body.session.id}/next`).set(...bearer(other))).status).toBe(200);
    });

    it('C5. a sub-topic with no notes of its own builds on its topic’s notes; with none anywhere it refuses', async () => {
      fake.replyStructured('question_generation', questionReply({ stem: 'A photo frame is a rectangle 10 centimetres long and 6 centimetres wide. What is the total distance around its boundary?' }));
      const widened = await generate(student, { subtopicId: syllabus.emptySubtopicId });
      expect(widened.status).toBe(201);
      expect(fake.structuredCallsFor('question_generation')[0]!.prompt).toMatch(/total distance around its boundary/);

      const { rows } = await db().query<{ id: string }>(
        `INSERT INTO topics (tenant_id, chapter_id, slug, name, status) VALUES ($1, $2, $3, 'Time', 'published') RETURNING id`,
        [tenant.id, syllabus.chapterId, uniq('time')],
      );
      const bare = await db().query<{ id: string }>(
        `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Reading a Clock', 'published') RETURNING id`,
        [tenant.id, rows[0]!.id, uniq('clock')],
      );
      const refused = await generate(student, { subtopicId: bare.rows[0]!.id });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('NO_SOURCE_CONTENT');

      const elsewhere = await createTenant();
      const outsider = await login(t, await createUser(elsewhere, 'STUDENT'), elsewhere.slug);
      expect((await generate(outsider)).status).toBe(404);
    });

    // ---------------------------------------------------------------- tutor (Feature 3)

    describe('the AI tutor', () => {
      const tutorReply = (reply: string, extra: Json = {}) => ({ onTopic: true, reply, steps: [], citedBlockIds: theoryBlockIds.slice(0, 1), ...extra });
      const start = (s: Session, questionId?: string) => http().post('/v1/tutor/conversations').set(...bearer(s)).send({ subtopicId: syllabus.subtopicId, ...(questionId ? { questionId } : {}) });
      const ask = (s: Session, id: string, message: string, intent?: string) =>
        http().post(`/v1/tutor/conversations/${id}/messages`).set(...bearer(s)).send({ message, ...(intent ? { intent } : {}) });

      it('D1. before an answer, a hint that gives the answer away is regenerated, then replaced by a safe hint', async () => {
        const convo = await start(other, generatedId);
        expect(convo.status).toBe(201);
        expect(convo.body.answered).toBe(false);
        fake.replyStructured('tutor', tutorReply('The answer is option B, 26 centimetres.'), tutorReply('It comes to 26 centimetres.'));
        const res = await ask(other, convo.body.id, 'Can you help me?', 'hint');
        expect(res.status).toBe(201);
        expect(res.body.tutor.body).not.toMatch(/26|option B/);
        expect(res.body.tutor.body).toMatch(/hint|notes/i);
        expect(fake.structuredCallsFor('tutor')).toHaveLength(2);
        // The model was never shown the answer.
        for (const call of fake.structuredCallsFor('tutor')) expect(call.prompt).not.toContain('CORRECT ANSWER');
      });

      it('D2. a clean hint is served, and a follow-up carries the conversation', async () => {
        const convo = await start(other, generatedId);
        fake.replyStructured('tutor', tutorReply('Think about how many sides a rectangle has, and add them all.'), tutorReply('Step one means adding length and width first.'));
        const first = await ask(other, convo.body.id, 'Give me a hint', 'hint');
        expect(first.body.tutor.body).toMatch(/sides/);
        expect(first.body.tutor.grounded).toBe(true);
        await ask(other, convo.body.id, 'Explain step one', 'explain_step');
        expect(fake.structuredCallsFor('tutor')[1]!.prompt).toMatch(/Tutor: Think about how many sides/);
        const again = await http().get(`/v1/tutor/conversations/${convo.body.id}`).set(...bearer(other));
        expect(again.body.messages.length).toBeGreaterThanOrEqual(4);
      });

      it('D3. after the student has answered, "why is my answer wrong" uses their attempt and the key', async () => {
        const convo = await start(student, generatedId);
        expect(convo.body.answered).toBe(true);
        fake.replyStructured('tutor', tutorReply('You chose B, which is right: 2 x (9 + 4) = 26 centimetres.'));
        const res = await ask(student, convo.body.id, 'Why is my answer right or wrong?', 'why_wrong');
        expect(res.status).toBe(201);
        const prompt = fake.structuredCallsFor('tutor')[0]!.prompt;
        expect(prompt).toContain('THE STUDENT ANSWERED: B (26 centimetres) — marked correct');
        expect(prompt).toContain('CORRECT ANSWER: B (26 centimetres)');
      });

      it('D4. stays on topic and answers "why wrong" before an attempt without calling the model', async () => {
        const convo = await start(other, generatedId);
        const early = await ask(other, convo.body.id, 'Why is my answer wrong?', 'why_wrong');
        expect(early.body.tutor.body).toMatch(/Submit your answer first/);
        fake.replyStructured('tutor', { onTopic: false, reply: '', steps: [], citedBlockIds: [] });
        const off = await ask(other, convo.body.id, 'Write me a poem about football');
        expect(off.body.tutor.body).toMatch(/I can only help with Perimeter of a Rectangle/);
        expect(fake.structuredCallsFor('tutor')).toHaveLength(1);
      });

      it('D5. keeps conversations private to the student', async () => {
        const convo = await start(student);
        expect((await http().get(`/v1/tutor/conversations/${convo.body.id}`).set(...bearer(other))).status).toBe(404);
        expect((await ask(other, convo.body.id, 'hello')).status).toBe(404);
      });

      it('D6. reports an unavailable provider as a service error, not a crash', async () => {
        const convo = await start(student);
        fake.replyStructured('tutor', new AiProviderError('gemini', 'unavailable', 'down'));
        const res = await ask(student, convo.body.id, 'Explain perimeter simply', 'simplify');
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('AI_PROVIDER_UNAVAILABLE');
      });
    });

    // ---------------------------------------------------------------- visual explanation (Feature 4)

    describe('explain visually', () => {
      const diagram = (patch: Json = {}) => ({
        concept: 'Perimeter is the distance around a shape',
        useful: true,
        reason: 'Seeing all four sides laid out shows why every side must be added.',
        format: 'diagram',
        mustNotShow: ['the total distance'],
        title: 'A 9 cm by 4 cm rectangle',
        caption: 'Two sides are 9 centimetres and two are 4 centimetres.',
        imagePrompt: null,
        scene: {
          width: 400,
          height: 260,
          elements: [
            { id: 'rect', kind: 'rect', x: 60, y: 60, w: 280, h: 120 },
            { id: 'top', kind: 'text', x: 200, y: 50, text: '9 cm', anchor: 'middle' },
            { id: 'side', kind: 'text', x: 350, y: 125, text: '4 cm' },
          ],
        },
        ...patch,
      });
      const visual = (s: Session, id = generatedId) => http().post(`/v1/questions/${id}/visual`).set(...bearer(s)).send({});

      it('E1. chooses a format, validates the scene, and caches it per question version', async () => {
        fake.replyStructured('visual', diagram());
        const first = await visual(other);
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ visualType: 'diagram', cached: false, imageUrl: null });
        expect(first.body.scene.elements).toHaveLength(3);
        // The model sees the question and its options, as the student does — never which option is correct.
        const prompt = fake.structuredCallsFor('visual')[0]!.prompt;
        expect(prompt).toContain('B. 26 centimetres');
        expect(prompt).not.toMatch(/correct (?:answer|option)\s*[:=]|isCorrect|CORRECT ANSWER/i);
        const second = await visual(student);
        expect(second.body.cached).toBe(true);
        expect(fake.structuredCallsFor('visual')).toHaveLength(1);
      });

      it('E2. refuses a visual that labels the answer, after one corrective retry, and practice is unaffected', async () => {
        await db().query(`UPDATE visual_explanations SET status = 'superseded' WHERE tenant_id = $1`, [tenant.id]);
        const leaky = diagram({ scene: { ...diagram().scene, elements: [...diagram().scene.elements, { id: 'total', kind: 'text', x: 200, y: 230, text: 'Total = 26 cm' }] } });
        fake.replyStructured('visual', leaky, leaky);
        const res = await visual(other);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('AI_OUTPUT_REJECTED');
        expect(fake.structuredCallsFor('visual')).toHaveLength(2);
        expect(fake.structuredCallsFor('visual')[1]!.prompt).toMatch(/PREVIOUS DRAFT WAS REJECTED/);
        const q = await http().get(`/v1/questions/${generatedId}/explanation`).set(...bearer(other));
        expect(q.status).not.toBe(500);
      });

      it('E3. caches "a picture would not help" as a real outcome', async () => {
        await db().query(`DELETE FROM visual_explanations WHERE tenant_id = $1`, [tenant.id]);
        fake.replyStructured('visual', diagram({ useful: false, format: 'none', reason: 'This is a single addition; a picture adds nothing.', scene: null }));
        const res = await visual(other);
        expect(res.body).toMatchObject({ visualType: 'none', scene: null });
        expect((await visual(other)).body.cached).toBe(true);
      });

      it('E4. stores a generated image through object storage when an image model is configured', async () => {
        await db().query(`DELETE FROM visual_explanations WHERE tenant_id = $1`, [tenant.id]);
        fake.imageModel = 'fake-image-1';
        fake.replyStructured('visual', diagram({ format: 'image', imagePrompt: 'A plain rectangle labelled 9 cm and 4 cm on its sides' }));
        const res = await visual(other);
        expect(res.status).toBe(200);
        expect(res.body.visualType).toBe('image');
        expect(res.body.imageUrl).toMatch(/^\/v1\/visuals\/.+\/image$/);
        // What reached the image model: the analysed prompt plus the no-text rule, never the answer key.
        expect(fake.imageCalls).toHaveLength(1);
        expect(fake.imageCalls[0]).toMatch(/^A plain rectangle labelled 9 cm and 4 cm on its sides/);
        expect(fake.imageCalls[0]).toMatch(/Do not include any text, letters, numbers, labels, equations/);
        expect(fake.imageCalls[0]).not.toMatch(/26/);
        const { rows } = await db().query(`SELECT kind, mime_type, storage_key FROM content_assets WHERE tenant_id = $1 AND kind = 'generated_visual'`, [tenant.id]);
        expect(rows).toHaveLength(1);
        expect(await t.app.get<MemoryObjectStorage>(OBJECT_STORAGE).head(rows[0].storage_key)).toMatchObject({ contentType: 'image/png' });
        const image = await http().get(res.body.imageUrl).set(...bearer(other));
        expect(image.status).toBe(200);
        expect(image.headers['content-type']).toMatch(/image\/png/);
      });

      it('E5. without an image model, an image request falls back to the drawn scene', async () => {
        await db().query(`DELETE FROM visual_explanations WHERE tenant_id = $1`, [tenant.id]);
        fake.replyStructured('visual', diagram({ format: 'image', imagePrompt: 'A rectangle' }));
        const res = await visual(other);
        expect(res.body.visualType).toBe('illustration');
        expect(res.body.scene).not.toBeNull();
      });

      it('E6. nothing visual is generated until the student asks for it', async () => {
        const { rows } = await db().query<{ question_id: string }>(
          `SELECT question_id FROM generated_questions WHERE tenant_id = $1 AND subtopic_id = $2 AND status = 'published' LIMIT 1`,
          [tenant.id, syllabus.emptySubtopicId],
        );
        const questionId = rows[0]!.question_id;
        const learner = await login(t, await createUser(tenant, 'STUDENT'), tenant.slug);
        const session = await http().post('/v1/practice/sessions').set(...bearer(learner)).send({ subtopicId: syllabus.emptySubtopicId });
        const served = await http().get(`/v1/practice/sessions/${session.body.session.id}/next`).set(...bearer(learner));
        expect(served.body.question.id).toBe(questionId);
        const count = async () => (await db().query(`SELECT count(*)::int AS n FROM visual_explanations WHERE question_id = $1`, [questionId])).rows[0].n as number;
        expect(await count()).toBe(0);
        expect(fake.structuredCallsFor('visual')).toHaveLength(0);

        fake.replyStructured('visual', diagram());
        expect((await visual(learner, questionId)).status).toBe(200);
        expect(await count()).toBe(1);
      });

      it('E7. accepts the modality the analysis chooses — graph, step-by-step and animation — and stores a render-ready scene', async () => {
        const graph = diagram({
          format: 'graph',
          title: 'Perimeter as the length grows',
          scene: {
            width: 420,
            height: 300,
            elements: [
              { id: 'ax', kind: 'axes', x: 50, y: 20, w: 330, h: 230, xMin: 0, xMax: 10, yMin: 0, yMax: 30, xLabel: 'length (cm)', yLabel: 'perimeter (cm)' },
              { id: 'p', kind: 'plot', axesId: 'ax', fn: '2*(x + 4)' },
            ],
          },
        });
        const steps = diagram({
          format: 'step_by_step',
          scene: {
            ...diagram().scene,
            steps: [
              { caption: 'Start with the rectangle.', show: ['rect'] },
              { caption: 'Mark the two long sides.', show: ['rect', 'top'] },
              { caption: 'Mark the two short sides.', show: ['rect', 'top', 'side'] },
            ],
          },
        });
        const animation = diagram({
          format: 'animation',
          scene: {
            ...diagram().scene,
            elements: [...diagram().scene.elements, { id: 'ant', kind: 'circle', cx: 60, cy: 60, r: 6, fill: true }, { id: 'walk', kind: 'motion', targetId: 'ant', path: [[60, 60], [340, 60], [340, 180], [60, 180], [60, 60]], durationMs: 4000 }],
            steps: [
              { caption: 'An ant starts at a corner.', show: ['rect', 'ant'] },
              { caption: 'It walks along every side once.', show: ['rect', 'ant', 'top', 'side'] },
            ],
            loop: true,
          },
        });
        for (const [reply, type] of [[graph, 'graph'], [steps, 'step_by_step'], [animation, 'animation']] as const) {
          await db().query(`DELETE FROM visual_explanations WHERE tenant_id = $1`, [tenant.id]);
          fake.replyStructured('visual', reply);
          const res = await visual(other);
          expect([type, res.status, res.body.visualType]).toEqual([type, 200, type]);
          if (type === 'graph') {
            const plot = (res.body.scene.elements as Json[]).find((e) => e.kind === 'plot')!;
            // The formula was evaluated on the server into points; the browser only draws numbers.
            expect(plot.segments[0].length).toBeGreaterThan(50);
            expect(plot.segments[0][0]).toEqual([0, 8]);
          }
          if (type === 'step_by_step') expect(res.body.scene.steps).toHaveLength(3);
          if (type === 'animation') expect((res.body.scene.elements as Json[]).some((e) => e.kind === 'motion')).toBe(true);
        }
      });
    });

    // ---------------------------------------------------------------- the tutor after a wrong answer

    it('H. after a wrong answer: why it is wrong, then simpler words, then another example — in one conversation', async () => {
      const learner = await login(t, await createUser(tenant, 'STUDENT'), tenant.slug);
      const session = await http().post('/v1/practice/sessions').set(...bearer(learner)).send({ subtopicId: syllabus.subtopicId });
      // Whichever question the engine chooses: selection is the engine's, not the test's.
      const served = await http().get(`/v1/practice/sessions/${session.body.session.id}/next`).set(...bearer(learner));
      const questionId = served.body.question.id as string;
      const { rows: options } = await db().query<{ option_key: string; body: string; is_correct: boolean }>(
        `SELECT option_key, body, is_correct FROM question_options WHERE question_id = $1 AND side = 'single' ORDER BY sort_order`,
        [questionId],
      );
      const wrongOption = options.find((o) => !o.is_correct)!;
      const rightOption = options.find((o) => o.is_correct)!;
      await ageServedItem(served.body.item.id as string, 40_000);
      const wrong = await http()
        .post('/v1/practice/attempts')
        .set(...bearer(learner))
        .set('Idempotency-Key', uniq('wrong'))
        .send({ sessionItemId: served.body.item.id, response: { optionKeys: [wrongOption.option_key] }, totalTimeMs: 40_000 });
      expect(wrong.body).toMatchObject({ outcome: 'incorrect', correct: false });

      const convo = await http().post('/v1/tutor/conversations').set(...bearer(learner)).send({ subtopicId: syllabus.subtopicId, questionId });
      expect(convo.body.answered).toBe(true);
      const ask = (message: string, intent: string) => http().post(`/v1/tutor/conversations/${convo.body.id}/messages`).set(...bearer(learner)).send({ message, intent });
      const tutorReply = (reply: string) => ({ onTopic: true, reply, steps: [], citedBlockIds: theoryBlockIds.slice(0, 1) });

      fake.replyStructured('tutor', tutorReply('13 centimetres adds only one length and one width; the boundary has four sides.'));
      expect((await ask('Why is my answer wrong?', 'why_wrong')).status).toBe(201);
      const why = fake.structuredCallsFor('tutor')[0]!.prompt;
      expect(why).toContain(`THE STUDENT ANSWERED: ${wrongOption.option_key} (${wrongOption.body}) — marked incorrect`);
      expect(why).toContain(`CORRECT ANSWER: ${rightOption.option_key} (${rightOption.body})`);

      fake.replyStructured('tutor', tutorReply('Think of walking all the way round the edge: you pass each side once.'));
      expect((await ask('Explain that more simply.', 'simplify')).status).toBe(201);
      const simpler = fake.structuredCallsFor('tutor')[1]!.prompt;
      expect(simpler).toContain('Tutor: 13 centimetres adds only one length and one width');
      expect(simpler).toMatch(/simpler words/);

      fake.replyStructured('tutor', tutorReply('A 5 by 2 rectangle: 5 + 2 + 5 + 2 = 14.'));
      expect((await ask('Give me another example.', 'another_example')).status).toBe(201);
      const example = fake.structuredCallsFor('tutor')[2]!.prompt;
      expect(example).toMatch(/different, short worked example/);
      expect(example).toContain('Student: Explain that more simply.');
      expect(example).toContain(`SUB-TOPIC: Mathematics › Measurement › Perimeter and Area › Perimeter of a Rectangle`);
    });

    // ---------------------------------------------------------------- provider fallback, end to end

    it('F. when the primary provider is out of quota, the fallback writes the question, and provenance says so', async () => {
      const failing = new FakeAiProvider('gemini', 'fake-gemini-1');
      failing.replyStructured('question_generation', new AiProviderError('gemini', 'unavailable', 'Gemini returned 429', 429));
      const backup = new FakeAiProvider('claude', 'fake-claude-1', null);
      backup.replyStructured(
        'question_generation',
        questionReply({
          stem: 'Find the perimeter of a rectangle whose length is 11 centimetres and whose width is 2 centimetres.',
          solution: {
            summary: 'The perimeter of a rectangle is the total distance around its boundary: 2 x (length + width).',
            steps: ['Add the length and width: 11 + 2 = 13 centimetres.', 'Multiply by 2 for all four sides: 2 x 13 = 26 centimetres.'],
            finalAnswer: { optionKeys: ['B'] },
          },
        }),
      );
      const withFallback = await createTestApp({}, [
        { token: AI_PRIMARY_PROVIDER, value: failing },
        { token: AI_FALLBACK_PROVIDER, value: backup },
      ]);
      try {
        const res = await withFallback.http().post('/v1/practice/generated-questions').set(...bearer(student)).send({ subtopicId: syllabus.subtopicId });
        expect(res.status).toBe(201);
        expect(JSON.stringify(res.body)).not.toMatch(/isCorrect|finalAnswer|solution|validation|gemini|claude/i);
        expect(failing.structuredCallsFor('question_generation')).toHaveLength(1);
        expect(backup.structuredCallsFor('question_generation')).toHaveLength(1);
        const { rows } = await db().query(`SELECT provider, model, status FROM generated_questions WHERE question_id = $1`, [res.body.generated[0].questionId]);
        expect(rows[0]).toEqual({ provider: 'claude', model: 'fake-claude-1', status: 'published' });
      } finally {
        await withFallback.close();
      }
    });

    it('F2. our own checks never trigger the fallback: a duplicate question or ungrounded notes are rejected, not retried elsewhere', async () => {
      const primary = new FakeAiProvider('gemini', 'fake-gemini-1');
      const backup = new FakeAiProvider('claude', 'fake-claude-1', null);
      // A question already in the bank (duplicate), and notes citing nothing real (ungrounded): both parse fine.
      primary.replyStructured('question_generation', questionReply());
      primary.replyStructured('revision_notes', notesReply({ keyPoints: [{ text: 'Photosynthesis happens in chloroplasts.', sourceBlockIds: ['99999999-9999-4999-8999-999999999999'] }], concepts: [] }));
      backup.replyStructured('question_generation', questionReply({ stem: 'This must never be asked for.' }));
      backup.replyStructured('revision_notes', notesReply());
      const app = await createTestApp({}, [
        { token: AI_PRIMARY_PROVIDER, value: primary },
        { token: AI_FALLBACK_PROVIDER, value: backup },
      ]);
      try {
        const q = await app.http().post('/v1/practice/generated-questions').set(...bearer(student)).send({ subtopicId: syllabus.subtopicId });
        expect(q.status).toBe(422);
        expect(q.body.error.code).toBe('AI_OUTPUT_REJECTED');
        const n = await app.http().post('/v1/revision-notes').set(...bearer(student)).send({ level: 'topic', id: syllabus.topicId });
        expect([n.status, n.body.error?.code]).toEqual([422, 'AI_OUTPUT_REJECTED']);
        expect(backup.structuredCalls).toHaveLength(0);
        const dup = await db().query(`SELECT validation FROM generated_questions WHERE tenant_id = $1 AND status = 'rejected' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
        expect((dup.rows[0].validation.failures as { check: string }[]).map((f) => f.check)).toContain('duplicate');
      } finally {
        await app.close();
      }
    });

    it('F3. when both providers fail, the student gets a generic error and nothing internal', async () => {
      const primary = new FakeAiProvider('gemini', 'fake-gemini-1');
      const backup = new FakeAiProvider('claude', 'fake-claude-1', null);
      primary.replyStructured('tutor', new AiProviderError('gemini', 'unavailable', 'Gemini returned 429 for key AIzaSy-secret-detail', 429));
      backup.replyStructured('tutor', new AiProviderError('claude', 'unavailable', 'Anthropic returned 529 overloaded sk-ant-secret-detail', 529));
      const app = await createTestApp({}, [
        { token: AI_PRIMARY_PROVIDER, value: primary },
        { token: AI_FALLBACK_PROVIDER, value: backup },
      ]);
      try {
        const convo = await app.http().post('/v1/tutor/conversations').set(...bearer(student)).send({ subtopicId: syllabus.subtopicId });
        const res = await app.http().post(`/v1/tutor/conversations/${convo.body.id}/messages`).set(...bearer(student)).send({ message: 'Explain perimeter simply', intent: 'simplify' });
        expect(res.status).toBe(503);
        expect(Object.keys(res.body)).toEqual(['error']);
        expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message', 'requestId']);
        expect(res.body.error.code).toBe('AI_PROVIDER_UNAVAILABLE');
        const body = JSON.stringify(res.body);
        for (const secret of ['AIzaSy', 'sk-ant', 'secret-detail', '429', '529', 'gemini', 'claude', 'fake-', 'stack', 'SELECT', 'prompt', 'validation']) {
          expect([secret, body.toLowerCase().includes(secret.toLowerCase())]).toEqual([secret, false]);
        }
        expect(primary.structuredCalls).toHaveLength(1);
        expect(backup.structuredCalls).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });

  // ---------------------------------------------------------------- large sources: the multi-batch notes path

  describe('revision notes from a large source', () => {
    /** A published theory block of roughly `words` words, in its own sub-topic: test material, never product content. */
    const longBlock = (n: number, words: number) =>
      `Section ${n}. ` + Array.from({ length: words }, (_, i) => ['perimeter', 'rectangle', 'length', 'width', 'boundary', 'distance', 'sides', 'total'][(i + n) % 8]).join(' ') + '.';

    async function bigSubtopic(blocks: number, words: number): Promise<{ subtopicId: string; blockIds: string[] }> {
      const { rows } = await db().query<{ id: string }>(
        `INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Perimeter Practice Notes', 'published') RETURNING id`,
        [tenant.id, syllabus.topicId, uniq('big')],
      );
      const subtopicId = rows[0]!.id;
      const blockIds: string[] = [];
      for (let i = 0; i < blocks; i += 1) blockIds.push(await insertContentBlock(tenant, subtopicId, { title: `Part ${i + 1}`, text: longBlock(i, words), sortOrder: i }));
      return { subtopicId, blockIds };
    }

    it('G1. summarises each bounded part separately, then merges them, and still enforces grounding on the result', async () => {
      const { subtopicId, blockIds } = await bigSubtopic(4, 1500);
      const part = notesReply({ keyPoints: [{ text: 'The perimeter of a rectangle is the total distance around the boundary.', sourceBlockIds: blockIds }] });
      const merged = notesReply({
        keyPoints: [{ text: 'The perimeter of a rectangle is the total distance around its sides.', sourceBlockIds: blockIds.slice(0, 2) }],
        concepts: [{ term: 'Perimeter', explanation: 'The total distance around the boundary of a rectangle.', sourceBlockIds: [blockIds[0]] }],
        formulas: [{ expression: 'area = length x width', meaning: 'not in these notes', sourceBlockIds: [blockIds[0]] }],
        commonMistakes: [],
        quickRevision: [{ text: 'Add the length and width of every side.', sourceBlockIds: [blockIds[1]] }],
      });
      fake.replyStructured('revision_notes', part, part, part, part, part, merged);

      const res = await notes(student, 'subtopic', subtopicId);
      expect(res.status).toBe(200);
      const calls = fake.structuredCallsFor('revision_notes');
      const parts = calls.length - 1;
      expect(parts).toBeGreaterThanOrEqual(2);
      calls.slice(0, parts).forEach((c, i) => expect(c.prompt).toContain(`PART ${i + 1} of ${parts}`));
      expect(calls[parts]!.prompt).toContain('PARTIAL NOTES');
      // No part prompt carries the whole source: each is a bounded batch.
      for (const c of calls.slice(0, parts)) expect(c.prompt.length).toBeLessThan(blockIds.length * longBlock(0, 1500).length);
      // The merged result is validated against the real source: a formula the notes never state is dropped.
      expect(res.body.notes.formulas).toEqual([]);
      expect(res.body.notes.keyPoints).toHaveLength(1);
    });

    it('G2. refuses a scope too large for one bounded request rather than summarising part of it', async () => {
      const { subtopicId } = await bigSubtopic(16, 3500);
      const res = await notes(student, 'subtopic', subtopicId);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SCOPE_TOO_LARGE');
      expect(fake.structuredCallsFor('revision_notes')).toHaveLength(0);
    });
  });
});
