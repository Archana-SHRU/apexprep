import { AI_PRIMARY_PROVIDER, type StructuredRequest, type StructuredResult } from '../../src/ai/ai-provider';
import { JOB_QUEUE, type JobQueue } from '../../src/ingestion/job-queue';
import { QuestionsAdminService } from '../../src/questions/questions-admin.service';
import { makePdf } from '../fixtures/make-pdf';
import { FakeAiProvider } from './fake-ai';
import {
  bearer,
  closeDb,
  createEngineConfig,
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
  type UserFixture,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The prepared document and its single approval, end to end.
 *
 * A real PDF is uploaded over HTTP, the real pipeline prepares it, and everything after that goes through the real
 * API as an administrator: preview, bulk values, approve and publish. The model boundary is the one thing replaced
 * (`FakeAiProvider`), and it is replaced at the network edge only, so the real parsers, validators and grounding
 * checks run on what it returns.
 */

const THEORY_PAGE = [
  'Angular Momentum',
  '',
  'The angular momentum of a rigid body about a fixed axis is the product of its moment of inertia and its angular velocity.',
  'For a ring the moment of inertia about its axis is the mass times the square of the radius, so a heavier ring has more angular momentum.',
  'Angular momentum is conserved whenever the net external torque on the body is zero, which is why a spinning skater speeds up by pulling in her arms.',
  'When the skater pulls her arms in, her moment of inertia falls, and because the product of moment of inertia and angular velocity must stay constant, her angular velocity rises to compensate.',
  'The same reasoning explains why a diver tucks into a ball during a somersault: a smaller moment of inertia means a faster rotation, and stretching out again slows the rotation down.',
  'Torque is the rate at which angular momentum changes, so a net external torque is the only way to change the angular momentum of a body.',
].join('\n');

const QUESTIONS_PAGE = [
  '1. A ring of mass 2 kg and radius 0.5 m rolls without slipping at 1 rad/s. Find its angular momentum about the axis.',
  '(A) 0.25 kg m^2/s',
  '(B) 0.50 kg m^2/s',
  '(C) 0.75 kg m^2/s',
  '(D) 1.00 kg m^2/s',
  'Answer: B',
  'Difficulty: moderate',
  '',
  '2. A disc of moment of inertia 4 kg m^2 spins at 3 rad/s. Calculate its angular momentum in kg m^2/s.',
  'Answer: 12',
  'Difficulty: L2',
].join('\n');

const SOLUTIONS_PAGE = [
  'Solutions',
  '',
  'Solution 1. The angular momentum is the moment of inertia times the angular velocity, 0.50 kg m^2/s. Ans: B',
  '',
  'Solution 2. Angular momentum is inertia times angular velocity, 4 times 3 = 12. Ans: 12',
].join('\n');

/** The theory page with a line of its own, so each document is a distinct file (the same bytes are refused as a duplicate). */
const uniqueTheory = (): string => `${THEORY_PAGE}
Reference tag ${Math.random().toString(36).slice(2)}.`;

const STANDARD = (): Buffer => makePdf({ pages: [THEORY_PAGE, QUESTIONS_PAGE, SOLUTIONS_PAGE], compress: true });

// A question printed without its answer, whose solution comes later and states it.
const UNANSWERED_PAGE = [
  '3. A body of angular momentum 6 kg m^2/s has a moment of inertia of 2 kg m^2. What is its angular velocity in rad/s about the axis?',
  '(A) 1',
  '(B) 2',
  '(C) 3',
  '(D) 12',
  '',
  'Solution 3. Angular velocity is angular momentum divided by moment of inertia, 6 divided by 2 = 3 rad/s. Ans: C',
].join('\n');

// A question the rules cannot complete: no answer anywhere, so a model (when there is one) is asked.
const NO_ANSWER_PAGE = [
  '4. Which of these quantities about a spinning rigid body is conserved when no external torque acts on the body at all?',
  '(A) Angular momentum',
  '(B) Linear speed',
  '(C) Angular acceleration',
  '(D) Moment of inertia',
].join('\n');

interface Fixture {
  t: TestApp;
  tenant: TenantFixture;
  syllabus: SyllabusFixture;
  adminUser: UserFixture;
  admin: Session;
  student: Session;
  queue: JobQueue;
}

const AUTO = { ingestion: { auto_approval: { min_confidence: 0.75 } } };
const withAuto = (extra: Record<string, any> = {}): Record<string, unknown> => ({ ...AUTO, ...extra, ingestion: { ...AUTO.ingestion, ...(extra.ingestion ?? {}) } }); // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup(options: { params?: Record<string, unknown>; ai?: FakeAiProvider } = {}): Promise<Fixture> {
  const t = await createTestApp({}, options.ai ? [{ token: AI_PRIMARY_PROVIDER, value: options.ai }] : []);
  const tenant = await createTenant();
  const [adminUser, studentUser, syllabus] = await Promise.all([createUser(tenant, 'ADMIN'), createUser(tenant, 'STUDENT'), createSyllabus(tenant)]);
  await createEngineConfig(tenant, options.params ?? withAuto());
  const [admin, student] = await Promise.all([login(t, adminUser, tenant.slug), login(t, studentUser, tenant.slug)]);
  return { t, tenant, syllabus, adminUser, admin, student, queue: t.app.get<JobQueue>(JOB_QUEUE) };
}

const asAdmin = (f: Fixture) => bearer(f.admin);

async function ingest(f: Fixture, body: Buffer = STANDARD(), name = 'chapter.pdf'): Promise<string> {
  const created = await f.t.http().post('/v1/admin/ingestion/assets').set(...asAdmin(f)).set('Content-Type', 'application/pdf').set('X-Filename', name).send(body);
  expect(created.status).toBe(201);
  await f.queue.drain();
  return (created.body as Json).jobId as string;
}

