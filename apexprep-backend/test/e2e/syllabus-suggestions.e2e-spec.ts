import { AI_PRIMARY_PROVIDER } from '../../src/ai/ai-provider';
import { JOB_QUEUE, type JobQueue } from '../../src/ingestion/job-queue';
import { makePdf } from '../fixtures/make-pdf';
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
  login,
  uniq,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
} from './helpers';
import { FakeAiProvider } from './fake-ai';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Upload → detect the PDF's own chapter/topic/sub-topic headings → structured suggestion → admin
 * approval → nodes created → blocks filed → normal approve/publish → a student reads the theory.
 *
 * Real PDFs, the real pipeline, the real database. The fixture syllabus is
 * Physics › Mechanics › Rotational Dynamics › Angular Momentum (all published).
 */

/** Three levels, none of which exist in the fixture subject. */
const MOTION = [
  '3 Motion',
  '',
  'Motion is a change in the position of a body with time.',
  '',
  '3.1 Distance and Displacement',
  '',
  'Distance is the length of the path travelled by a body.',
  '',
  '3.1.1 Average Speed',
  '',
  'Average speed is the total distance travelled divided by the total time taken for the journey.',
].join('\n');

/** Three levels that all exist already. */
const EXISTING = [
  '1 Mechanics',
  '',
  '1.1 Rotational Dynamics',
  '',
  '1.1.1 Angular Momentum',
  '',
  'Angular momentum is conserved when no external torque acts on a rotating system.',
].join('\n');

/** Chapter and topic exist; the sub-topic is new. */
const TORQUE = [
  '1 Mechanics',
  '',
  '1.1 Rotational Dynamics',
  '',
  '1.1.2 Torque',
  '',
  'Torque is the turning effect of a force about an axis of rotation.',
].join('\n');

/** No numbered or chapter structure: nothing may be proposed from it. */
const UNSTRUCTURED = ['Friction', '', 'Friction opposes the relative motion between two surfaces in contact.'].join('\n');

interface Fixture {
  t: TestApp;
  tenant: TenantFixture;
  syllabus: SyllabusFixture;
  admin: Session;
  student: Session;
  queue: JobQueue;
}

async function setup(): Promise<Fixture> {
  const t = await createTestApp();
  const tenant = await createTenant();
  const [adminUser, studentUser, syllabus] = await Promise.all([createUser(tenant, 'ADMIN'), createUser(tenant, 'STUDENT'), createSyllabus(tenant)]);
  await createEngineConfig(tenant);
  const [admin, student] = await Promise.all([login(t, adminUser, tenant.slug), login(t, studentUser, tenant.slug)]);
  return { t, tenant, syllabus, admin, student, queue: t.app.get<JobQueue>(JOB_QUEUE) };
}

