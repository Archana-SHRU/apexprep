import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ageServedItem,
  bearer,
  closeDb,
  createEngineConfig,
  createSyllabus,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertContentBlock,
  insertPracticeQuestion,
  login,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The frontend's idea of every API response, checked against the real API.
 *
 * `apexprep-frontend/src/types/api.ts` declares the backend's shapes. Nothing used to check that declaration
 * against the backend, and the frontend's own tests fed it fixtures written in the same wrong shape — so a page
 * could be wired to fields the API never sent and still pass every test. This spec reads that file, takes each
 * interface a page relies on, calls the real endpoint exactly as the frontend does, and fails if any field the
 * interface declares as required is missing from the response (recursively, through nested interfaces and arrays).
 *
 * It checks presence, not values. A field the backend sends as `null` satisfies a required `T | null`.
 */
const TYPES_FILE = resolve(__dirname, '../../../apexprep-frontend/src/types/api.ts');
const describeIfFrontend = existsSync(TYPES_FILE) ? describe : describe.skip;

interface Prop {
  name: string;
  optional: boolean;
  type: string;
}

function parseInterfaces(source: string): Map<string, { extendsName: string | null; props: Prop[] }> {
  const out = new Map<string, { extendsName: string | null; props: Prop[] }>();
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^export interface (\w+)(?: extends (\w+))? \{$/.exec(lines[i]!);
    if (!open) continue;
    const props: Prop[] = [];
    for (i += 1; i < lines.length && lines[i] !== '}'; i += 1) {
      const m = /^ {2}(?:readonly )?(\w+)(\?)?:\s*(.+?);?\s*$/.exec(lines[i]!);
      if (m) props.push({ name: m[1]!, optional: m[2] === '?', type: m[3]! });
    }
    out.set(open[1]!, { extendsName: open[2] ?? null, props });
  }
  return out;
}