const preview = async (f: Fixture, jobId: string): Promise<Json> => {
  const res = await f.t.http().get(`/v1/admin/ingestion/jobs/${jobId}/preview`).set(...asAdmin(f));
  expect(res.status).toBe(200);
  return res.body as Json;
};
const approve = (f: Fixture, jobId: string, body: Json = {}) => f.t.http().post(`/v1/admin/ingestion/jobs/${jobId}/approve`).set(...asAdmin(f)).send(body);
const defaults = (f: Fixture, jobId: string, body: Json) => f.t.http().post(`/v1/admin/ingestion/jobs/${jobId}/defaults`).set(...asAdmin(f)).send(body);
const kindOf = (blocks: Json[], kind: string): Json[] => blocks.filter((b) => b.kind === kind && !b.draft);
const draftsOf = (blocks: Json[]): Json[] => blocks.filter((b) => b.draft);
const count = async (sqlText: string, params: unknown[]): Promise<number> => Number((await db().query(sqlText, params)).rows[0].n);
const publishedQuestions = (f: Fixture) =>
  count(`SELECT count(*)::int AS n FROM questions WHERE tenant_id = $1 AND status = 'published' AND deleted_at IS NULL`, [f.tenant.id]);
const liveQuestions = (f: Fixture) => count(`SELECT count(*)::int AS n FROM questions WHERE tenant_id = $1 AND deleted_at IS NULL`, [f.tenant.id]);
const auditRows = async (f: Fixture, action: string, entityId?: string): Promise<Json[]> =>
  (await db().query(`SELECT actor_user_id, actor_role, entity_id, after FROM audit_log WHERE tenant_id = $1 AND action = $2 ${entityId ? 'AND entity_id = $3' : ''} ORDER BY occurred_at`, entityId ? [f.tenant.id, action, entityId] : [f.tenant.id, action])).rows as Json[];

// ---------------------------------------------------------------------------------------------------------------

