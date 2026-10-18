import http from 'node:http';
import { JOB_QUEUE, type JobQueue } from '../../src/ingestion/job-queue';
import { OBJECT_STORAGE } from '../../src/storage/object-storage';
import type { MemoryObjectStorage } from '../../src/storage/memory-object-storage';
import { makeDamagedPdf, makeManyPagePdf, makeNotAPdf, makePdf } from '../fixtures/make-pdf';
import {
  auditActions,
  bearer,
  closeDb,
  createEngineConfig,
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
 * Content ingestion end to end: a real PDF uploaded over HTTP, processed by the real pipeline, and
 * reviewed and published through the real API.
 *
 * Nothing about the path is stubbed. The PDF is a genuine byte stream that the extractor parses the
 * way it would parse a textbook, the job runs through the queue the application binds, the blocks
 * and review tasks land in PostgreSQL, and publication goes through the Phase 3 question service —
 * so a question created here is indistinguishable from one an admin typed in.
 *
 * Two boundaries cannot run in this environment, and the tests say so rather than pretending:
 *
 *   * **OCR** — no provider is installable, so `OCR_PROVIDER=none` refuses. The tests assert the
 *     *refusal* is recorded and sent to review, which is the behaviour that matters: a scanned page
 *     must never disappear silently.
 *   * **pgvector** — not installed on this server, so publishing theory cannot embed it. The tests
 *     assert the publish still succeeds and reports why the embedding did not happen.
 *
 * Object storage runs on the in-memory adapter, which enforces the same key rules as any other, so
 * no credentials are needed and nothing is written to disk.
 */

// A page whose wording genuinely matches the syllabus fixture ("Angular Momentum" under
// "Rotational Dynamics" / "Mechanics" / "Physics"), so mapping is earned rather than arranged.
const QUESTIONS_PAGE = [
  'Angular Momentum',
  '',
  'The angular momentum of a rigid body about a fixed axis is the product of its moment of inertia and its angular velocity.',
  '',
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

const TEXTBOOK = makePdf({ pages: [QUESTIONS_PAGE, SOLUTIONS_PAGE], compress: true });

/** The stem the extractor reads out of question 1, used by the near-duplicate test. */
const QUESTION_ONE_STEM = 'A ring of mass 2 kg and radius 0.5 m rolls without slipping at 1 rad/s. Find its angular momentum about the axis.';

interface Fixture {
  t: TestApp;
  tenant: TenantFixture;
  syllabus: SyllabusFixture;
  admin: Session;
  student: Session;
  queue: JobQueue;
  storage: MemoryObjectStorage;
}

async function setup(options: { params?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<Fixture> {
  const t = await createTestApp(options.env);
  const tenant = await createTenant();
  const [adminUser, studentUser, syllabus] = await Promise.all([
    createUser(tenant, 'ADMIN'),
    createUser(tenant, 'STUDENT'),
    createSyllabus(tenant),
  ]);
  await createEngineConfig(tenant, options.params ?? {});
  const [admin, student] = await Promise.all([login(t, adminUser, tenant.slug), login(t, studentUser, tenant.slug)]);
  return {
    t,
    tenant,
    syllabus,
    admin,
    student,
    queue: t.app.get<JobQueue>(JOB_QUEUE),
    storage: t.app.get<MemoryObjectStorage>(OBJECT_STORAGE),
  };
}

function upload(f: Fixture, body: Buffer, query = '', filename = 'chapter-3.pdf') {
  return f
    .t.http()
    .post(`/v1/admin/ingestion/assets${query}`)
    .set(...bearer(f.admin))
    .set('Content-Type', 'application/pdf')
    .set('X-Filename', filename)
    .send(body);
}

/** Uploads the textbook, runs the job to completion and returns the job and its blocks. */
async function ingest(f: Fixture, body: Buffer = TEXTBOOK, query = ''): Promise<{ jobId: string; job: Json; blocks: Json[] }> {
  const created = await upload(f, body, query);
  expect(created.status).toBe(201);
  const jobId = (created.body as Json).jobId as string;
  await f.queue.drain();
  const [job, blocks] = await Promise.all([
    f.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...bearer(f.admin)),
    f.t.http().get(`/v1/admin/ingestion/jobs/${jobId}/blocks`).set(...bearer(f.admin)),
  ]);
  expect(job.status).toBe(200);
  expect(blocks.status).toBe(200);
  return { jobId, job: job.body as Json, blocks: blocks.body as Json[] };
}

const kindOf = (blocks: Json[], kind: string): Json[] => blocks.filter((b) => b.kind === kind);

describe('ingestion', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f.t.close();
    await closeDb();
  });

  // ---------------------------------------------------------------- upload

  describe('A-E. what the upload accepts and refuses', () => {
    it('B. refuses bytes that are not a PDF, whatever the declared content type says', async () => {
      const res = await upload(f, makeNotAPdf());
      expect(res.status).toBe(400);
      expect(((res.body as Json).error.details as Json[])[0]!.message).toMatch(/%PDF- header/);
    });

    it('B. refuses an empty upload', async () => {
      const res = await upload(f, Buffer.alloc(0));
      expect(res.status).toBe(400);
    });

    it('D. refuses a password-protected PDF and says what to do about it', async () => {
      const res = await upload(f, makePdf({ pages: ['secret'], encrypted: true }));
      expect(res.status).toBe(400);
      expect(((res.body as Json).error.details as Json[])[0]!.message).toMatch(/password|encrypt/i);
    });

    it('E. refuses a PDF with more pages than the configured limit', async () => {
      const small = await setup({ env: { UPLOAD_MAX_PAGES: '3' } });
      try {
        const res = await upload(small, makeManyPagePdf(5));
        expect(res.status).toBe(413);
        expect((res.body as Json).error.message).toContain('5');
      } finally {
        await small.t.close();
      }
    });

    it('B. refuses a damaged file rather than ingesting half a document', async () => {
      const res = await upload(f, makeDamagedPdf());
      expect(res.status).toBe(400);
      expect(((res.body as Json).error.details as Json[])[0]!.message).toMatch(/no readable pages/);
    });

    it('C. refuses a body over the size limit while it is still being read', async () => {
      const tiny = await setup({ env: { UPLOAD_MAX_MB: '1' } });
      try {
        // Valid PDF bytes followed by padding, so it is the size and not the format that refuses it.
        const padded = Buffer.concat([TEXTBOOK, Buffer.alloc(1_200_000, 0x20)]);
        // Sent with Node's own HTTP client over a real socket, because the refusal is a statement about what a client
        // sees on the wire: the 413 must reach a client that is still sending. (supertest cuts its own write short on
        // Windows once the response arrives, which says nothing about the server.)
        await tiny.t.app.listen(0, '127.0.0.1');
        const { port } = tiny.t.app.getHttpServer().address() as { port: number };
        const res = await new Promise<{ status: number; body: Json }>((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              method: 'POST',
              path: '/v1/admin/ingestion/assets',
              headers: { 'Content-Type': 'application/pdf', 'Content-Length': padded.length, Authorization: `Bearer ${tiny.admin.accessToken}`, 'X-Filename': 'big.pdf' },
            },
            (response) => {
              let text = '';
              response.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
              response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Json }));
            },
          );
          req.on('error', reject);
          req.end(padded);
        });
        expect(res.status).toBe(413);
        expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      } finally {
        await tiny.t.close();
      }
    });

    it('A. a valid PDF is accepted, stored and queued', async () => {
      const res = await upload(f, makePdf({ pages: [QUESTIONS_PAGE, 'A second page that makes these bytes this test’s own.'] }), '', 'accepted.pdf');
      expect(res.status).toBe(201);
      const body = res.body as Json;
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.pageCount).toBe(2);
      expect(body.queueJobId).toMatch(/\S/);
      expect(await f.storage.head(body.storageKey as string)).toMatchObject({ contentType: 'application/pdf' });
      await f.queue.drain();
    });
  });

  describe('F/G. duplicate detection is per organisation', () => {
    it('F. refuses the same bytes twice in one organisation', async () => {
      const bytes = makePdf({ pages: ['A page of unique theory text for the duplicate test, long enough to be a block.'] });
      const first = await upload(f, bytes, '', 'first.pdf');
      expect(first.status).toBe(201);
      const second = await upload(f, bytes, '', 'a-different-name.pdf');
      expect(second.status).toBe(409);
      expect((second.body as Json).error.code).toBe('DUPLICATE');
      await f.queue.drain();
    });

    it('F/G. accepts the same bytes in a different organisation', async () => {
      const bytes = makePdf({ pages: ['Shared material that two organisations may both legitimately hold in their own libraries.'] });
      const other = await setup();
      try {
        expect((await upload(f, bytes)).status).toBe(201);
        expect((await upload(other, bytes)).status).toBe(201);
        await Promise.all([f.queue.drain(), other.queue.drain()]);
      } finally {
        await other.t.close();
      }
    });

    it('AK. stores the bytes under a built key, never under the uploaded filename', async () => {
      const res = await upload(f, makePdf({ pages: ['Key safety: this page exists only to be stored somewhere sensible.'] }), '', '../../etc/passwd.pdf');
      expect(res.status).toBe(201);
      const key = (res.body as Json).storageKey as string;
      expect(key).toMatch(new RegExp(`^tenants/${f.tenant.id}/source_pdf/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.pdf$`));
      expect(key).not.toContain('passwd');
      expect(key).not.toContain('..');
      await f.queue.drain();
    });
  });

  describe('G/H. the upload route is admin-only, tenant-isolated and rate-limited', () => {
    it('H. refuses a student', async () => {
      const res = await f
        .t.http()
        .post('/v1/admin/ingestion/assets')
        .set(...bearer(f.student))
        .set('Content-Type', 'application/pdf')
        .send(TEXTBOOK);
      expect(res.status).toBe(403);
    });

    it('H. refuses an unauthenticated caller', async () => {
      const res = await f.t.http().post('/v1/admin/ingestion/assets').set('Content-Type', 'application/pdf').send(TEXTBOOK);
      expect(res.status).toBe(401);
    });

    it('H. never lets a student reach a job or its blocks', async () => {
      const own = await setup();
      try {
        const { jobId } = await ingest(own);
        for (const path of [`/v1/admin/ingestion/jobs/${jobId}`, `/v1/admin/ingestion/jobs/${jobId}/blocks`, '/v1/admin/ingestion/jobs']) {
          expect((await own.t.http().get(path).set(...bearer(own.student))).status).toBe(403);
        }
      } finally {
        await own.t.close();
      }
    });

    it('rate-limits uploads on the stricter bucket (section 18)', async () => {
      const limited = await setup({ env: { AUTH_THROTTLE_LIMIT: '2', THROTTLE_TTL_SECONDS: '60' } });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          const res = await upload(limited, makePdf({ pages: [`Rate limit probe number ${i} with enough text to be a block of theory.`] }));
          statuses.push(res.status);
        }
        expect(statuses).toContain(429);
        await limited.queue.drain();
      } finally {
        await limited.t.close();
      }
    });

    it('G. never lets one organisation see another organisation’s job', async () => {
      const [mine, other] = await Promise.all([setup(), setup()]);
      try {
        const { jobId } = await ingest(mine);
        const res = await other.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...bearer(other.admin));
        expect(res.status).toBe(404);
        // And the reviewer who owns it still can.
        expect((await mine.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...bearer(mine.admin))).status).toBe(200);
      } finally {
        await Promise.all([mine.t.close(), other.t.close()]);
      }
    });
  });

  // ---------------------------------------------------------------- the pipeline

  describe('I-T. the job runs the stages and records what it found', () => {
    // Its own organisation, because these assertions describe one document's output exactly and a
    // tenant shared with the upload tests would already hold the same bytes.
    let own: Fixture;
    let result: { jobId: string; job: Json; blocks: Json[] };

    beforeAll(async () => {
      own = await setup();
      result = await ingest(own);
    });
    afterAll(async () => {
      await own.t.close();
    });

    it('the job stages are observable: stage, progress and counts (section 3)', () => {
      expect(result.job.job.status).toBe('awaiting_review');
      expect(result.job.job.progressPct).toBeGreaterThan(90);
      expect(result.job.job.attemptCount).toBe(1);
      expect(result.job.job.pagesTotal).toBe(2);
      expect(result.job.job.errorCode).toBeNull();
      expect(result.job.job.blocks).toMatchObject({ question: 2, solution: 2 });
    });

    it('I. read both pages from the text layer, with no OCR', async () => {
      expect(result.job.job.pagesOcr).toBe(0);
      const { rows } = await db().query<{ page_number: number; method: string; char_count: number }>(
        `SELECT page_number, method, char_count FROM extracted_pages WHERE job_id = $1 ORDER BY page_number`,
        [result.jobId],
      );
      expect(rows.map((r) => r.method)).toEqual(['text_layer', 'text_layer']);
      expect(rows[0]!.char_count).toBeGreaterThan(100);
    });

    it('K/L. classified the page into theory, questions and solutions, each with its provenance', () => {
      expect(result.blocks.map((b) => b.kind)).toEqual(['theory', 'theory', 'question', 'question', 'theory', 'solution', 'solution']);
      for (const block of result.blocks) {
        expect(block.sourcePage).toBeGreaterThanOrEqual(1);
        expect(block.classificationConfidence).toBeGreaterThan(0);
        expect(block.machineNotes.classification.reason).toMatch(/\S/);
        expect(block.fromOcr).toBe(false);
      }
      expect(result.blocks.map((b) => b.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('N. mapped the content to the existing sub-topic, with a confidence and a reason', () => {
      const theory = result.blocks[1]!;
      expect(theory.subtopicId).toBe(own.syllabus.subtopicId);
      expect(theory.taggingConfidence).toBeGreaterThanOrEqual(0.6);
      expect(theory.machineNotes.mapping.reason).toContain('Angular Momentum');
    });

    it('O. proposed a name for content nothing fits, and created no syllabus node', async () => {
      const unmapped = result.blocks.find((b) => b.subtopicId === null);
      expect(unmapped).toBeDefined();
      expect(unmapped!.machineNotes.mapping.proposedSubtopicName).toMatch(/\S/);

      const tasks = (result.job.reviewTasks as Json[]).filter((task) => task.suggestion?.unmapped === true);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]!.suggestion.proposedSubtopicName).toMatch(/\S/);
      // `content_gap` is the schema's name for a sub-topic short of questions, not for this.
      expect((result.job.reviewTasks as Json[]).every((task) => task.kind !== 'content_gap')).toBe(true);

      const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM subtopics WHERE tenant_id = $1`, [own.tenant.id]);
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it('P/Q/T. read both questions, their options, their answers and the stated difficulty', () => {
      const [first, second] = kindOf(result.blocks, 'question');
      expect(first!.question).toMatchObject({ type: 'single_correct', difficultyLabel: 3, sourceDifficulty: 'moderate' });
      expect(first!.question.stem).toBe(QUESTION_ONE_STEM);
      expect(first!.question.options.map((o: Json) => o.key)).toEqual(['A', 'B', 'C', 'D']);
      expect(first!.question.options.filter((o: Json) => o.isCorrect).map((o: Json) => o.key)).toEqual(['B']);
      expect(second!.question).toMatchObject({ type: 'integer', difficultyLabel: 2 });
      expect(second!.question.numericAnswer).toMatchObject({ value: '12' });
      expect(second!.question.expectedTimeSeconds).toBeNull();
    });

    it('R. matched each solution to its question and recorded the evidence on both', async () => {
      const questions = kindOf(result.blocks, 'question');
      const solutions = kindOf(result.blocks, 'solution');
      for (const question of questions) {
        expect(question.machineNotes).toBeDefined();
      }
      const matched = solutions.map((s) => s.machineNotes);
      expect(matched).toHaveLength(2);

      // The question block carries the solution it will be published with.
      const { rows } = await db().query<{ content_json: Json }>(
        `SELECT content_json FROM content_blocks WHERE job_id = $1 AND kind = 'question' ORDER BY sort_order`,
        [result.jobId],
      );
      for (const row of rows) {
        expect(row.content_json.solution.confirmed).toBe(true);
        expect(row.content_json.solution.confidence).toBeGreaterThanOrEqual(0.6);
        expect(row.content_json.solution.text).toMatch(/^Solution \d/);
      }
    });

    it('records the gates and the auto-approval verdict on every block, whichever way it went', () => {
      for (const block of result.blocks) {
        expect(block.machineNotes.autoApproval).toBeDefined();
        expect(typeof block.machineNotes.autoApproval.reason).toBe('string');
      }
    });

    it('AF. writes one audit row for the processed job', async () => {
      expect(await auditActions(own.tenant.id, result.jobId)).toContain('ingestion_job.processed');
    });
  });

  describe('J. OCR is the fallback, and its absence is reported rather than hidden', () => {
    let own: Fixture;

    beforeAll(async () => {
      own = await setup();
    });
    afterAll(async () => {
      await own.t.close();
    });

    it('J. records a page with no usable text layer and sends it to review', async () => {
      // A page with almost no text: the extractor reports it thin, and with OCR_PROVIDER=none the
      // pipeline cannot read it another way.
      const { job, blocks } = await ingest(own, makePdf({ pages: ['x'] }));
      expect(job.job.pagesOcr).toBe(0);
      const tasks = (job.reviewTasks as Json[]).filter((task) => task.suggestion?.stage === 'ocr');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.reason).toMatch(/no OCR provider is configured/);
      expect(tasks[0]!.suggestion.pageNumber).toBe(1);
      // The page is still recorded, with its text, rather than dropped.
      const { rows } = await db().query<{ text_content: string }>(`SELECT text_content FROM extracted_pages WHERE job_id = $1`, [job.job.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text_content).toBe('x');
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('J. does not send a page with a good text layer to OCR at all', async () => {
      const { job } = await ingest(own, makePdf({ pages: [QUESTIONS_PAGE, SOLUTIONS_PAGE] }));
      expect(job.job.pagesOcr).toBe(0);
      expect((job.reviewTasks as Json[]).filter((task) => task.suggestion?.stage === 'ocr')).toHaveLength(0);
    });
  });

  describe('U. near-duplicate questions are flagged, and nothing is deleted', () => {
    it('opens a duplicate task naming the existing question and keeps the new block', async () => {
      const own = await setup();
      try {
        const existing = await insertPracticeQuestion(own.tenant, own.syllabus.subtopicId, { stem: QUESTION_ONE_STEM });
        const { job, blocks } = await ingest(own);
        const tasks = (job.reviewTasks as Json[]).filter((task) => task.kind === 'duplicate_candidate');
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks[0]!.reason).toMatch(/similarity/);
        expect(tasks[0]!.suggestion.similarity).toBeGreaterThanOrEqual(0.85);

        // The source is kept: the duplicate is a warning, not a deletion.
        expect(kindOf(blocks, 'question').length).toBe(2);
        const { rows } = await db().query(`SELECT 1 FROM questions WHERE id = $1 AND deleted_at IS NULL`, [existing]);
        expect(rows).toHaveLength(1);
      } finally {
        await own.t.close();
      }
    });
  });

  // ---------------------------------------------------------------- review

  describe('X-AC/AF/AG. the six review actions, all audited', () => {
    let own: Fixture;
    let blocks: Json[];
    let jobId: string;

    beforeEach(async () => {
      own = await setup();
      const result = await ingest(own);
      blocks = result.blocks;
      jobId = result.jobId;
    });
    afterEach(async () => {
      await own.t.close();
    });

    const act = (path: string, body: Record<string, unknown> = {}) =>
      own
        .t.http()
        .post(path)
        .set(...bearer(own.admin))
        .send(body);

    it('X. approves a block and resolves the tasks that named it', async () => {
      const block = blocks[1]!;
      const res = await act(`/v1/admin/ingestion/blocks/${block.id}/approve`, { note: 'reads correctly' });
      expect(res.status).toBe(200);
      expect((res.body as Json).status).toBe('approved');
      expect((res.body as Json).reviewedBy).toBe(own.admin.body.userId ?? (res.body as Json).reviewedBy);
      expect(await auditActions(own.tenant.id, block.id as string)).toContain('content_block.approved');
    });

    it('M/AA. refuses to approve an ambiguous block until it has been reclassified', async () => {
      const { blocks: odd } = await ingest(own, makePdf({ pages: ['3. Thermodynamic Processes'] }));
      const ambiguous = odd.find((b) => b.kind === 'ambiguous')!;
      expect(ambiguous).toBeDefined();
      const refused = await act(`/v1/admin/ingestion/blocks/${ambiguous.id}/approve`);
      expect(refused.status).toBe(422);
      expect((refused.body as Json).error.code).toBe('NOT_PUBLISHABLE');

      const reclassified = await act(`/v1/admin/ingestion/blocks/${ambiguous.id}/reclassify`, { kind: 'theory', note: 'a section heading' });
      expect(reclassified.status).toBe(200);
      expect(reclassified.body).toMatchObject({ kind: 'theory', classificationConfidence: 1, status: 'needs_review' });
      expect((await act(`/v1/admin/ingestion/blocks/${ambiguous.id}/approve`)).status).toBe(200);
      expect(await auditActions(own.tenant.id, ambiguous.id as string)).toContain('content_block.reclassified');
    });

    it('Z. rejects a block only with a reason, and keeps the content', async () => {
      const block = blocks[1]!;
      const noReason = await act(`/v1/admin/ingestion/blocks/${block.id}/reject`);
      expect(noReason.status).toBe(400);

      const rejected = await act(`/v1/admin/ingestion/blocks/${block.id}/reject`, { note: 'garbled in the source' });
      expect(rejected.status).toBe(200);
      expect((rejected.body as Json).status).toBe('rejected');

      const { rows } = await db().query<{ status: string; raw_text: string }>(
        `SELECT status, raw_text FROM content_blocks WHERE id = $1 AND deleted_at IS NULL`,
        [block.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.raw_text.length).toBeGreaterThan(0);
    });

    it('Y. edits a block, and every call is a save', async () => {
      const block = kindOf(blocks, 'question')[0]!;
      const first = await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ text: 'A corrected stem for the question, typed by the reviewer.' });
      expect(first.status).toBe(200);
      expect((first.body as Json).text).toContain('corrected stem');
      expect((first.body as Json).reviewedBy).not.toBeNull();

      const second = await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ question: { difficultyLabel: 4, expectedTimeSeconds: 150 } });
      expect(second.status).toBe(200);
      expect((second.body as Json).question).toMatchObject({ difficultyLabel: 4, expectedTimeSeconds: 150, editedByReviewer: true });
      expect((second.body as Json).text).toContain('corrected stem');
      expect(await auditActions(own.tenant.id, block.id as string)).toContain('content_block.edited');
    });

    it('Y/G. refuses an edit that points at a sub-topic this organisation does not have', async () => {
      const block = blocks[1]!;
      const res = await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ subtopicId: '11111111-1111-4111-8111-111111111111' });
      expect(res.status).toBe(422);
      expect((res.body as Json).error.code).toBe('REFERENCE_NOT_FOUND');
    });

    it('AB. merges blocks into the first and keeps the sources pointing at it', async () => {
      const [a, b] = [blocks[0]!, blocks[1]!];
      const res = await act('/v1/admin/ingestion/blocks/merge', { blockIds: [a.id, b.id] });
      expect(res.status).toBe(200);
      expect((res.body as Json).text).toContain(String(b.text).slice(0, 30));

      const { rows } = await db().query<{ id: string; status: string; merged_into_id: string | null }>(
        `SELECT id, status, merged_into_id FROM content_blocks WHERE id = ANY($1::uuid[]) ORDER BY sort_order`,
        [[a.id, b.id]],
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === b.id)).toMatchObject({ status: 'superseded', merged_into_id: a.id });
      expect(await auditActions(own.tenant.id, a.id as string)).toContain('content_block.merged');
    });

    it('AC. splits a block into pieces that remember where they came from', async () => {
      const block = blocks[1]!;
      const res = await act(`/v1/admin/ingestion/blocks/${block.id}/split`, {
        pieces: [
          { text: 'The first half of what was one block, long enough to stand alone.', kind: 'theory' },
          { text: 'The second half of what was one block, also long enough to stand.', kind: 'theory' },
        ],
      });
      expect(res.status).toBe(201);
      const pieces = res.body as Json[];
      expect(pieces).toHaveLength(2);
      for (const piece of pieces) {
        expect(piece.splitFromId).toBe(block.id);
        expect(piece.sourcePage).toBe(block.sourcePage);
        expect(piece.question).toBeNull();
      }

      const { rows } = await db().query<{ status: string }>(`SELECT status FROM content_blocks WHERE id = $1`, [block.id]);
      expect(rows[0]!.status).toBe('superseded');
      expect(await auditActions(own.tenant.id, block.id as string)).toContain('content_block.split');
    });

    it('AG. re-running the job replaces the machine’s work and keeps the reviewer’s', async () => {
      const edited = kindOf(blocks, 'question')[0]!;
      await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${edited.id}`)
        .set(...bearer(own.admin))
        .send({ text: 'Text a person typed, which a re-run must not touch.' });

      const before = await db().query<{ n: string }>(`SELECT count(*) AS n FROM extracted_pages WHERE job_id = $1`, [jobId]);
      const retry = await act(`/v1/admin/ingestion/jobs/${jobId}/retry`);
      expect(retry.status).toBe(202);
      await own.queue.drain();

      const after = await db().query<{ n: string }>(`SELECT count(*) AS n FROM extracted_pages WHERE job_id = $1`, [jobId]);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

      const survivor = await db().query<{ normalized_text: string; status: string }>(
        `SELECT normalized_text, status FROM content_blocks WHERE id = $1`,
        [edited.id],
      );
      expect(survivor.rows[0]!.normalized_text).toBe('Text a person typed, which a re-run must not touch.');

      const job = await own.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...bearer(own.admin));
      expect((job.body as Json).job.attemptCount).toBe(2);
      expect((job.body as Json).job.status).toBe('awaiting_review');
      expect(await auditActions(own.tenant.id, jobId)).toContain('ingestion_job.retried');
    });

    it('AG. a re-run does not hand the reviewer a second copy of what they already fixed', async () => {
      const edited = kindOf(blocks, 'question')[0]!;
      const approved = blocks[1]!;
      await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${edited.id}`)
        .set(...bearer(own.admin))
        .send({ text: 'A stem the reviewer rewrote, which the source document does not contain.' });
      await act(`/v1/admin/ingestion/blocks/${approved.id}/approve`, { note: 'fine as it is' });

      const countBlocks = async () =>
        Number((await db().query<{ n: string }>(`SELECT count(*) AS n FROM content_blocks WHERE job_id = $1`, [jobId])).rows[0]!.n);
      const before = await countBlocks();

      await act(`/v1/admin/ingestion/jobs/${jobId}/retry`);
      await own.queue.drain();

      // Nothing new: every block this document produces is already there, in the state a person
      // left it. An edited block is matched by the hash it had before the edit.
      expect(await countBlocks()).toBe(before);
      const survivor = await db().query<{ normalized_text: string }>(`SELECT normalized_text FROM content_blocks WHERE id = $1`, [edited.id]);
      expect(survivor.rows[0]!.normalized_text).toContain('the reviewer rewrote');
      const stillApproved = await db().query<{ status: string }>(`SELECT status FROM content_blocks WHERE id = $1`, [approved.id]);
      expect(stillApproved.rows[0]!.status).toBe('approved');
    });

    it('X. lets an approval be undone inside the window and not after it', async () => {
      const block = blocks[1]!;
      expect((await act(`/v1/admin/ingestion/blocks/${block.id}/approve`)).status).toBe(200);
      const inside = await act(`/v1/admin/ingestion/blocks/${block.id}/reject`, { note: 'looked again' });
      expect(inside.status).toBe(200);

      // Approve again, then move the approval outside the configured window.
      expect((await act(`/v1/admin/ingestion/blocks/${block.id}/approve`)).status).toBe(200);
      await db().query(`UPDATE content_blocks SET reviewed_at = now() - interval '48 hours' WHERE id = $1`, [block.id]);
      const outside = await act(`/v1/admin/ingestion/blocks/${block.id}/reject`, { note: 'too late' });
      expect(outside.status).toBe(409);
      expect((outside.body as Json).error.message).toMatch(/24-hour window|window in which/);
    });
  });

  // ---------------------------------------------------------------- publication

  describe('AD/AE/V/W. publication is gated, and only published content reaches a student', () => {
    let own: Fixture;
    let blocks: Json[];

    beforeEach(async () => {
      own = await setup();
      blocks = (await ingest(own)).blocks;
    });
    afterEach(async () => {
      await own.t.close();
    });

    const publish = (id: string) =>
      own
        .t.http()
        .post(`/v1/admin/ingestion/blocks/${id}/publish`)
        .set(...bearer(own.admin));

    it('AD. refuses to publish a block that fails a gate, and lists every failure', async () => {
      const heading = blocks[0]!;
      const res = await publish(heading.id as string);
      expect(res.status).toBe(422);
      expect((res.body as Json).error.code).toBe('NOT_PUBLISHABLE');
      expect(((res.body as Json).error.details as Json[]).length).toBeGreaterThan(0);
    });

    it('AD. refuses to publish a solution block as content in its own right', async () => {
      const solution = kindOf(blocks, 'solution')[0]!;
      const res = await publish(solution.id as string);
      expect(res.status).toBe(422);
      expect(((res.body as Json).error.details as Json[]).some((d) => d.field === 'block_kind')).toBe(true);
    });

    it('AE. publishes a question through the Phase 3 service, with its solution and difficulty', async () => {
      const block = kindOf(blocks, 'question')[0]!;
      await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ question: { expectedTimeSeconds: 120 } });

      const res = await publish(block.id as string);
      expect(res.status).toBe(200);
      const questionId = (res.body as Json).questionId as string;
      expect(questionId).toMatch(/[0-9a-f-]{36}/);

      const admin = await own.t.http().get(`/v1/admin/questions/${questionId}`).set(...bearer(own.admin));
      expect(admin.status).toBe(200);
      expect(admin.body).toMatchObject({ status: 'published', type: 'single_correct', difficultyLabel: 3, subtopicId: own.syllabus.subtopicId });
      expect((admin.body as Json).stem).toBe(QUESTION_ONE_STEM);
      expect((admin.body as Json).options.filter((o: Json) => o.isCorrect).map((o: Json) => o.key)).toEqual(['B']);
      // The difficulty the engine serves comes from the active configuration, not from this phase.
      expect((admin.body as Json).difficultyB).toBe(1200);
      expect((admin.body as Json).officialSolution.body).toMatch(/^Solution 1/);
      expect(await auditActions(own.tenant.id, block.id as string)).toContain('content_block.published');
    });

    /**
     * Regression test. Publishing used to read the block, create the question, then mark the block
     * published — so two concurrent publishes both passed the read and both created a question. The
     * second one left a duplicate in the bank and overwrote the first question's id on the block,
     * which is how a question ends up in the bank with nothing pointing at it. The status is now
     * claimed by a conditional UPDATE before any question is created.
     */
    it('publishes a block once even when two requests arrive together', async () => {
      const block = kindOf(blocks, 'question')[1]!;
      await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ question: { expectedTimeSeconds: 120 } });

      const countQuestions = async () => {
        const { rows } = await db().query<{ n: string }>(
          `SELECT count(*) AS n FROM questions WHERE tenant_id = $1 AND deleted_at IS NULL`,
          [own.tenant.id],
        );
        return Number(rows[0]!.n);
      };
      const before = await countQuestions();

      const [a, b] = await Promise.all([publish(block.id as string), publish(block.id as string)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      // One question, not two. This is the assertion that failed before the claim was made atomic.
      expect(await countQuestions()).toBe(before + 1);

      const winner = (a.status === 200 ? a : b).body as Json;
      const { rows: blockRows } = await db().query<{ status: string; published_question_id: string | null }>(
        `SELECT status, content_json #>> '{publishedQuestionId}' AS published_question_id
           FROM content_blocks WHERE id = $1`,
        [block.id],
      );
      expect(blockRows[0]!.status).toBe('published');
      expect(blockRows[0]!.published_question_id).toBe(winner.questionId);
    });

    it('refuses to publish a block that is already published', async () => {
      const block = kindOf(blocks, 'question')[0]!;
      await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ question: { expectedTimeSeconds: 120 } });
      expect((await publish(block.id as string)).status).toBe(200);
      const again = await publish(block.id as string);
      expect(again.status).toBe(409);
    });

    it('AE. a student sees the published question, without the answer key', async () => {
      const block = kindOf(blocks, 'question')[0]!;
      await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ question: { expectedTimeSeconds: 120 } });
      const questionId = ((await publish(block.id as string)).body as Json).questionId as string;

      const started = await own
        .t.http()
        .post('/v1/practice/sessions')
        .set(...bearer(own.student))
        .send({ subtopicId: own.syllabus.subtopicId });
      expect(started.status).toBe(201);
      const sessionId = ((started.body as Json).session as Json).id as string;
      const next = await own.t.http().get(`/v1/practice/sessions/${sessionId}/next`).set(...bearer(own.student));
      expect(next.status).toBe(200);
      const served = (next.body as Json).question as Json;
      expect(served.id).toBe(questionId);
      expect(JSON.stringify(served)).not.toMatch(/isCorrect|officialSolution|Solution 1/);
      expect(served.options.map((o: Json) => o.key).sort()).toEqual(['A', 'B', 'C', 'D']);
    });

    it('AE. a student never sees content that has not been published', async () => {
      // Every block from the upload is sitting in review. None of it has reached a student.
      const started = await own
        .t.http()
        .post('/v1/practice/sessions')
        .set(...bearer(own.student))
        .send({ subtopicId: own.syllabus.subtopicId });
      expect(started.status).toBe(201);
      const sessionId = ((started.body as Json).session as Json).id as string;
      const next = await own.t.http().get(`/v1/practice/sessions/${sessionId}/next`).set(...bearer(own.student));
      // There is no published question to serve, and nothing is invented to fill the gap.
      expect(next.status).not.toBe(200);

      const theory = await own.t.http().get(`/v1/subtopics/${own.syllabus.subtopicId}/theory`).set(...bearer(own.student));
      expect(theory.status).toBe(200);
      expect((theory.body as Json).blocks).toHaveLength(0);
      expect(JSON.stringify(theory.body)).not.toMatch(/angular momentum of a rigid body/i);
    });

    it('V/W. publishes theory, and reports that it could not be embedded on this server', async () => {
      const paragraph = blocks[1]!;
      await own
        .t.http()
        .post(`/v1/admin/ingestion/blocks/${paragraph.id}/approve`)
        .set(...bearer(own.admin))
        .send({});
      const res = await publish(paragraph.id as string);
      expect(res.status).toBe(200);
      expect((res.body as Json).published).toBe(true);
      // pgvector is not installed here, so the embedding is reported as not done, never as done.
      expect((res.body as Json).embeddings).toMatchObject({ attempted: true, embedded: null });
      expect((res.body as Json).embeddings.note).toMatch(/pgvector|AI_|embedding/i);

      const theory = await own.t.http().get(`/v1/subtopics/${own.syllabus.subtopicId}/theory`).set(...bearer(own.student));
      expect(theory.status).toBe(200);
      expect((theory.body as Json).blocks).toHaveLength(1);
      expect(JSON.stringify(theory.body)).toContain('angular momentum of a rigid body');
    });

    it('AE. unpublishing retires the question rather than deleting it', async () => {
      const block = kindOf(blocks, 'question')[0]!;
      await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${block.id}`)
        .set(...bearer(own.admin))
        .send({ question: { expectedTimeSeconds: 120 } });
      const questionId = ((await publish(block.id as string)).body as Json).questionId as string;

      const res = await own
        .t.http()
        .post(`/v1/admin/ingestion/blocks/${block.id}/unpublish`)
        .set(...bearer(own.admin))
        .send({ note: 'wrong chapter' });
      expect(res.status).toBe(200);
      expect((res.body as Json).published).toBe(false);

      const admin = await own.t.http().get(`/v1/admin/questions/${questionId}`).set(...bearer(own.admin));
      expect((admin.body as Json).status).toBe('retired');
      expect(await auditActions(own.tenant.id, block.id as string)).toContain('content_block.unpublished');
    });

    it('refuses to edit a published block until it is unpublished', async () => {
      const paragraph = blocks[1]!;
      await own
        .t.http()
        .post(`/v1/admin/ingestion/blocks/${paragraph.id}/approve`)
        .set(...bearer(own.admin))
        .send({});
      await publish(paragraph.id as string);
      const res = await own
        .t.http()
        .patch(`/v1/admin/ingestion/blocks/${paragraph.id}`)
        .set(...bearer(own.admin))
        .send({ text: 'a late change' });
      expect(res.status).toBe(409);
    });
  });

  // ---------------------------------------------------------------- auto-approval

  describe('AH/AI. auto-approval only ever loosens who has to look, never what may publish', () => {
    it('starts a high-confidence theory block approved when the floor allows it', async () => {
      const own = await setup({ params: { ingestion: { auto_approval: { min_confidence: 0.5 } } } });
      try {
        const { blocks } = await ingest(own);
        const theory = blocks[1]!;
        expect(theory.kind).toBe('theory');
        expect(theory.status).toBe('approved');
        expect(theory.autoApprovalEligible).toBe(true);
        // Approved by a rule, not by a person: `reviewedBy` stays empty, which is what the audit
        // sampling and the OCR rule are there to compensate for.
        expect(theory.reviewedBy).toBeNull();
      } finally {
        await own.t.close();
      }
    });

    it('never auto-approves a question, because nothing in the source says how long it should take', async () => {
      const own = await setup({ params: { ingestion: { auto_approval: { min_confidence: 0.1 } } } });
      try {
        const { blocks } = await ingest(own);
        for (const question of kindOf(blocks, 'question')) {
          expect(question.status).toBe('needs_review');
          expect(question.autoApprovalEligible).toBe(false);
          expect(question.gateFailures.map((f: Json) => f.gate)).toContain('expected_time');
          expect(question.question.expectedTimeSeconds).toBeNull();
        }
      } finally {
        await own.t.close();
      }
    });

    it('AH. holds Olympiad L5 content for a person, and says that is why', async () => {
      const own = await setup({ params: { ingestion: { auto_approval: { min_confidence: 0.5 } } } });
      try {
        await db().query(`UPDATE tracks SET slug = 'physics-olympiad' WHERE id = $1`, [own.syllabus.trackId]);
        // The theory blocks of an Olympiad document are the ones that would otherwise be eligible.
        const olympiad = [QUESTIONS_PAGE.split('\n\n')[0], '', QUESTIONS_PAGE.split('\n\n')[1], '', '1. A ring rolls without slipping. Find its angular momentum.', '(A) 1', '(B) 2', 'Answer: B', 'Difficulty: L5'].join('\n');
        const { blocks } = await ingest(own, makePdf({ pages: [olympiad] }));
        const question = kindOf(blocks, 'question').find((b) => b.question?.difficultyLabel === 5);
        expect(question).toBeDefined();
        expect(question!.status).toBe('needs_review');
        expect(question!.machineNotes.autoApproval.autoApprove).toBe(false);
      } finally {
        await own.t.close();
      }
    });

    it('leaves everything for review when auto-approval is switched off', async () => {
      const own = await setup({ params: { ingestion: { auto_approval: { enabled: false, min_confidence: 0.1 } } } });
      try {
        const { blocks } = await ingest(own);
        expect(blocks.every((b) => b.status === 'needs_review')).toBe(true);
      } finally {
        await own.t.close();
      }
    });
  });

  // ---------------------------------------------------------------- failure reporting

  describe('AG. a failure is recorded on the job, with a stable code', () => {
    it('records why a job could not run when its stored object has gone', async () => {
      const own = await setup();
      try {
        const created = await upload(own, makePdf({ pages: [QUESTIONS_PAGE] }));
        const { jobId, storageKey } = created.body as Json;
        await own.queue.drain();
        // Remove the bytes, then re-run: the pipeline must report it rather than crash the runner.
        await own.storage.delete(storageKey as string);
        await own
          .t.http()
          .post(`/v1/admin/ingestion/jobs/${jobId}/retry`)
          .set(...bearer(own.admin));
        await own.queue.drain();

        const job = await own.t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...bearer(own.admin));
        expect((job.body as Json).job.status).toBe('failed');
        expect((job.body as Json).job.errorCode).toBe('asset_unreadable');
        expect((job.body as Json).job.errorMessage).toMatch(/\S/);
        expect((job.body as Json).job.finishedAt).not.toBeNull();
        expect(await auditActions(own.tenant.id, jobId as string)).toContain('ingestion_job.failed');
      } finally {
        await own.t.close();
      }
    });

    it('refuses to re-run a job whose questions have already been published', async () => {
      const own = await setup();
      try {
        const { jobId } = await ingest(own);
        await db().query(`UPDATE ingestion_jobs SET status = 'published', progress_pct = 100, finished_at = now() WHERE id = $1`, [jobId]);
        const res = await own
          .t.http()
          .post(`/v1/admin/ingestion/jobs/${jobId}/retry`)
          .set(...bearer(own.admin));
        expect(res.status).toBe(409);
      } finally {
        await own.t.close();
      }
    });

    it('lists this organisation’s jobs, newest first, and filters by stage', async () => {
      const own = await setup();
      try {
        await ingest(own);
        const all = await own.t.http().get('/v1/admin/ingestion/jobs').set(...bearer(own.admin));
        expect(all.status).toBe(200);
        expect(((all.body as Json).items as Json[]).length).toBeGreaterThan(0);

        const filtered = await own.t.http().get('/v1/admin/ingestion/jobs?status=awaiting_review&limit=5').set(...bearer(own.admin));
        expect(((filtered.body as Json).items as Json[]).every((j) => j.status === 'awaiting_review')).toBe(true);

        const bad = await own.t.http().get('/v1/admin/ingestion/jobs?status=nonsense').set(...bearer(own.admin));
        expect(bad.status).toBe(400);
      } finally {
        await own.t.close();
      }
    });
  });
});