describe('syllabus suggestions (e2e)', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f.t.close();
    await closeDb();
  });

  const http = () => f.t.http();
  /** Uploads a PDF for the fixture track + subject only — no chapter, topic or sub-topic is chosen. */
  async function ingest(text: string, opts: { subject?: boolean; salt?: string } = {}): Promise<{ jobId: string; job: Json; blocks: Json[] }> {
    // The salt makes otherwise-identical test PDFs distinct files (an identical file is refused as a duplicate).
    const body = makePdf({ pages: [`${text}\n\nReference ${opts.salt ?? uniq('ref')}.`] });
    const query = opts.subject === false ? '' : `?trackId=${f.syllabus.trackId}&subjectId=${f.syllabus.subjectId}`;
    const created = await http().post(`/v1/admin/ingestion/assets${query}`).set(...bearer(f.admin)).set('Content-Type', 'application/pdf').send(body);
    expect(created.status).toBe(201);
    const jobId = (created.body as Json).jobId as string;
    await f.queue.drain();
    const [job, blocks] = await Promise.all([
      http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...bearer(f.admin)),
      http().get(`/v1/admin/ingestion/jobs/${jobId}/blocks`).set(...bearer(f.admin)),
    ]);
    expect((job.body as Json).job.status).toBe('awaiting_review');
    return { jobId, job: (job.body as Json).job as Json, blocks: blocks.body as Json[] };
  }
  const suggestionsOf = async (jobId: string): Promise<Json> => {
    const res = await http().get(`/v1/admin/ingestion/jobs/${jobId}/suggestions`).set(...bearer(f.admin));
    expect(res.status).toBe(200);
    return res.body as Json;
  };
  const fullPath = (list: Json, subtopic: string): Json => (list.suggestions as Json[]).find((s) => s.subtopic.name === subtopic)!;
  const nodesNamed = async (table: 'chapters' | 'topics' | 'subtopics', name: string): Promise<Json[]> =>
    (await db().query(`SELECT id, name, status FROM ${table} WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`, [f.tenant.id, name])).rows;

  describe('all three levels missing: upload → suggestion → approve → publish → student reads it', () => {
    let jobId: string;
    let blocks: Json[];
    let suggestion: Json;

    it('detects the hierarchy from the PDF and proposes it, creating no syllabus node', async () => {
      ({ jobId, blocks } = await ingest(MOTION));
      const list = await suggestionsOf(jobId);
      expect(list.hierarchy).toMatchObject({ status: 'detected', method: 'numbered' });
      suggestion = fullPath(list, 'Average Speed');
      expect(suggestion).toMatchObject({
        status: 'pending',
        trackId: f.syllabus.trackId,
        subjectId: f.syllabus.subjectId,
        subjectName: 'Physics',
        chapter: { name: 'Motion', state: 'new' },
        topic: { name: 'Distance and Displacement', state: 'new' },
        subtopic: { name: 'Average Speed', state: 'new' },
        needsNames: false,
      });
      expect(suggestion.chapter.evidence).toMatchObject({ heading: '3 Motion', page: 1 });
      expect(suggestion.linkedBlocks).toBeGreaterThan(0);
      // A suggestion is not a node.
      expect(await nodesNamed('chapters', 'Motion')).toEqual([]);
      expect(await nodesNamed('subtopics', 'Average Speed')).toEqual([]);
    });

    it('the waiting blocks show their evidence, stay unmapped, are not auto-approved and cannot be published', async () => {
      const block = blocks.find((b) => String(b.text).includes('Average speed is'))!;
      expect(block).toMatchObject({
        subtopicId: null,
        status: 'needs_review',
        suggestionId: suggestion.id,
        suggestedChapter: 'Motion',
        suggestedTopic: 'Distance and Displacement',
        suggestedSubtopic: 'Average Speed',
        existingChapterId: null,
      });
      expect(block.mappingReason).toMatch(/needs the suggested syllabus to be approved/);
      const publish = await http().post(`/v1/admin/ingestion/blocks/${block.id}/publish`).set(...bearer(f.admin)).send({});
      expect(publish.status).not.toBe(200);
      const tasks = (await db().query(`SELECT reason, suggestion FROM review_tasks WHERE content_block_id = $1 AND status = 'open'`, [block.id])).rows;
      expect(tasks.some((t) => /waiting for approval of the suggested syllabus: Motion › Distance and Displacement › Average Speed/.test(t.reason as string))).toBe(true);
    });

    it('a level the PDF does not state is unresolved, and approving needs it named', async () => {
      const chapterOnly = ((await suggestionsOf(jobId)).suggestions as Json[]).find((s) => s.topic.state === 'unresolved')!;
      expect(chapterOnly).toMatchObject({ chapter: { name: 'Motion' }, subtopic: { state: 'unresolved' }, needsNames: true });
      const res = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${chapterOnly.id}/approve`).set(...bearer(f.admin)).send({});
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/topicName/);
    });

    it('a new name that is not in the PDF is refused', async () => {
      const res = await http()
        .post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/approve`)
        .set(...bearer(f.admin))
        .send({ subtopicName: 'Relativistic Velocity Addition' });
      expect(res.status).toBe(422);
      expect((res.body as Json).error.code).toBe('NAME_NOT_GROUNDED');
      expect(await nodesNamed('chapters', 'Motion')).toEqual([]); // the transaction left nothing behind
    });

    it('approval creates exactly the missing levels, published, under the uploaded subject, and files the blocks', async () => {
      const res = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/approve`).set(...bearer(f.admin)).send({});
      expect(res.status).toBe(200);
      const body = res.body as Json;
      expect(body.created).toEqual(['chapter', 'topic', 'subtopic']);
      expect(body.suggestion.status).toBe('approved');

      const [chapter] = await nodesNamed('chapters', 'Motion');
      const [topic] = await nodesNamed('topics', 'Distance and Displacement');
      const [subtopic] = await nodesNamed('subtopics', 'Average Speed');
      expect([chapter?.status, topic?.status, subtopic?.status]).toEqual(['published', 'published', 'published']);
      const chain = (await db().query(`SELECT subject_id, track_id FROM subtopic_paths WHERE subtopic_id = $1`, [subtopic!.id])).rows[0];
      expect(chain).toEqual({ subject_id: f.syllabus.subjectId, track_id: f.syllabus.trackId });
      expect(body.subtopicId).toBe(subtopic!.id);

      const after = (await http().get(`/v1/admin/ingestion/jobs/${jobId}/blocks`).set(...bearer(f.admin))).body as Json[];
      const block = after.find((b) => String(b.text).includes('Average speed is'))!;
      expect(block.subtopicId).toBe(subtopic!.id);
      // Approving the hierarchy is not approving the content.
      expect(block.status).toBe('needs_review');
      const open = (await db().query(`SELECT count(*)::int AS n FROM review_tasks WHERE content_block_id = $1 AND status = 'open' AND suggestion->>'syllabusSuggestionId' = $2`, [block.id, suggestion.id])).rows[0].n;
      expect(open).toBe(0);

      const actions = await auditActions(f.tenant.id, suggestion.id as string);
      expect(actions).toContain('syllabus_suggestion.approved');
      expect(await auditActions(f.tenant.id, subtopic!.id as string)).toContain('subtopic.created');
    });

    it('the content then goes through the normal approve → publish, and a student reads the theory', async () => {
      const subtopicId = (await nodesNamed('subtopics', 'Average Speed'))[0]!.id as string;
      const block = ((await http().get(`/v1/admin/ingestion/jobs/${jobId}/blocks`).set(...bearer(f.admin))).body as Json[]).find((b) => String(b.text).includes('Average speed is'))!;
      expect((await http().post(`/v1/admin/ingestion/blocks/${block.id}/approve`).set(...bearer(f.admin)).send({})).status).toBe(200);
      const published = await http().post(`/v1/admin/ingestion/blocks/${block.id}/publish`).set(...bearer(f.admin)).send({});
      expect(published.status).toBe(200);
      expect((published.body as Json).published).toBe(true);

      const theory = await http().get(`/v1/subtopics/${subtopicId}/theory`).set(...bearer(f.student));
      expect(theory.status).toBe(200);
      expect(JSON.stringify(theory.body)).toContain('total distance travelled divided by the total time');
    });

    it('a decided suggestion cannot be decided again', async () => {
      const again = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/reject`).set(...bearer(f.admin)).send({});
      expect(again.status).toBe(409);
    });

    it('a later upload of the same hierarchy reuses the approved nodes: no suggestion, no duplicates', async () => {
      const { jobId: second, blocks: secondBlocks } = await ingest(MOTION);
      expect(fullPath(await suggestionsOf(second), 'Average Speed')).toBeUndefined();
      const subtopicId = (await nodesNamed('subtopics', 'Average Speed'))[0]!.id as string;
      expect(secondBlocks.find((b) => String(b.text).includes('Average speed is'))!.subtopicId).toBe(subtopicId);
      expect(await nodesNamed('chapters', 'Motion')).toHaveLength(1);
      expect(await nodesNamed('subtopics', 'Average Speed')).toHaveLength(1);
    });
  });

  describe('all three levels already exist', () => {
    it('files the content straight under the existing sub-topic, with no suggestion', async () => {
      const { jobId, blocks } = await ingest(EXISTING);
      const list = await suggestionsOf(jobId);
      expect((list.suggestions as Json[]).filter((s) => s.subtopic.name === 'Angular Momentum')).toEqual([]);
      const block = blocks.find((b) => String(b.text).includes('Angular momentum is conserved'))!;
      expect(block.subtopicId).toBe(f.syllabus.subtopicId);
      expect(block.suggestionId).toBeNull();
      expect(block.mappingReason).toMatch(/filed by the PDF's own headings/);
      expect(await nodesNamed('chapters', 'Mechanics')).toHaveLength(1);
    });
  });

  describe('existing chapter and topic, new sub-topic', () => {
    it('proposes only the sub-topic and approval reuses the chapter and topic', async () => {
      const { jobId } = await ingest(TORQUE);
      const suggestion = fullPath(await suggestionsOf(jobId), 'Torque');
      expect(suggestion).toMatchObject({
        chapter: { state: 'existing', existingId: f.syllabus.chapterId },
        topic: { state: 'existing', existingId: f.syllabus.topicId },
        subtopic: { state: 'new', name: 'Torque' },
      });
      const res = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/approve`).set(...bearer(f.admin)).send({});
      expect(res.status).toBe(200);
      expect((res.body as Json).created).toEqual(['subtopic']);
      const [torque] = (await db().query(`SELECT topic_id FROM subtopics WHERE tenant_id = $1 AND name = 'Torque'`, [f.tenant.id])).rows;
      expect(torque.topic_id).toBe(f.syllabus.topicId);
      expect(await nodesNamed('chapters', 'Mechanics')).toHaveLength(1);
      expect(await nodesNamed('topics', 'Rotational Dynamics')).toHaveLength(1);
    });
  });

  describe('reject, duplicates, re-runs and isolation', () => {
    const GRAVITY = ['4 Gravitation', '', '4.1 Universal Law', '', '4.1.1 Inverse Square Law', '', 'The gravitational force falls with the square of the distance between two masses.'].join('\n');

    it('a second upload of the same new hierarchy joins the pending suggestion instead of duplicating it', async () => {
      const first = await ingest(GRAVITY);
      const second = await ingest(GRAVITY);
      const a = fullPath(await suggestionsOf(first.jobId), 'Inverse Square Law');
      const b = fullPath(await suggestionsOf(second.jobId), 'Inverse Square Law');
      expect(b.id).toBe(a.id);
      const pending = (await db().query(`SELECT count(*)::int AS n FROM syllabus_suggestions WHERE tenant_id = $1 AND subtopic_key = 'inverse square law' AND status = 'pending'`, [f.tenant.id])).rows[0].n;
      expect(pending).toBe(1);
    });

    it('re-running a job is idempotent: same suggestions, blocks relinked', async () => {
      const { jobId } = await ingest(GRAVITY);
      const before = await suggestionsOf(jobId);
      expect((await http().post(`/v1/admin/ingestion/jobs/${jobId}/retry`).set(...bearer(f.admin)).send({})).status).toBe(202);
      await f.queue.drain();
      const after = await suggestionsOf(jobId);
      expect((after.suggestions as Json[]).map((s) => s.id).sort()).toEqual((before.suggestions as Json[]).map((s) => s.id).sort());
      expect(fullPath(after, 'Inverse Square Law').linkedBlocks).toBe(fullPath(before, 'Inverse Square Law').linkedBlocks);
    });

    it('another organisation cannot see or decide this job\'s suggestions', async () => {
      const { jobId } = await ingest(GRAVITY);
      const suggestion = fullPath(await suggestionsOf(jobId), 'Inverse Square Law');
      const other = await createTenant();
      const outsider = await login(f.t, await createUser(other, 'ADMIN'), other.slug);
      expect((await http().get(`/v1/admin/ingestion/jobs/${jobId}/suggestions`).set(...bearer(outsider))).status).toBe(404);
      expect((await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/approve`).set(...bearer(outsider)).send({})).status).toBe(404);
      // A student has no route here at all.
      expect((await http().get(`/v1/admin/ingestion/jobs/${jobId}/suggestions`).set(...bearer(f.student))).status).toBe(403);
    });

    it('rejecting creates nothing, records who and why, and leaves the blocks unmapped', async () => {
      const { jobId, blocks } = await ingest(GRAVITY);
      const suggestion = fullPath(await suggestionsOf(jobId), 'Inverse Square Law');
      const res = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/reject`).set(...bearer(f.admin)).send({ reason: 'not part of this course' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'rejected', rejectionReason: 'not part of this course' });
      expect((res.body as Json).reviewedBy).toBeTruthy();
      expect(await nodesNamed('chapters', 'Gravitation')).toEqual([]);
      expect(await nodesNamed('subtopics', 'Inverse Square Law')).toEqual([]);
      const block = blocks.find((b) => String(b.text).includes('The gravitational force'))!;
      const now = ((await http().get(`/v1/admin/ingestion/jobs/${jobId}/blocks`).set(...bearer(f.admin))).body as Json[]).find((b) => b.id === block.id)!;
      expect(now.subtopicId).toBeNull();
      expect(await auditActions(f.tenant.id, suggestion.id as string)).toContain('syllabus_suggestion.rejected');

      // A re-run of the same job does not propose what was just rejected.
      await http().post(`/v1/admin/ingestion/jobs/${jobId}/retry`).set(...bearer(f.admin)).send({});
      await f.queue.drain();
      const pendingForPath = (await db().query(`SELECT count(*)::int AS n FROM syllabus_suggestions WHERE tenant_id = $1 AND job_id = $2 AND subtopic_key = 'inverse square law' AND status = 'pending'`, [f.tenant.id, jobId])).rows[0].n;
      expect(pendingForPath).toBe(0);
    });

    it('approving with an edited name that matches an existing node reuses it', async () => {
      const text = ['7 Mechanic', '', '7.1 Rotational Dynamic', '', '7.1.1 Precession', '', 'Precession is the slow turning of the axis of a spinning top.'].join('\n');
      const { jobId } = await ingest(text);
      const suggestion = fullPath(await suggestionsOf(jobId), 'Precession');
      // Near-exact names ("Mechanic" ~ "Mechanics") are already reused at detection.
      expect(suggestion.chapter).toMatchObject({ state: 'existing', existingId: f.syllabus.chapterId });
      const res = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/approve`).set(...bearer(f.admin)).send({ topicName: 'Rotational Dynamics' });
      expect(res.status).toBe(200);
      expect((res.body as Json).created).toEqual(['subtopic']);
      expect(await nodesNamed('topics', 'Rotational Dynamics')).toHaveLength(1);
    });
  });

  describe('CASE 3. mixed: existing chapter, missing topic and sub-topic', () => {
    it('proposes the topic and sub-topic as NEW under the EXISTING chapter, and approval creates only those', async () => {
      const text = ['1 Mechanics', '', '1.4 Fluid Statics', '', '1.4.1 Buoyancy', '', 'Buoyancy is the upward force a fluid exerts on an immersed body.'].join('\n');
      const { jobId } = await ingest(text);
      const suggestion = fullPath(await suggestionsOf(jobId), 'Buoyancy');
      expect(suggestion).toMatchObject({
        chapter: { state: 'existing', existingId: f.syllabus.chapterId },
        topic: { state: 'new', name: 'Fluid Statics' },
        subtopic: { state: 'new', name: 'Buoyancy' },
      });
      const res = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/approve`).set(...bearer(f.admin)).send({});
      expect(res.status).toBe(200);
      expect((res.body as Json).created).toEqual(['topic', 'subtopic']);
      const [topic] = (await db().query(`SELECT chapter_id FROM topics WHERE tenant_id = $1 AND name = 'Fluid Statics'`, [f.tenant.id])).rows;
      expect(topic.chapter_id).toBe(f.syllabus.chapterId);
      expect(await nodesNamed('chapters', 'Mechanics')).toHaveLength(1);
    });
  });

  describe('V/W. matching never crosses a subject or a track', () => {
    it('a same-named chapter, topic and sub-topic in another subject or another track is neither matched nor reused', async () => {
      // The same "Optics › Reflection › Plane Mirrors" path in another subject of this track, and in another track.
      const sameTrackSubject = (await db().query(`INSERT INTO subjects (tenant_id, track_id, slug, name, status) VALUES ($1, $2, $3, 'Chemistry', 'published') RETURNING id`, [f.tenant.id, f.syllabus.trackId, uniq('subject')])).rows[0].id as string;
      const otherTrack = await createSyllabus(f.tenant);
      const plant = async (subjectId: string) => {
        const c = (await db().query(`INSERT INTO chapters (tenant_id, subject_id, slug, name, status) VALUES ($1, $2, $3, 'Optics', 'published') RETURNING id`, [f.tenant.id, subjectId, uniq('c')])).rows[0].id as string;
        const t = (await db().query(`INSERT INTO topics (tenant_id, chapter_id, slug, name, status) VALUES ($1, $2, $3, 'Reflection', 'published') RETURNING id`, [f.tenant.id, c, uniq('t')])).rows[0].id as string;
        const st = (await db().query(`INSERT INTO subtopics (tenant_id, topic_id, slug, name, status) VALUES ($1, $2, $3, 'Plane Mirrors', 'published') RETURNING id`, [f.tenant.id, t, uniq('s')])).rows[0].id as string;
        return [c, t, st];
      };
      const elsewhere = [...(await plant(sameTrackSubject)), ...(await plant(otherTrack.subjectId))];

      const text = ['5 Optics', '', '5.1 Reflection', '', '5.1.1 Plane Mirrors', '', 'A plane mirror forms a virtual image as far behind it as the object is in front.'].join('\n');
      const { jobId, blocks } = await ingest(text);
      const suggestion = fullPath(await suggestionsOf(jobId), 'Plane Mirrors');
      expect([suggestion.chapter.state, suggestion.topic.state, suggestion.subtopic.state]).toEqual(['new', 'new', 'new']);
      const block = blocks.find((b) => String(b.text).includes('plane mirror forms'))!;
      expect(block.subtopicId).toBeNull();
      expect(elsewhere).not.toContain(block.subtopicId);

      const res = await http().post(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${suggestion.id}/approve`).set(...bearer(f.admin)).send({});
      expect((res.body as Json).created).toEqual(['chapter', 'topic', 'subtopic']);
      const chain = (await db().query(`SELECT subject_id, track_id FROM subtopic_paths WHERE subtopic_id = $1`, [(res.body as Json).subtopicId])).rows[0];
      expect(chain).toEqual({ subject_id: f.syllabus.subjectId, track_id: f.syllabus.trackId });
      expect(elsewhere).not.toContain((res.body as Json).subtopicId);
      // One "Optics" per subject: the other two are untouched, and the new one is under the uploaded subject.
      const optics = (await db().query(`SELECT subject_id FROM chapters WHERE tenant_id = $1 AND name = 'Optics' AND deleted_at IS NULL`, [f.tenant.id])).rows.map((r) => r.subject_id).sort();
      expect(optics).toEqual([f.syllabus.subjectId, sameTrackSubject, otherTrack.subjectId].sort());
    });

    it('an upload naming a subject of another track is refused before anything is stored', async () => {
      const otherTrack = await createSyllabus(f.tenant);
      const res = await http()
        .post(`/v1/admin/ingestion/assets?trackId=${f.syllabus.trackId}&subjectId=${otherTrack.subjectId}`)
        .set(...bearer(f.admin))
        .set('Content-Type', 'application/pdf')
        .send(makePdf({ pages: [`${MOTION}\n\n${uniq('ref')}`] }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/does not belong to the track/);
    });
  });

  describe('CASE 6. the very same PDF uploaded twice', () => {
    it('is refused as a duplicate, so no second job, suggestion or node can come of it', async () => {
      const body = makePdf({ pages: [`${['9 Waves', '', '9.1 Sound', '', '9.1.1 Echo', '', 'An echo is a reflected sound heard after the original.'].join('\n')}\n\n${uniq('ref')}`] });
      const send = () => http().post(`/v1/admin/ingestion/assets?trackId=${f.syllabus.trackId}&subjectId=${f.syllabus.subjectId}`).set(...bearer(f.admin)).set('Content-Type', 'application/pdf').send(body);
      expect((await send()).status).toBe(201);
      await f.queue.drain();
      const second = await send();
      expect(second.status).toBe(409);
      expect((second.body as Json).error.code).toBe('DUPLICATE');
      const pending = (await db().query(`SELECT count(*)::int AS n FROM syllabus_suggestions WHERE tenant_id = $1 AND subtopic_key = 'echo'`, [f.tenant.id])).rows[0].n;
      expect(pending).toBe(1);
    });
  });

  describe('a PDF that does not state its structure', () => {
    it('is flagged "Hierarchy needs review", proposes nothing, and falls back to existing sub-topics only', async () => {
      const { jobId, job } = await ingest(UNSTRUCTURED);
      expect(job.hierarchy).toMatchObject({ status: 'needs_review', method: 'none' });
      expect((await suggestionsOf(jobId)).suggestions).toEqual([]);
      const task = (await db().query(`SELECT reason FROM review_tasks WHERE job_id = $1 AND content_block_id IS NULL AND status = 'open'`, [jobId])).rows;
      expect(task.some((t) => /^Hierarchy needs review/.test(t.reason as string))).toBe(true);
    });

    it('without a subject, hierarchy matching does not apply and ingestion behaves as before', async () => {
      const { jobId, job } = await ingest(MOTION, { subject: false });
      expect(job.hierarchy).toMatchObject({ status: 'not_applicable' });
      expect((await suggestionsOf(jobId)).suggestions).toEqual([]);
    });
  });
});