describe('ingestion: the prepared document and its single approval', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f.t.close();
    await closeDb();
  });

  describe('nothing is published until the administrator approves', () => {
    it('leaves a confident document waiting: no question, no published block, no publication in the audit trail', async () => {
      const jobId = await ingest(f);
      const detail = await f.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...asAdmin(f));
      expect((detail.body as Json).job.status).toBe('awaiting_review');
      expect(await liveQuestions(f)).toBe(0);
      expect(await count(`SELECT count(*)::int AS n FROM content_blocks WHERE tenant_id = $1 AND status = 'published'`, [f.tenant.id])).toBe(0);
      expect(await auditRows(f, 'content_block.published')).toHaveLength(0);
    });

    it('records the pipeline\'s own work as the system, not as whoever uploaded the file', async () => {
      const jobId = await ingest(f, makePdf({ pages: [THEORY_PAGE, 'A different page so these bytes are this test\'s own.'] }));
      const processed = await auditRows(f, 'ingestion_job.processed', jobId);
      expect(processed).toHaveLength(1);
      expect(processed[0]).toMatchObject({ actor_role: 'SYSTEM', actor_user_id: null });
      const uploaded = await auditRows(f, 'content_asset.uploaded');
      expect(uploaded.every((r) => r.actor_user_id === f.adminUser.id && r.actor_role === 'ADMIN')).toBe(true);
    });

    it('is closed to students', async () => {
      const jobId = await ingest(f, makePdf({ pages: [THEORY_PAGE, QUESTIONS_PAGE, 'Yet another page, for this one test.'] }));
      for (const res of [
        await f.t.http().get(`/v1/admin/ingestion/jobs/${jobId}/preview`).set(...bearer(f.student)),
        await f.t.http().post(`/v1/admin/ingestion/jobs/${jobId}/approve`).set(...bearer(f.student)).send({}),
        await f.t.http().post(`/v1/admin/ingestion/jobs/${jobId}/defaults`).set(...bearer(f.student)).send({}),
      ]) {
        expect(res.status).toBe(403);
      }
    });
  });

  describe('the consolidated preview', () => {
    let jobId: string;
    let ctx: Fixture;

    beforeAll(async () => {
      ctx = await setup();
      jobId = await ingest(ctx);
    });
    afterAll(async () => {
      await ctx.t.close();
    });

    it('shows the whole document in reading order, with each block\'s origin, source page and readiness', async () => {
      const doc = await preview(ctx, jobId);
      expect(doc.job.status).toBe('awaiting_review');
      const blocks = doc.blocks as Json[];
      expect(kindOf(blocks, 'theory').length).toBeGreaterThan(0);
      expect(kindOf(blocks, 'question')).toHaveLength(2);
      expect(kindOf(blocks, 'solution')).toHaveLength(2);
      const order = blocks.map((b) => [b.sourcePage, b.sortOrder]);
      expect(order).toEqual([...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
      for (const b of blocks) {
        expect(b.provenance).toMatchObject({ origin: 'extracted', edited: false, classifiedBy: 'rule' });
        expect(b.originalText).toBe(b.text);
        expect(['ready', 'flagged', 'blocked', 'done', 'excluded']).toContain(b.readiness);
      }
      expect(doc.summary).toMatchObject({ questions: 2, canApprove: true, cannotApproveBecause: null, drafts: 0 });
    });

    it('says what is missing from each question, in words', async () => {
      const doc = await preview(ctx, jobId);
      for (const q of kindOf(doc.blocks, 'question')) {
        expect(q.readiness).toBe('blocked');
        expect(q.readinessReasons.join(' ')).toMatch(/how long this question should take/);
        // What the document printed is the document's; what it did not print is not invented.
        expect(q.question.expectedTimeSeconds).toBeNull();
        expect(q.question.answerSource).toBe('source');
      }
      expect(doc.summary.questionsMissingValues).toBe(2);
    });

    it('attaches each solution to its question, and takes nothing from them but the link', async () => {
      const doc = await preview(ctx, jobId);
      const questions = kindOf(doc.blocks, 'question');
      for (const q of questions) {
        expect(q.solution).toMatchObject({ confirmed: true });
        expect(q.solution.text).toMatch(/angular momentum/i);
      }
      expect(doc.summary.solutionsAttached).toBe(2);
    });
  });

  describe('values no document states', () => {
    let ctx: Fixture;
    let jobId: string;
    beforeAll(async () => {
      ctx = await setup();
      jobId = await ingest(ctx);
    });
    afterAll(async () => {
      await ctx.t.close();
    });

    it('are filled only by what the administrator chooses, and never over a value already there', async () => {
      const res = await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 90, integer: 150 } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ updated: 2, questions: 2 });
      const doc = await preview(ctx, jobId);
      const byType = Object.fromEntries(kindOf(doc.blocks, 'question').map((q) => [q.question.type, q.question]));
      expect(byType.single_correct).toMatchObject({ expectedTimeSeconds: 90, expectedTimeSource: 'reviewer' });
      expect(byType.integer).toMatchObject({ expectedTimeSeconds: 150, expectedTimeSource: 'reviewer' });
      // Printed difficulty stays the document's.
      expect(byType.single_correct).toMatchObject({ difficultyLabel: 3, difficultySource: 'source' });
      const again = await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 600 } });
      expect(again.body.updated).toBe(0);
    });

    it('do not count as having reviewed the question', async () => {
      const doc = await preview(ctx, jobId);
      for (const q of kindOf(doc.blocks, 'question')) expect(q.contentReviewed).toBe(false);
    });

    it('refuse an unusable number rather than storing it', async () => {
      expect((await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 2 } })).status).toBe(400);
      expect((await defaults(ctx, jobId, { difficultyLabel: 9 })).status).toBe(400);
    });
  });

  describe('Approve and Publish', () => {
    it('publishes the whole document through the normal path, as the administrator who approved it', async () => {
      const ctx = await setup();
      try {
        const jobId = await ingest(ctx);
        await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 90, integer: 150 } });

        const ready = await preview(ctx, jobId);
        expect(ready.summary.readiness.blocked).toBe(0);

        const dry = await approve(ctx, jobId, { dryRun: true, confirmFlagged: true });
        expect(dry.status).toBe(200);
        expect(dry.body.dryRun).toBe(true);
        expect(await liveQuestions(ctx)).toBe(0);

        const res = await approve(ctx, jobId, { confirmFlagged: true });
        expect(res.status).toBe(200);
        expect(res.body.totals).toMatchObject({ failed: 0, blocked: 0 });
        expect(res.body.totals.published).toBeGreaterThanOrEqual(3);
        expect(res.body.complete).toBe(true);

        // The question bank: real questions, with their official solutions, published.
        expect(await publishedQuestions(ctx)).toBe(2);
        expect(await count(`SELECT count(*)::int AS n FROM official_solutions WHERE tenant_id = $1 AND status = 'approved' AND deleted_at IS NULL`, [ctx.tenant.id])).toBe(2);
        // What the printed answer said, and what the solution said, are what is stored.
        const { rows } = await db().query(`SELECT q.type, o.option_key FROM questions q LEFT JOIN question_options o ON o.question_id = q.id AND o.is_correct WHERE q.tenant_id = $1 ORDER BY q.type`, [ctx.tenant.id]);
        expect(rows.find((r) => r.type === 'single_correct')!.option_key).toBe('B');

        // Students reach it through the ordinary student API.
        const theory = await ctx.t.http().get(`/v1/subtopics/${ctx.syllabus.subtopicId}/theory`).set(...bearer(ctx.student));
        expect((theory.body as Json).blocks.length).toBeGreaterThan(0);
        const tree = await ctx.t.http().get(`/v1/tracks/${ctx.syllabus.trackId}/tree`).set(...bearer(ctx.student));
        expect(JSON.stringify(tree.body)).toContain('"questionCount":2');

        // Everything is under the real administrator's name: no system account publishes.
        const published = await auditRows(ctx, 'content_block.published');
        expect(published.length).toBeGreaterThanOrEqual(3);
        for (const row of published) expect(row).toMatchObject({ actor_user_id: ctx.adminUser.id, actor_role: 'ADMIN' });
        const approved = await auditRows(ctx, 'ingestion_job.approved', jobId);
        expect(approved).toHaveLength(1);
        expect(approved[0]).toMatchObject({ actor_user_id: ctx.adminUser.id, actor_role: 'ADMIN' });
        const createdBy = await db().query(`SELECT DISTINCT created_by FROM questions WHERE tenant_id = $1`, [ctx.tenant.id]);
        expect(createdBy.rows.map((r) => r.created_by)).toEqual([ctx.adminUser.id]);

        const job = await ctx.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...asAdmin(ctx));
        expect((job.body as Json).job.status).toBe('published');
      } finally {
        await ctx.t.close();
      }
    });

    it('is safe to repeat: a published document is refused, not published twice', async () => {
      const ctx = await setup();
      try {
        const jobId = await ingest(ctx);
        await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 90, integer: 150 } });
        expect((await approve(ctx, jobId, { confirmFlagged: true })).status).toBe(200);
        const again = await approve(ctx, jobId, { confirmFlagged: true });
        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe('INVALID_STATE');
        expect(await liveQuestions(ctx)).toBe(2);
      } finally {
        await ctx.t.close();
      }
    });

    it('cannot be done twice at once: of two simultaneous approvals one publishes and the other is refused', async () => {
      const ctx = await setup();
      try {
        const jobId = await ingest(ctx);
        await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 90, integer: 150 } });
        const results = await Promise.all([approve(ctx, jobId, { confirmFlagged: true }), approve(ctx, jobId, { confirmFlagged: true }), approve(ctx, jobId, { confirmFlagged: true })]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
        expect(await liveQuestions(ctx)).toBe(2);
        expect(await publishedQuestions(ctx)).toBe(2);
      } finally {
        await ctx.t.close();
      }
    });

    it('reports a block that is blocked and publishes the rest, rather than all-or-nothing', async () => {
      const ctx = await setup();
      try {
        const jobId = await ingest(ctx);
        // Only the single-correct question gets an expected time; the integer one stays blocked.
        await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 90 } });
        const res = await approve(ctx, jobId, { confirmFlagged: true });
        expect(res.status).toBe(200);
        const blocked = (res.body.blocks as Json[]).filter((b) => b.outcome === 'blocked');
        expect(blocked).toHaveLength(1);
        expect(blocked[0]!.reasons.join(' ')).toMatch(/how long this question should take/);
        expect(res.body.complete).toBe(false);
        expect(await publishedQuestions(ctx)).toBe(1);
        const job = await ctx.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...asAdmin(ctx));
        expect((job.body as Json).job.status).toBe('awaiting_review');

        // Fix it and approve again: only what is left is published.
        await defaults(ctx, jobId, { expectedTimeSecondsByType: { integer: 150 } });
        const second = await approve(ctx, jobId, { confirmFlagged: true });
        expect(second.status).toBe(200);
        expect(second.body.complete).toBe(true);
        expect(await publishedQuestions(ctx)).toBe(2);
        expect(await liveQuestions(ctx)).toBe(2);
      } finally {
        await ctx.t.close();
      }
    });
  });

  describe('flagged blocks need the administrator\'s say-so', () => {
    it('are left alone unless confirmed, and are marked reviewed by the one who confirmed them', async () => {
      // Questions read with less than this confidence are flagged: nothing is missing, but the rules want a person.
      const ctx = await setup({ params: withAuto({ ingestion: { confidence: { question_min: 0.999 } } }) });
      try {
        const jobId = await ingest(ctx);
        await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 90, integer: 150 } });
        const doc = await preview(ctx, jobId);
        for (const q of kindOf(doc.blocks, 'question')) {
          expect(q.readiness).toBe('flagged');
          expect(q.readinessReasons.join(' ')).toMatch(/confidence/);
        }
        expect(doc.summary.wouldPublish.withFlagged).toBeGreaterThan(doc.summary.wouldPublish.ready);

        const questionIds = kindOf(doc.blocks, 'question').map((q) => q.id);
        const without = await approve(ctx, jobId);
        expect(without.status).toBe(200);
        expect((without.body.blocks as Json[]).filter((b) => questionIds.includes(b.blockId)).map((b) => b.outcome)).toEqual(['skipped', 'skipped']);
        expect(await liveQuestions(ctx)).toBe(0);

        const withIt = await approve(ctx, jobId, { confirmFlagged: true });
        expect(withIt.status).toBe(200);
        expect(withIt.body.totals.confirmed).toBeGreaterThanOrEqual(2);
        expect(await publishedQuestions(ctx)).toBe(2);

        const confirmed = await auditRows(ctx, 'content_block.confirmed');
        expect(confirmed.length).toBeGreaterThanOrEqual(2);
        for (const row of confirmed) expect(row).toMatchObject({ actor_user_id: ctx.adminUser.id, actor_role: 'ADMIN' });
        const blocks = (await preview(ctx, jobId)).blocks as Json[];
        for (const q of kindOf(blocks, 'question')) expect(q.reviewedBy).toBe(ctx.adminUser.id);
      } finally {
        await ctx.t.close();
      }
    });

    it('is no way past a gate a look cannot settle: a question with no expected time stays blocked even when confirmed', async () => {
      const ctx = await setup({ params: withAuto({ ingestion: { confidence: { question_min: 0.999 } } }) });
      try {
        const jobId = await ingest(ctx);
        const res = await approve(ctx, jobId, { confirmFlagged: true });
        const questionOutcomes = (res.body.blocks as Json[]).filter((b) => b.reasons.join(' ').match(/how long this question/));
        expect(questionOutcomes.map((b) => b.outcome)).toEqual(['blocked', 'blocked']);
        expect(await liveQuestions(ctx)).toBe(0);
      } finally {
        await ctx.t.close();
      }
    });
  });

  describe('choosing a sub-topic is not reviewing the content', () => {
    it('is recorded so a re-run keeps it, but leaves the review gates asking', async () => {
      const ctx = await setup({ params: withAuto({ ingestion: { confidence: { classification_min: 0.999 } } }) });
      try {
        const jobId = await ingest(ctx);
        const theory = kindOf((await preview(ctx, jobId)).blocks, 'theory').find((b) => b.text.length > 100)!;
        expect(theory.readiness).toBe('flagged');

        const patched = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${theory.id}`).set(...asAdmin(ctx)).send({ subtopicId: ctx.syllabus.subtopicId });
        expect(patched.status).toBe(200);
        expect(patched.body.reviewedBy).toBe(ctx.adminUser.id);
        expect(patched.body.contentReviewed).toBe(false);
        expect(patched.body.readiness).toBe('flagged');

        const edited = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${theory.id}`).set(...asAdmin(ctx)).send({ title: 'Angular momentum' });
        expect(edited.body.contentReviewed).toBe(true);
        expect(edited.body.readiness).toBe('ready');
        expect(edited.body.provenance.edited).toBe(true);
      } finally {
        await ctx.t.close();
      }
    });
  });

  describe('a question printed without its answer', () => {
    it('takes it from the solution matched to it, and says so', async () => {
      const ctx = await setup();
      try {
        const jobId = await ingest(ctx, makePdf({ pages: [THEORY_PAGE, UNANSWERED_PAGE], compress: true }));
        const doc = await preview(ctx, jobId);
        const q = kindOf(doc.blocks, 'question')[0]!;
        expect(q.question.answerSource).toBe('solution');
        expect(q.question.options.find((o: Json) => o.key === 'C').isCorrect).toBe(true);
        expect(q.question.gaps).toEqual([]);
        expect(q.provenance.inferred).toContain('answer taken from the matched solution');
        expect(q.provenance.origin).toBe('extracted');
      } finally {
        await ctx.t.close();
      }
    });
  });

  describe('publishing a question is all-or-nothing, and recoverable', () => {
    async function readyQuestion(ctx: Fixture): Promise<string> {
      const jobId = await ingest(ctx);
      await defaults(ctx, jobId, { expectedTimeSecondsByType: { single_correct: 90, integer: 150 } });
      const q = kindOf((await preview(ctx, jobId)).blocks, 'question').find((b) => b.question.type === 'single_correct')!;
      expect(q.readiness).not.toBe('blocked');
      return q.id as string;
    }

    it('leaves no question behind when it fails part-way, and a retry makes exactly one', async () => {
      const ctx = await setup();
      try {
        const blockId = await readyQuestion(ctx);
        const questions = ctx.t.app.get(QuestionsAdminService);
        const spy = jest.spyOn(questions, 'publish').mockRejectedValueOnce(new Error('simulated failure after the draft was created'));

        const failed = await ctx.t.http().post(`/v1/admin/ingestion/blocks/${blockId}/publish`).set(...asAdmin(ctx)).send({});
        expect(failed.status).toBe(500);
        spy.mockRestore();
        // The draft was created, then removed: nothing a student could see, and nothing orphaned.
        expect(await publishedQuestions(ctx)).toBe(0);
        expect(await liveQuestions(ctx)).toBe(0);
        const row = (await db().query(`SELECT status, content_json ? 'publishing' AS claimed FROM content_blocks WHERE id = $1`, [blockId])).rows[0];
        expect(row.status).not.toBe('published');
        expect(row.claimed).toBe(false);

        const retry = await ctx.t.http().post(`/v1/admin/ingestion/blocks/${blockId}/publish`).set(...asAdmin(ctx)).send({});
        expect(retry.status).toBe(200);
        expect(await publishedQuestions(ctx)).toBe(1);
        expect(await liveQuestions(ctx)).toBe(1);
      } finally {
        await ctx.t.close();
      }
    });

    it('publishes the solution before the question becomes visible', async () => {
      const ctx = await setup();
      try {
        const blockId = await readyQuestion(ctx);
        const questions = ctx.t.app.get(QuestionsAdminService);
        let solutionWhenPublishing: number | null = null;
        const original = questions.publish.bind(questions);
        const spy = jest.spyOn(questions, 'publish').mockImplementation(async (auth, id) => {
          solutionWhenPublishing = Number((await db().query(`SELECT count(*)::int AS n FROM official_solutions WHERE question_id = $1 AND status = 'approved' AND deleted_at IS NULL`, [id])).rows[0].n);
          return original(auth, id);
        });
        const res = await ctx.t.http().post(`/v1/admin/ingestion/blocks/${blockId}/publish`).set(...asAdmin(ctx)).send({});
        spy.mockRestore();
        expect(res.status).toBe(200);
        expect(solutionWhenPublishing).toBe(1);
      } finally {
        await ctx.t.close();
      }
    });

    it('finishes a publication that died after the question went live, instead of creating a second one', async () => {
      const ctx = await setup();
      try {
        const blockId = await readyQuestion(ctx);
        const first = await ctx.t.http().post(`/v1/admin/ingestion/blocks/${blockId}/publish`).set(...asAdmin(ctx)).send({});
        expect(first.status).toBe(200);
        const questionId = first.body.questionId as string;

        // Put the block back as a crash would have left it: the question published, the block not yet finished, the
        // claim old enough to be taken over.
        await db().query(
          `UPDATE content_blocks SET status = 'approved', published_at = NULL,
                  content_json = (content_json - 'publishedQuestionId') || jsonb_build_object('publishing', jsonb_build_object('by', 'dead-process', 'at', now() - interval '20 minutes', 'questionId', $2::text))
            WHERE id = $1`,
          [blockId, questionId],
        );

        const resumed = await ctx.t.http().post(`/v1/admin/ingestion/blocks/${blockId}/publish`).set(...asAdmin(ctx)).send({});
        expect(resumed.status).toBe(200);
        expect(resumed.body.questionId).toBe(questionId);
        expect(await liveQuestions(ctx)).toBe(1);
        const row = (await db().query(`SELECT status, content_json ->> 'publishedQuestionId' AS qid, content_json ? 'publishing' AS claimed FROM content_blocks WHERE id = $1`, [blockId])).rows[0];
        expect(row).toMatchObject({ status: 'published', qid: questionId, claimed: false });
      } finally {
        await ctx.t.close();
      }
    });

    it('refuses to take over a publication that is still in progress', async () => {
      const ctx = await setup();
      try {
        const blockId = await readyQuestion(ctx);
        await db().query(
          `UPDATE content_blocks SET content_json = content_json || jsonb_build_object('publishing', jsonb_build_object('by', 'someone-else', 'at', now())) WHERE id = $1`,
          [blockId],
        );
        const res = await ctx.t.http().post(`/v1/admin/ingestion/blocks/${blockId}/publish`).set(...asAdmin(ctx)).send({});
        expect(res.status).toBe(409);
        expect(await liveQuestions(ctx)).toBe(0);
      } finally {
        await ctx.t.close();
      }
    });
  });

  describe('editing what a reviewer can correct', () => {
    it('records that an answer, a difficulty and a time were set by a person, and re-reads what is still wrong', async () => {
      const ctx = await setup();
      try {
        const jobId = await ingest(ctx);
        const q = kindOf((await preview(ctx, jobId)).blocks, 'question').find((b) => b.question.type === 'single_correct')!;
        const res = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${q.id}`).set(...asAdmin(ctx)).send({
          question: { difficultyLabel: 4, expectedTimeSeconds: 100, options: q.question.options.map((o: Json) => ({ key: o.key, text: o.text, isCorrect: o.key === 'C' })) },
          solutionText: 'Corrected by the reviewer: the answer is C.',
        });
        expect(res.status).toBe(200);
        expect(res.body.question).toMatchObject({ difficultyLabel: 4, difficultySource: 'reviewer', expectedTimeSeconds: 100, expectedTimeSource: 'reviewer', answerSource: 'reviewer', gaps: [] });
        expect(res.body.question.options.find((o: Json) => o.key === 'C').isCorrect).toBe(true);
        expect(res.body.solution).toMatchObject({ text: 'Corrected by the reviewer: the answer is C.', confirmed: true });
        expect(res.body.contentReviewed).toBe(true);
        expect(res.body.provenance.edited).toBe(true);
        expect(res.body.readiness).toBe('ready');
      } finally {
        await ctx.t.close();
      }
    });

    it('refuses an edit that makes the question unreadable rather than saving it quietly', async () => {
      const ctx = await setup();
      try {
        const jobId = await ingest(ctx);
        const q = kindOf((await preview(ctx, jobId)).blocks, 'question')[0]!;
        const res = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${q.id}`).set(...asAdmin(ctx)).send({ question: { expectedTimeSeconds: 1 } });
        expect(res.status).toBe(400);
        const none = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${q.id}`).set(...asAdmin(ctx)).send({ question: { confirmAnswer: true, options: [{ key: 'A', text: 'x', isCorrect: false }, { key: 'B', text: 'y', isCorrect: false }] } });
        expect(none.status).toBe(422);
      } finally {
        await ctx.t.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------

/**
 * A model that behaves like one: it reads what the prompt says, and answers in the shape asked for. For revision notes
 * it cites the block ids that appear in the prompt, so the real validator checks real citations.
 */
/** One question per level, each on a different point of the theory, each worked out by a solution that agrees with its key. */
const LEVEL_QUESTIONS: Record<number, { stem: string; options: [string, string, string, string] }> = {
  1: {
    stem: 'What is the angular momentum of a rigid body about a fixed axis equal to?',
    options: ['The sum of its moment of inertia and its angular velocity', 'The product of its moment of inertia and its angular velocity', 'The difference between its moment of inertia and its angular velocity', 'The ratio of its angular velocity to its moment of inertia'],
  },
  2: {
    stem: 'Why does a spinning skater turn faster when she pulls her arms in?',
    options: ['Her moment of inertia rises so her angular velocity rises', 'Her moment of inertia falls so her angular velocity rises', 'Her angular momentum rises so her angular velocity falls', 'Her torque rises so her moment of inertia falls'],
  },
  3: {
    stem: 'Under which condition is the angular momentum of a body conserved?',
    options: ['When the net external torque on the body is large', 'When the net external torque on the body is zero', 'When the moment of inertia of the body is zero', 'When the angular velocity of the body is zero'],
  },
  4: {
    stem: 'In terms of angular momentum, what is the torque on a body?',
    options: ['The product of the angular momentum and the moment of inertia', 'The rate at which its angular momentum changes', 'The angular momentum divided by the angular velocity', 'The sum of its angular momentum and angular velocity'],
  },
};

class ScriptedModel extends FakeAiProvider {
  /** Drafting questions is switched on by the tests that are about it, so the others see only what they are about. */
  writeQuestions = false;
  /** A model whose worked solution reaches a different answer from the key it marked. */
  contradictSelf = false;

  override reset(): void {
    super.reset();
    this.writeQuestions = false;
    this.contradictSelf = false;
  }

  override generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    if (request.task === 'question_generation' && this.writeQuestions) {
      const ids = [...new Set([...request.prompt.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]))];
      const level = Number(/Difficulty: L(d)/.exec(request.prompt)?.[1] ?? 1);
      const q = LEVEL_QUESTIONS[level]!;
      const text = JSON.stringify({
        type: 'single_correct',
        stem: q.stem,
        options: q.options.map((t, i) => ({ key: 'ABCD'[i], text: t, isCorrect: i === 1 })),
        numericAnswer: null,
        hints: [],
        expectedTimeSeconds: 40 + level * 20,
        solution: {
          summary: 'The notes state this directly, so the correct option follows from them.',
          steps: ['Recall what the notes say about angular momentum, moment of inertia and angular velocity.', 'Pick the option that matches the statement in the notes.'],
          finalAnswer: { optionKeys: [this.contradictSelf ? 'C' : 'B'] },
        },
        sourceBlockIds: ids,
      });
      this.structuredCalls.push(request);
      return Promise.resolve({ provider: this.name, model: this.explanationModel, text });
    }
    return this.generateOther(request);
  }

  private generateOther(request: StructuredRequest): Promise<StructuredResult> {
    if (request.task === 'revision_notes') {
      const ids = [...new Set([...request.prompt.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]))];
      const text = JSON.stringify({
        title: 'Angular momentum',
        overview: 'The angular momentum of a rigid body is its moment of inertia times its angular velocity.',
        keyPoints: [
          { text: 'Angular momentum is the product of moment of inertia and angular velocity.', sourceBlockIds: ids },
          { text: 'Angular momentum is conserved when the net external torque is zero.', sourceBlockIds: ids },
        ],
        concepts: [{ term: 'Conservation', explanation: 'A spinning skater speeds up by pulling in her arms because angular momentum is conserved.', sourceBlockIds: ids }],
        formulas: [],
        commonMistakes: [],
        quickRevision: [{ text: 'No external torque means angular momentum is conserved.', sourceBlockIds: ids }],
      });
      this.structuredCalls.push(request);
      return Promise.resolve({ provider: this.name, model: this.explanationModel, text });
    }
    return super.generateStructured(request);
  }
}

describe('ingestion with a model: what it may add, and what it may not', () => {
  let fake: ScriptedModel;
  let f: Fixture;

  beforeAll(async () => {
    fake = new ScriptedModel();
    f = await setup({ ai: fake });
  });
  afterAll(async () => {
    await f.t.close();
    await closeDb();
  });
  beforeEach(() => fake.reset());

  const understandingReply = {
    classification: 'question',
    confidence: 0.97,
    theory: null,
    question: {
      type: 'single_correct',
      stem: 'Which of these quantities about a spinning rigid body is conserved when no external torque acts on the body at all?',
      options: [
        { key: 'A', text: 'Angular momentum', isCorrect: true },
        { key: 'B', text: 'Linear speed', isCorrect: false },
        { key: 'C', text: 'Angular acceleration', isCorrect: false },
        { key: 'D', text: 'Moment of inertia', isCorrect: false },
      ],
      numericAnswer: null,
      difficulty: 'HARD',
      explanation: null,
      answerExplicitlyPresent: true,
    },
  };

  it('keeps a model\'s answer, difficulty and time as suggestions until a person accepts them', async () => {
    fake.replyStructured('content_understanding', understandingReply);
    const jobId = await ingest(f, makePdf({ pages: [THEORY_PAGE, NO_ANSWER_PAGE], compress: true }), 'no-answer.pdf');
    expect(fake.structuredCallsFor('content_understanding').length).toBeGreaterThan(0);

    const doc = await preview(f, jobId);
    const q = kindOf(doc.blocks, 'question')[0]!;
    // It is labelled as the model's, and the document did not say it.
    expect(q.provenance).toMatchObject({ origin: 'ai_assisted', classifiedBy: 'model' });
    expect(q.provenance.ai).toMatchObject({ task: 'content_understanding', provider: 'gemini' });
    expect(q.question.answerSource).toBe('ai_unverified');
    expect(q.question.gaps.join(' ')).toMatch(/model.*document does not state/);
    // The model's confidence of 0.97 is not carried over as the question's.
    expect(q.question.confidence).toBe(0.97);
    // What counts is empty; what the model guessed is shown beside it.
    expect(q.question).toMatchObject({ difficultyLabel: null, expectedTimeSeconds: null });
    expect(q.question.suggested).toMatchObject({ by: 'ai', difficultyLabel: 4, expectedTimeSeconds: 180 });
    expect(q.readiness).toBe('blocked');
    expect(q.readinessReasons.join(' ')).toMatch(/model proposed this answer/);
    expect(doc.summary.answersToVerify).toBe(1);
    // The PDF's own text is untouched.
    expect(q.originalText).toMatch(/^4\. Which of these quantities/);
  });

  it('cannot be published until a person has verified the answer, accepted the suggestions and been counted as reviewing', async () => {
    fake.replyStructured('content_understanding', understandingReply);
    const jobId = await ingest(f, makePdf({ pages: [THEORY_PAGE, NO_ANSWER_PAGE, 'A spare page for this test only.'], compress: true }), 'verify.pdf');
    const q = kindOf((await preview(f, jobId)).blocks, 'question')[0]!;

    // Not even an administrator's bulk approval gets it through.
    const blockedRun = await approve(f, jobId, { confirmFlagged: true, dryRun: true });
    expect((blockedRun.body.blocks as Json[]).find((b) => b.blockId === q.id)!.outcome).toBe('blocked');
    const direct = await f.t.http().post(`/v1/admin/ingestion/blocks/${q.id}/publish`).set(...asAdmin(f)).send({});
    expect(direct.status).toBe(422);
    expect(JSON.stringify(direct.body)).toMatch(/answer_verified/);

    // The administrator checks the answer and accepts what was suggested.
    const fixed = await f.t.http().patch(`/v1/admin/ingestion/blocks/${q.id}`).set(...asAdmin(f)).send({ question: { confirmAnswer: true, acceptSuggested: true } });
    expect(fixed.status).toBe(200);
    expect(fixed.body.question).toMatchObject({ answerSource: 'reviewer', difficultyLabel: 4, difficultySource: 'reviewer', expectedTimeSeconds: 180, expectedTimeSource: 'reviewer', gaps: [] });
    expect(fixed.body.readiness).toBe('ready');
    expect(fixed.body.provenance.origin).toBe('ai_assisted');
  });

  it('is never auto-approved: content a model touched is not eligible, whatever its own confidence', async () => {
    fake.replyStructured('content_understanding', understandingReply);
    const jobId = await ingest(f, makePdf({ pages: [THEORY_PAGE, NO_ANSWER_PAGE, 'Another spare page for this test.'], compress: true }), 'flagged.pdf');
    const q = kindOf((await preview(f, jobId)).blocks, 'question')[0]!;
    expect(q.autoApprovalEligible).toBe(false);
    expect(q.machineNotes.autoApproval.autoApprove).toBe(false);
  });

  describe('drafts of learning material', () => {
    it('are written from the document\'s own theory, labelled as the model\'s, and left unpublished', async () => {
      const jobId = await ingest(f, makePdf({ pages: [uniqueTheory()], compress: true }), 'drafts.pdf');
      expect(fake.structuredCallsFor('revision_notes')).toHaveLength(1);
      const doc = await preview(f, jobId);
      const drafts = draftsOf(doc.blocks);
      expect(drafts).toHaveLength(1);
      const draft = drafts[0]!;
      expect(draft.provenance).toMatchObject({ origin: 'ai_generated', classifiedBy: 'model' });
      expect(draft.status).toBe('needs_review');
      expect(draft.readiness).toBe('flagged');
      expect(draft.draft.notes.keyPoints.length).toBeGreaterThan(0);
      expect(draft.draft.groundingScore).toBeGreaterThan(0.5);
      expect(doc.summary.drafts).toBe(1);
      expect(await count(`SELECT count(*)::int AS n FROM revision_notes WHERE tenant_id = $1`, [f.tenant.id])).toBe(0);
    });

    it('become the sub-topic\'s revision notes only when approved, never published as theory, and are then served without a model call', async () => {
      const ctx = await setup({ ai: new ScriptedModel() });
      try {
        const model = ctx.t.app.get<ScriptedModel>(AI_PRIMARY_PROVIDER);
        const jobId = await ingest(ctx, makePdf({ pages: [uniqueTheory()], compress: true }), 'drafts2.pdf');
        const before = await preview(ctx, jobId);
        const draftId = draftsOf(before.blocks)[0]!.id as string;

        // Without confirming flagged blocks the draft waits, and the theory is published.
        const first = await approve(ctx, jobId);
        expect(first.status).toBe(200);
        expect((first.body.blocks as Json[]).find((b) => b.blockId === draftId)!.outcome).toBe('skipped');
        expect(await count(`SELECT count(*)::int AS n FROM revision_notes WHERE tenant_id = $1`, [ctx.tenant.id])).toBe(0);

        const second = await approve(ctx, jobId, { confirmFlagged: true });
        expect(second.status).toBe(200);
        expect((second.body.blocks as Json[]).find((b) => b.blockId === draftId)!.outcome).toBe('confirmed_and_published');
        expect(second.body.totals.failed).toBe(0);

        // Notes, not theory: the published theory is the document's own text only.
        const theory = (await db().query(`SELECT id FROM content_blocks WHERE tenant_id = $1 AND kind = 'theory' AND status = 'published'`, [ctx.tenant.id])).rows.map((r) => r.id);
        expect(theory).not.toContain(draftId);
        const notes = (await db().query(`SELECT status, scope_level, scope_id, provider FROM revision_notes WHERE tenant_id = $1`, [ctx.tenant.id])).rows;
        expect(notes).toEqual([{ status: 'active', scope_level: 'subtopic', scope_id: ctx.syllabus.subtopicId, provider: 'gemini' }]);
        const consumed = (await db().query(`SELECT status, content_json -> 'draft' -> 'activation' ->> 'notesId' AS notes_id FROM content_blocks WHERE id = $1`, [draftId])).rows[0];
        expect(consumed.status).toBe('superseded');
        expect(consumed.notes_id).toMatch(/[0-9a-f-]{36}/);

        // The learner-facing feature finds them ready and does not call the model.
        const calls = model.structuredCallsFor('revision_notes').length;
        const read = await ctx.t.http().get(`/v1/revision-notes?level=subtopic&id=${ctx.syllabus.subtopicId}`).set(...bearer(ctx.student));
        expect(read.status).toBe(200);
        expect(read.body.state).toBe('ready');
        expect(read.body.notes.keyPoints.length).toBeGreaterThan(0);
        expect(model.structuredCallsFor('revision_notes').length).toBe(calls);
      } finally {
        await ctx.t.close();
      }
    });

    it('can be edited, and the edit is what is kept', async () => {
      const ctx = await setup({ ai: new ScriptedModel() });
      try {
        const jobId = await ingest(ctx, makePdf({ pages: [uniqueTheory()], compress: true }), 'drafts3.pdf');
        const draft = draftsOf((await preview(ctx, jobId)).blocks)[0]!;
        const notes = { ...draft.draft.notes, title: 'Edited title', overview: 'The reviewer rewrote this overview.' };
        const res = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${draft.id}`).set(...asAdmin(ctx)).send({ draft: { notes } });
        expect(res.status).toBe(200);
        expect(res.body.draft.edited).toBe(true);
        expect(res.body.contentReviewed).toBe(true);
        expect(res.body.text).toContain('The reviewer rewrote this overview.');
        const bad = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${draft.id}`).set(...asAdmin(ctx)).send({ draft: { notes: { title: 'only a title' } } });
        expect(bad.status).toBe(400);

        const result = await approve(ctx, jobId, { confirmFlagged: true });
        expect(result.status).toBe(200);
        const stored = (await db().query(`SELECT content FROM revision_notes WHERE tenant_id = $1 AND status = 'active'`, [ctx.tenant.id])).rows[0];
        expect(stored.content.title).toBe('Edited title');
      } finally {
        await ctx.t.close();
      }
    });
  });

  describe('practice questions drafted from the theory', () => {
    const generated = (blocks: Json[]): Json[] => blocks.filter((b) => b.kind === 'question' && b.provenance.origin === 'ai_generated');

    it('are drafted at levels 1 to 4 from the document's own theory, labelled, and never counted as verified', async () => {
      fake.writeQuestions = true;
      const jobId = await ingest(f, makePdf({ pages: [uniqueTheory()], compress: true }), 'qdrafts.pdf');
      const doc = await preview(f, jobId);
      const drafts = generated(doc.blocks);
      expect(drafts).toHaveLength(4);
      expect(fake.structuredCallsFor('question_generation')).toHaveLength(4);
      expect(drafts.map((d) => d.question.suggested.difficultyLabel).sort()).toEqual([1, 2, 3, 4]);
      for (const d of drafts) {
        expect(d.provenance).toMatchObject({ origin: 'ai_generated', classifiedBy: 'model' });
        expect(d.provenance.ai).toMatchObject({ task: 'question_generation' });
        // What the model said about its own question is a suggestion; nothing counts until a person accepts it.
        expect(d.question).toMatchObject({ answerSource: 'ai_unverified', difficultyLabel: null, expectedTimeSeconds: null });
        expect(d.question.options.filter((o: Json) => o.isCorrect)).toHaveLength(1);
        expect(d.solution.text).toMatch(/notes state this directly/);
        expect(d.readiness).toBe('blocked');
        expect(d.readinessReasons.join(' ')).toMatch(/model proposed this answer/);
        expect(d.autoApprovalEligible).toBe(false);
      }
      expect(doc.job.hierarchy.questionDrafts).toBe(4);
      // Nothing is in the bank, and the bulk helper cannot verify an answer for anyone.
      expect(await liveQuestions(f)).toBe(0);
    });

    it('reach the bank only once a person has checked the answer and accepted the level and time, and are published with their solution', async () => {
      fake.writeQuestions = true;
      const ctx = await setup({ ai: new ScriptedModel() });
      try {
        (ctx.t.app.get(AI_PRIMARY_PROVIDER) as ScriptedModel).writeQuestions = true;
        const jobId = await ingest(ctx, makePdf({ pages: [uniqueTheory()], compress: true }), 'qdrafts2.pdf');
        const drafts = generated((await preview(ctx, jobId)).blocks);
        const level2 = drafts.find((d) => d.question.suggested.difficultyLabel === 2)!;

        const checked = await ctx.t.http().patch(`/v1/admin/ingestion/blocks/${level2.id}`).set(...asAdmin(ctx)).send({ question: { confirmAnswer: true, acceptSuggested: true } });
        expect(checked.status).toBe(200);
        expect(checked.body.question).toMatchObject({ answerSource: 'reviewer', difficultyLabel: 2, expectedTimeSeconds: 80, gaps: [] });
        expect(checked.body.readiness).toBe('ready');

        const res = await approve(ctx, jobId, { confirmFlagged: true });
        expect(res.status).toBe(200);
        // Exactly the one a person verified is published; the three unverified ones are left blocked.
        const outcomes = Object.fromEntries((res.body.blocks as Json[]).map((b) => [b.blockId, b.outcome]));
        expect(outcomes[level2.id]).toMatch(/published/);
        for (const d of drafts.filter((x) => x.id !== level2.id)) expect(outcomes[d.id]).toBe('blocked');
        expect(await publishedQuestions(ctx)).toBe(1);
        const row = (await db().query(`SELECT q.difficulty_label, q.created_by, (SELECT count(*)::int FROM official_solutions o WHERE o.question_id = q.id AND o.status = 'approved') AS solutions FROM questions q WHERE q.tenant_id = $1 AND q.deleted_at IS NULL`, [ctx.tenant.id])).rows[0];
        expect(row).toMatchObject({ difficulty_label: 2, created_by: ctx.adminUser.id, solutions: 1 });
      } finally {
        await ctx.t.close();
      }
    });

    it('are discarded when the model's own worked solution disagrees with the key it marked', async () => {
      fake.writeQuestions = true;
      fake.contradictSelf = true;
      const jobId = await ingest(f, makePdf({ pages: [uniqueTheory()], compress: true }), 'qdrafts3.pdf');
      const doc = await preview(f, jobId);
      expect(generated(doc.blocks)).toHaveLength(0);
      expect(doc.job.hierarchy.questionDraftsNote).toMatch(/failed validation and were discarded/);
    });
  });

  it('writes nothing when no model is configured, and says so', async () => {
    const ctx = await setup();
    try {
      const jobId = await ingest(ctx, makePdf({ pages: [uniqueTheory()], compress: true }), 'nomodel.pdf');
      const doc = await preview(ctx, jobId);
      expect(draftsOf(doc.blocks)).toHaveLength(0);
      expect(doc.job.hierarchy.learningDraftsNote).toMatch(/no AI provider/);
      expect(doc.job.hierarchy.questionDraftsNote).toMatch(/no AI provider/);
    } finally {
      await ctx.t.close();
    }
  });
});
