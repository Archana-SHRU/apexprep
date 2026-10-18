import { QuestionsService } from '../../src/questions/questions.service';
import { questionSamples, type QuestionSample } from './question-samples';
import {
  bearer,
  closeDb,
  createEngineConfig,
  createSyllabus,
  createTenant,
  createTestApp,
  createUser,
  insertContentBlock,
  login,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Keys that must never occur anywhere in a student-facing payload, at any depth. */
const FORBIDDEN_KEYS =
  /^(isCorrect|is_correct|correct|correctKey|correctValue|correctNumeric|correct_numeric|answer|answerKey|numericAnswer|numeric_tolerance|numericTolerance|tolerance|toleranceMode|matrixAnswer|matrix_answer|solution|officialSolution|official_solution|explanation|difficultyB|difficulty_b|calibrationN|calibration_n|hints)$/;

function forbiddenKeyPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeyPaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEYS.test(k) ? [`${path}.${k}`] : []),
      ...forbiddenKeyPaths(v, `${path}.${k}`),
    ]);
  }
  return [];
}

describe('Answer leakage (e2e)', () => {
  let t: TestApp;
  let tenant: TenantFixture;
  let admin: Session;
  let student: Session;
  let syl: SyllabusFixture;
  const created: { sample: QuestionSample; id: string }[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant();
    const [adminUser, studentUser] = await Promise.all([createUser(tenant, 'ADMIN'), createUser(tenant, 'STUDENT')]);
    [admin, student] = await Promise.all([login(t, adminUser, tenant.slug), login(t, studentUser, tenant.slug)]);
    syl = await createSyllabus(tenant);
    await createEngineConfig(tenant);

    for (const sample of questionSamples(syl.subtopicId)) {
      const res = await t.http().post('/v1/admin/questions').set(...bearer(admin)).send(sample.payload);
      if (res.status !== 201) throw new Error(`could not create ${sample.type}: ${JSON.stringify(res.body)}`);
      await t.http().put(`/v1/admin/questions/${res.body.id}/official-solution`).set(...bearer(admin)).send({ body: `Full worked solution for ${sample.type}, ending in 19.` });
      await t.http().post(`/v1/admin/questions/${res.body.id}/publish`).set(...bearer(admin));
      created.push({ sample, id: res.body.id as string });
    }
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  it.each(questionSamples('x').map((s) => s.type))('the student projection of a %s question carries no answer', async (type) => {
    const { id, sample } = created.find((c) => c.sample.type === type)!;
    const view = await t.http().get(`/v1/admin/questions/${id}/preview`).set(...bearer(admin));
    expect(view.status).toBe(200);
    const body = view.body as Json;

    expect(Object.keys(body).sort()).toEqual(
      [
        'difficultyLabel',
        'expectedTimeSeconds',
        'hintCount',
        'id',
        'options',
        'stem',
        'stemJson',
        'subtopicId',
        'type',
        'version',
        ...(type === 'matrix_match' ? ['matrix'] : []),
      ].sort(),
    );
    expect(forbiddenKeyPaths(body)).toEqual([]);

    const serialized = JSON.stringify(body);
    for (const secret of sample.secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Full worked solution');
    expect(serialized).not.toContain('19.');

    for (const option of [...body.options, ...(body.matrix?.left ?? []), ...(body.matrix?.right ?? [])]) {
      expect(Object.keys(option).sort()).toEqual(['key', 'text']);
    }
  });

  it('gives the hint count but never the hint text', async () => {
    const { id } = created.find((c) => c.sample.type === 'single_correct')!;
    const view = await t.http().get(`/v1/admin/questions/${id}/preview`).set(...bearer(admin));
    expect(view.body.hintCount).toBe(1);
    expect(JSON.stringify(view.body)).not.toContain('Every element is at distance R.');
  });

  it('shows the answer key only on the admin detail route', async () => {
    const { id } = created.find((c) => c.sample.type === 'numeric')!;
    const detail = await t.http().get(`/v1/admin/questions/${id}`).set(...bearer(admin));
    expect(detail.body.numericAnswer.value).toBe('7331.5');
    expect(detail.body.officialSolution.body).toContain('Full worked solution');

    for (const path of [`/v1/admin/questions/${id}`, `/v1/admin/questions/${id}/preview`, '/v1/admin/questions']) {
      const res = await t.http().get(path).set(...bearer(student));
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it('serves the same projection through the service the practice API will use', async () => {
    const { id } = created.find((c) => c.sample.type === 'matrix_match')!;
    const view = await t.app.get(QuestionsService).studentView(tenant.id, id);
    expect(forbiddenKeyPaths(view)).toEqual([]);
    expect(view.matrix?.left.map((o) => o.key)).toEqual(['A', 'B']);
    expect(JSON.stringify(view)).not.toContain('Full worked solution');
  });

  it('will not serve an unpublished question to the practice path', async () => {
    const draft = await t.http().post('/v1/admin/questions').set(...bearer(admin)).send(questionSamples(syl.subtopicId)[0]!.payload);
    await expect(t.app.get(QuestionsService).studentView(tenant.id, draft.body.id as string)).rejects.toMatchObject({ status: 404 });
    // …while the admin preview may show it, so a question can be checked before publishing.
    expect((await t.http().get(`/v1/admin/questions/${draft.body.id}/preview`).set(...bearer(admin))).status).toBe(200);
  });

  it('never serves another organisation a question, published or not', async () => {
    const other = await createTenant();
    const otherAdmin = await login(t, await createUser(other, 'ADMIN'), other.slug);
    const { id } = created[0]!;
    expect((await t.http().get(`/v1/admin/questions/${id}/preview`).set(...bearer(otherAdmin))).status).toBe(404);
    await expect(t.app.get(QuestionsService).studentView(other.id, id)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps solution content out of the theory endpoint', async () => {
    await insertContentBlock(tenant, syl.subtopicId, { kind: 'solution', text: 'Solution: α = 2 rad/s² because τ = Iα.', status: 'published' });
    await insertContentBlock(tenant, syl.subtopicId, { kind: 'theory', text: 'Torque is the rotational analogue of force.', status: 'published' });
    const theory = await t.http().get(`/v1/subtopics/${syl.subtopicId}/theory`).set(...bearer(student));
    expect(theory.status).toBe(200);
    expect(JSON.stringify(theory.body)).not.toContain('Solution:');
    expect(theory.body.blocks).toHaveLength(1);
  });

  it('documents the student payload without answer fields in the OpenAPI schema', async () => {
    const res = await t.http().get('/docs/openapi.json');
    const schema = (res.body as Json).components.schemas.StudentQuestionDto;
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['difficultyLabel', 'expectedTimeSeconds', 'hintCount', 'id', 'matrix', 'options', 'stem', 'stemJson', 'subtopicId', 'type', 'version'].sort(),
    );
    expect(Object.keys((res.body as Json).components.schemas.StudentOptionDto.properties).sort()).toEqual(['key', 'text']);
  });
});