describe('X. the model step: only for unstructured PDFs, and it cannot invent a syllabus name (e2e)', () => {
  const fake = new FakeAiProvider();
  let t: TestApp;
  let tenant: TenantFixture;
  let syllabus: SyllabusFixture;
  let admin: Session;
  let queue: JobQueue;

  beforeAll(async () => {
    t = await createTestApp({}, [{ token: AI_PRIMARY_PROVIDER, value: fake }]);
    tenant = await createTenant();
    syllabus = await createSyllabus(tenant);
    await createEngineConfig(tenant);
    admin = await login(t, await createUser(tenant, 'ADMIN'), tenant.slug);
    queue = t.app.get<JobQueue>(JOB_QUEUE);
  });
  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  async function ingest(text: string): Promise<{ jobId: string; job: Json; suggestions: Json[] }> {
    const created = await t
      .http()
      .post(`/v1/admin/ingestion/assets?trackId=${syllabus.trackId}&subjectId=${syllabus.subjectId}`)
      .set(...bearer(admin))
      .set('Content-Type', 'application/pdf')
      .send(makePdf({ pages: [`${text}\n\n${uniq('ref')}`] }));
    expect(created.status).toBe(201);
    const jobId = (created.body as Json).jobId as string;
    await queue.drain();
    const job = ((await t.http().get(`/v1/admin/ingestion/jobs/${jobId}`).set(...bearer(admin))).body as Json).job as Json;
    const suggestions = ((await t.http().get(`/v1/admin/ingestion/jobs/${jobId}/suggestions`).set(...bearer(admin))).body as Json).suggestions as Json[];
    return { jobId, job, suggestions };
  }

  it('is not called when the PDF has numbered structure', async () => {
    fake.reset();
    await ingest(['2 Kinematics', '', '2.1 Speed', '', '2.1.1 Instantaneous Speed', '', 'Instantaneous speed is the speed at one moment.'].join('\n'));
    expect(fake.structuredCallsFor('syllabus_structure')).toHaveLength(0);
  });

  it('may only choose among the PDF\'s own heading lines: invented names and out-of-range lines are discarded', async () => {
    fake.reset();
    fake.replyStructured('syllabus_structure', {
      headings: [
        // A name the model made up rides along with a valid line choice: only the line is used.
        { line: 1, level: 'chapter', name: 'Geometrical Optics' },
        { line: 2, level: 'topic' },
        { line: 40, level: 'subtopic' },
        { line: 3, level: 'galaxy' },
      ],
    });
    // Two-line paragraphs, as real text has: the extractor tells paragraphs apart by the larger gap above them.
    const { job, suggestions } = await ingest(
      ['Light Basics', '', 'Light travels in straight lines', 'in a uniform transparent medium.', '', 'Reflection Laws', '', 'The angle of incidence equals', 'the angle of reflection at a mirror.'].join('\n'),
    );
    expect(fake.structuredCallsFor('syllabus_structure')).toHaveLength(1);
    expect(fake.structuredCallsFor('syllabus_structure')[0]!.prompt).toMatch(/Do not rename, merge, translate or invent/);
    expect(job.hierarchy).toMatchObject({ status: 'detected', method: 'ai' });

    const path = suggestions.find((s) => s.topic.name === 'Reflection Laws')!;
    expect(path.chapter.name).toBe('Light Basics');
    expect(path.subtopic).toMatchObject({ state: 'unresolved', name: null }); // never guessed
    expect(path.needsNames).toBe(true);
    expect(JSON.stringify(suggestions)).not.toContain('Geometrical Optics');
    expect(path.confidence).toBeLessThanOrEqual(0.6);
    // Nothing became a node.
    expect((await db().query(`SELECT count(*)::int AS n FROM chapters WHERE tenant_id = $1 AND name = 'Light Basics'`, [tenant.id])).rows[0].n).toBe(0);

    // An admin cannot slip the invented name in through Edit & Approve either.
    const res = await t
      .http()
      .post(`/v1/admin/ingestion/jobs/${path.jobId}/suggestions/${path.id}/approve`)
      .set(...bearer(admin))
      .send({ chapterName: 'Geometrical Optics', subtopicName: 'Reflection Laws' });
    expect(res.status).toBe(422);
    expect((res.body as Json).error.code).toBe('NAME_NOT_GROUNDED');
  });

  it('a model failure leaves the upload flagged for review, and the job still completes', async () => {
    fake.reset();
    fake.replyStructured('syllabus_structure', 'not json at all');
    const { job, suggestions } = await ingest(
      ['Pressure Basics', '', 'Pressure is the force acting', 'on each unit of area.', '', 'Atmospheric Pressure', '', 'Air presses on every surface', 'it is in contact with.'].join('\n'),
    );
    expect(fake.structuredCallsFor('syllabus_structure').length).toBeGreaterThan(0); // the model was asked, and failed
    expect(job.status).toBe('awaiting_review');
    expect(job.hierarchy).toMatchObject({ status: 'needs_review' });
    expect(suggestions).toEqual([]);
  });
});