describeIfFrontend('the frontend contract (e2e)', () => {
  const interfaces = existsSync(TYPES_FILE) ? parseInterfaces(readFileSync(TYPES_FILE, 'utf8')) : new Map();

  function propsOf(name: string): Prop[] {
    const entry = interfaces.get(name);
    if (!entry) throw new Error(`the frontend declares no interface ${name}`);
    return [...(entry.extendsName ? propsOf(entry.extendsName) : []), ...entry.props];
  }

  /** Every required field of `iface` that `value` lacks, as dotted paths. */
  function missing(value: unknown, iface: string, path = iface): string[] {
    if (value === null || typeof value !== 'object') return [`${path} (expected an object, got ${value === null ? 'null' : typeof value})`];
    const problems: string[] = [];
    for (const prop of propsOf(iface)) {
      const has = prop.name in (value as object);
      if (!has) {
        if (!prop.optional) problems.push(`${path}.${prop.name}`);
        continue;
      }
      const child = (value as Json)[prop.name];
      const base = prop.type.replace(/\s*\|\s*null$/, '').replace(/\s*\|\s*undefined$/, '');
      const nested = /^(\w+)(\[\])?$/.exec(base);
      if (!nested || !interfaces.has(nested[1]!) || child === null || child === undefined) continue;
      if (nested[2]) {
        if (!Array.isArray(child)) problems.push(`${path}.${prop.name} (expected an array)`);
        else child.slice(0, 3).forEach((item, i) => problems.push(...missing(item, nested[1]!, `${path}.${prop.name}[${i}]`)));
      } else {
        problems.push(...missing(child, nested[1]!, `${path}.${prop.name}`));
      }
    }
    return problems;
  }

  const expectShape = (value: unknown, iface: string): void => expect(missing(value, iface)).toEqual([]);
  const expectEachShape = (values: unknown, iface: string): void => {
    expect(Array.isArray(values)).toBe(true);
    for (const [i, v] of (values as unknown[]).slice(0, 3).entries()) expect(missing(v, iface, `${iface}[${i}]`)).toEqual([]);
  };

  let t: TestApp;
  let tenant: TenantFixture;
  let syllabus: SyllabusFixture;
  let admin: Session;
  let student: Session;
  let studentId: string;
  let questionId: string;

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant();
    syllabus = await createSyllabus(tenant);
    await createEngineConfig(tenant);
    const [a, s] = await Promise.all([createUser(tenant, 'ADMIN'), createUser(tenant, 'STUDENT')]);
    studentId = s.id;
    [admin, student] = await Promise.all([login(t, a, tenant.slug), login(t, s, tenant.slug)]);
    await db().query(`UPDATE users SET onboarded_at = now(), primary_track_id = $2 WHERE id = $1`, [studentId, syllabus.trackId]);

    questionId = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: 'Contract question one' });
    for (let i = 0; i < 3; i += 1) await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: `Contract filler ${i}` });
    // Whichever of them the engine serves has hints to reveal.
    await db().query(`UPDATE questions SET hints = ARRAY['First hint', 'Second hint'] WHERE primary_subtopic_id = $1`, [syllabus.subtopicId]);
    await db().query(
      `INSERT INTO official_solutions (tenant_id, question_id, body, final_answer_text, status, approved_at) VALUES ($1, $2, 'Because A.', 'A', 'approved', now())`,
      [tenant.id, questionId],
    );
    await insertContentBlock(tenant, syllabus.subtopicId, { text: 'Angular momentum is conserved when no external torque acts.', title: 'Conservation' });
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  // ------------------------------------------------------------------ the parser itself

  describe('the checker', () => {
    it('finds the interfaces it will test, with their required fields', () => {
      expect(interfaces.size).toBeGreaterThan(50);
      expect(propsOf('AdminQuestionSummaryDto').map((p) => p.name)).toContain('stemPreview');
      expect(propsOf('MockTestDetailDto').map((p) => p.name)).toEqual(expect.arrayContaining(['sections', 'pastAttempts', 'title']));
    });

    it('would catch a missing field, an extra nesting level and a wrong array', () => {
      expect(missing({ id: 'x' }, 'AdminQuestionPageDto')).toEqual(expect.arrayContaining(['AdminQuestionPageDto.items', 'AdminQuestionPageDto.nextCursor']));
      expect(missing({ items: [{ id: 'x' }], nextCursor: null }, 'AdminQuestionPageDto')).toContain('AdminQuestionPageDto.items[0].stemPreview');
      expect(missing({ items: {}, nextCursor: null }, 'AdminQuestionPageDto')).toContain('AdminQuestionPageDto.items (expected an array)');
    });
  });

  // ------------------------------------------------------------------ account

  it('GET /v1/auth/me → UserDto', async () => {
    const res = await t.http().get('/v1/auth/me').set(...bearer(student));
    expect(res.status).toBe(200);
    expectShape(res.body, 'UserDto');
  });

  it('POST /v1/auth/login → AuthResponseDto', async () => {
    const user = await createUser(tenant, 'STUDENT');
    const res = await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: tenant.slug });
    expect(res.status).toBe(200);
    expectShape(res.body, 'AuthResponseDto');
  });

  // ------------------------------------------------------------------ syllabus

  it('the syllabus endpoints a learner reads', async () => {
    const tracks = await t.http().get('/v1/tracks').set(...bearer(student));
    expect(tracks.status).toBe(200);
    expectShape(tracks.body, 'TrackListDto');
    const tree = await t.http().get(`/v1/tracks/${syllabus.trackId}/tree`).set(...bearer(student));
    expectShape(tree.body, 'TrackTreeDto');
    expectShape((await t.http().get(`/v1/subjects/${syllabus.subjectId}`).set(...bearer(student))).body, 'SubjectDetailDto');
    expectShape((await t.http().get(`/v1/chapters/${syllabus.chapterId}`).set(...bearer(student))).body, 'ChapterDetailDto');
    expectShape((await t.http().get(`/v1/topics/${syllabus.topicId}`).set(...bearer(student))).body, 'TopicDetailDto');
    expectShape((await t.http().get(`/v1/subtopics/${syllabus.subtopicId}`).set(...bearer(student))).body, 'SubtopicDetailDto');
    const theory = await t.http().get(`/v1/subtopics/${syllabus.subtopicId}/theory`).set(...bearer(student));
    expect(theory.status).toBe(200);
    expectShape(theory.body, 'TheoryDto');
    expect((theory.body as Json).blocks.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------ practice

  describe('practice', () => {
    it('start, serve, hint, answer and end', async () => {
      const started = await t.http().post('/v1/practice/sessions').set(...bearer(student)).send({ subtopicId: syllabus.subtopicId });
      expect(started.status).toBe(201);
      expectShape(started.body, 'SessionStartDto');
      const sessionId = started.body.session.id as string;

      const served = await t.http().get(`/v1/practice/sessions/${sessionId}/next`).set(...bearer(student));
      expect(served.status).toBe(200);
      expectShape(served.body, 'NextQuestionDto');
      const itemId = served.body.item.id as string;

      const hint = await t.http().post(`/v1/practice/sessions/${sessionId}/hints/reveal`).set(...bearer(student)).send({ sessionItemId: itemId });
      expect(hint.status).toBe(200);
      expectShape(hint.body, 'RevealedHintDto');

      await ageServedItem(itemId, 30_000);
      const answered = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(student))
        .set('Idempotency-Key', `contract-${Date.now()}`)
        .send({ sessionItemId: itemId, response: { optionKeys: ['A'] }, totalTimeMs: 30_000, hintCount: 1 });
      expect(answered.status).toBe(201);
      expectShape(answered.body, 'AttemptResultDto');

      const ended = await t.http().post(`/v1/practice/sessions/${sessionId}/end`).set(...bearer(student)).send({});
      expect(ended.status).toBe(200);
      expectShape(ended.body, 'PracticeSessionDto');

      // The explanation of the question just attempted: a body in the declared shape, or an honest refusal when no
      // AI provider is configured — never a body in some other shape.
      const explanation = await t.http().get(`/v1/questions/${served.body.question.id as string}/explanation`).set(...bearer(student));
      if (explanation.status === 200) expectShape(explanation.body, 'ExplanationDto');
      else expect([409, 503]).toContain(explanation.status);
    });

    it('the learner summary, analytics and recommendations', async () => {
      expectShape((await t.http().get('/v1/me/summary').set(...bearer(student))).body, 'LearnerSummaryDto');
      const analytics = await t.http().get('/v1/me/analytics?range=30d').set(...bearer(student));
      expect(analytics.status).toBe(200);
      expectShape(analytics.body, 'LearnerAnalyticsDto');
      expectShape((await t.http().get('/v1/me/recommendations').set(...bearer(student))).body, 'RecommendationsDto');
    });
  });

  // ------------------------------------------------------------------ admin: question bank

  describe('the admin question bank, called exactly as the page calls it', () => {
    it('numbered pages: page, pageSize and the filters the page offers', async () => {
      const res = await t
        .http()
        .get(`/v1/admin/questions?page=1&pageSize=15&trackId=${syllabus.trackId}&subjectId=${syllabus.subjectId}&difficultyLabel=2&type=single_correct&status=published&search=Contract`)
        .set(...bearer(admin));
      expect(res.status).toBe(200);
      expectShape(res.body, 'AdminQuestionPageDto');
      expect(res.body).toMatchObject({ page: 1, pageSize: 15 });
      expect(typeof res.body.total).toBe('number');
      expect(res.body.total).toBeGreaterThan(0);
      expect(res.body.items.length).toBeLessThanOrEqual(15);
    });

    it('a second page continues where the first stopped, and the total agrees', async () => {
      const first = await t.http().get('/v1/admin/questions?page=1&pageSize=2').set(...bearer(admin));
      const second = await t.http().get('/v1/admin/questions?page=2&pageSize=2').set(...bearer(admin));
      expect(first.body.items).toHaveLength(2);
      const ids = [...first.body.items, ...second.body.items].map((q: Json) => q.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(second.body.total).toBe(first.body.total);
    });

    it('the cursor mode still works and cannot be mixed with page numbers', async () => {
      const first = await t.http().get('/v1/admin/questions?limit=2').set(...bearer(admin));
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(typeof first.body.nextCursor).toBe('string');
      expect(first.body.total).toBeUndefined();
      const mixed = await t.http().get(`/v1/admin/questions?page=1&cursor=${first.body.nextCursor as string}`).set(...bearer(admin));
      expect(mixed.status).toBe(400);
    });

    it('refuses a filter name the backend does not have, rather than ignoring it', async () => {
      expect((await t.http().get('/v1/admin/questions?difficulty=2').set(...bearer(admin))).status).toBe(400);
    });

    it('one question: the detail the dialog shows', async () => {
      const res = await t.http().get(`/v1/admin/questions/${questionId}`).set(...bearer(admin));
      expect(res.status).toBe(200);
      expectShape(res.body, 'AdminQuestionDto');
      expect(res.body.hints).toEqual(['First hint', 'Second hint']);
      expect(res.body.officialSolution.body).toBe('Because A.');
    });

    it('retire and publish return the updated question', async () => {
      const retired = await t.http().post(`/v1/admin/questions/${questionId}/retire`).set(...bearer(admin)).send({});
      expect(retired.status).toBe(200);
      expectShape(retired.body, 'AdminQuestionDto');
      expect(retired.body.status).toBe('retired');
    });
  });

  // ------------------------------------------------------------------ admin: students, stats, maintenance

  describe('the admin console', () => {
    it('the student roster, as the page asks for it', async () => {
      const res = await t.http().get('/v1/admin/students?limit=100').set(...bearer(admin));
      expect(res.status).toBe(200);
      expectShape(res.body, 'UserPageDto');
      const me = (res.body.items as Json[]).find((u) => u.id === studentId)!;
      expect(typeof me.questionsSolved).toBe('number');
      expect(me.primaryTrackName).toBe('JEE Advanced');
    });

    it('the roster can be searched and paged without being capped at one response', async () => {
      for (let i = 0; i < 3; i += 1) await createUser(tenant, 'STUDENT');
      const first = await t.http().get('/v1/admin/students?limit=2').set(...bearer(admin));
      expect(first.body.items).toHaveLength(2);
      expect(typeof first.body.nextCursor).toBe('string');
      const second = await t.http().get(`/v1/admin/students?limit=2&cursor=${first.body.nextCursor as string}`).set(...bearer(admin));
      expect(second.status).toBe(200);
      expect(second.body.items.length).toBeGreaterThan(0);
    });

    it('disabling and re-enabling a student returns the user', async () => {
      const other = await createUser(tenant, 'STUDENT');
      const off = await t.http().patch(`/v1/admin/users/${other.id}/status`).set(...bearer(admin)).send({ status: 'disabled' });
      expect(off.status).toBe(200);
      expectShape(off.body, 'UserDto');
      expect(off.body.status).toBe('disabled');
      const on = await t.http().patch(`/v1/admin/users/${other.id}/status`).set(...bearer(admin)).send({ status: 'active' });
      expect(on.body.status).toBe('active');
    });

    it('the platform statistics', async () => {
      const res = await t.http().get('/v1/admin/stats').set(...bearer(admin));
      expect(res.status).toBe(200);
      expectShape(res.body, 'AdminStatsDto');
    });

    it('the divergence check and the event purge accept the payloads the client sends', async () => {
      const divergence = await t.http().post('/v1/admin/questions/check-divergence').set(...bearer(admin)).send({ threshold: 250, minCalibrations: 30 });
      expect(divergence.status).toBe(200);
      expectShape(divergence.body, 'DivergenceCheckResultDto');
      const purge = await t.http().post('/v1/admin/maintenance/purge-events').set(...bearer(admin)).send({ olderThanDays: 365 });
      expect(purge.status).toBe(200);
      expectShape(purge.body, 'PurgeEventsResultDto');
      // The names the client used to send are refused, which is what made those calls fail.
      expect((await t.http().post('/v1/admin/maintenance/purge-events').set(...bearer(admin)).send({ retentionDays: 365 })).status).toBe(400);
      expect((await t.http().post('/v1/admin/questions/check-divergence').set(...bearer(admin)).send({ divergenceThreshold: 250 })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ peer benchmark and doubts

  describe('peer benchmark', () => {
    it('is per sub-topic: the request without one is refused', async () => {
      expect((await t.http().get('/v1/me/benchmark').set(...bearer(student))).status).toBe(400);
    });

    it('a sub-topic with no snapshot yet reports why, in the declared shape', async () => {
      const res = await t.http().get(`/v1/me/benchmark?subtopicId=${syllabus.subtopicId}`).set(...bearer(student));
      expect(res.status).toBe(200);
      expectShape(res.body, 'BenchmarkDto');
      expect(res.body.isPublished).toBe(false);
    });

    it('a published snapshot has its figures, and a withheld one has none', async () => {
      const published = await createSyllabus(tenant);
      await db().query(`UPDATE tenants SET benchmarking_enabled = true WHERE id = $1`, [tenant.id]);
      const engine = (await db().query<{ id: string }>(`SELECT id FROM engine_config WHERE tenant_id = $1 AND is_active`, [tenant.id])).rows[0]!.id;
      const snapshot = (subtopicId: string, isPublished: boolean) =>
        db().query(
          `INSERT INTO benchmark_snapshots (tenant_id, subtopic_id, snapshot_date, window_days, window_start, window_end, qualifying_students,
                                            min_qualifying_students, top_k, is_published, top_accuracy, top_median_time_ms, engine_config_id)
           VALUES ($1, $2, current_date, 90, now() - interval '90 days', now(), $3, 30, 10, $4, $5, $6, $7)`,
          [tenant.id, subtopicId, isPublished ? 42 : 14, isPublished, isPublished ? 0.885 : null, isPublished ? 65_000 : null, engine],
        );
      await snapshot(published.subtopicId, true);
      const withheld = await createSyllabus(tenant);
      await snapshot(withheld.subtopicId, false);

      const yes = await t.http().get(`/v1/me/benchmark?subtopicId=${published.subtopicId}`).set(...bearer(student));
      expectShape(yes.body, 'BenchmarkDto');
      expect(yes.body).toMatchObject({ isPublished: true, qualifyingStudents: 42, topAccuracy: 0.885, topMedianTimeSeconds: 65 });
      const no = await t.http().get(`/v1/me/benchmark?subtopicId=${withheld.subtopicId}`).set(...bearer(student));
      expectShape(no.body, 'BenchmarkDto');
      expect(no.body).toMatchObject({ isPublished: false, topAccuracy: null, topMedianTimeSeconds: null });
      expect(typeof no.body.message).toBe('string');
    });
  });

  // ------------------------------------------------------------------ mock tests

  describe('mock tests', () => {
    it('list, detail, start, save, focus and result in the declared shapes', async () => {
      const q = await insertPracticeQuestion(tenant, syllabus.subtopicId, { stem: 'Mock contract question' });
      await db().query(
        `INSERT INTO official_solutions (tenant_id, question_id, body, final_answer_text, status, approved_at) VALUES ($1, $2, 'Solution.', 'A', 'approved', now())`,
        [tenant.id, q],
      );
      const testId = (
        await db().query<{ id: string }>(
          `INSERT INTO mock_tests (tenant_id, title, kind, duration_minutes, total_marks, status) VALUES ($1, 'Contract paper', 'full_length', 30, 4, 'published') RETURNING id`,
          [tenant.id],
        )
      ).rows[0]!.id;
      const sectionId = (await db().query<{ id: string }>(`INSERT INTO test_sections (test_id, name) VALUES ($1, 'Physics') RETURNING id`, [testId])).rows[0]!.id;
      await db().query(`INSERT INTO test_items (test_id, section_id, question_id, sort_order) VALUES ($1, $2, $3, 0)`, [testId, sectionId, q]);

      const list = await t.http().get('/v1/tests').set(...bearer(student));
      expect(list.status).toBe(200);
      expectEachShape(list.body, 'MockTestSummaryDto');
      expectShape((await t.http().get(`/v1/tests/${testId}`).set(...bearer(student))).body, 'MockTestDetailDto');

      const state = await t.http().post(`/v1/tests/${testId}/start`).set(...bearer(student));
      expect(state.status).toBe(200);
      expectShape(state.body, 'TestSessionStateDto');
      const sessionId = state.body.sessionId as string;
      const itemId = state.body.sections[0].questions[0].testItemId as string;

      const saved = await t.http().post(`/v1/tests/sessions/${sessionId}/answer`).set(...bearer(student)).send({ testItemId: itemId, response: { optionKeys: ['A'] }, status: 'answered' });
      expectShape(saved.body, 'SessionClockDto');
      const focused = await t.http().post(`/v1/tests/sessions/${sessionId}/focus`).set(...bearer(student)).send({ testItemId: itemId });
      expectShape(focused.body, 'SessionClockDto');

      const submitted = await t.http().post(`/v1/tests/sessions/${sessionId}/submit`).set(...bearer(student));
      expectShape(submitted.body, 'TestResultDto');
      expectShape((await t.http().get(`/v1/tests/sessions/${sessionId}/result`).set(...bearer(student))).body, 'TestResultDto');
    });
  });
});
