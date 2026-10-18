import {
  auditActions,
  bearer,
  closeDb,
  createSubtopic,
  createSyllabus,
  createTenant,
  createTestApp,
  createUser,
  db,
  insertContentBlock,
  login,
  uniq,
  type Session,
  type SyllabusFixture,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Syllabus and theory (e2e)', () => {
  let t: TestApp;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let student: Session;
  let admin: Session;
  let adminB: Session;
  let syl: SyllabusFixture;

  beforeAll(async () => {
    t = await createTestApp();
    tenantA = await createTenant();
    tenantB = await createTenant();
    const [studentUser, adminUser, adminBUser] = await Promise.all([
      createUser(tenantA, 'STUDENT'),
      createUser(tenantA, 'ADMIN'),
      createUser(tenantB, 'ADMIN'),
    ]);
    [student, admin, adminB] = await Promise.all([
      login(t, studentUser, tenantA.slug),
      login(t, adminUser, tenantA.slug),
      login(t, adminBUser, tenantB.slug),
    ]);
    syl = await createSyllabus(tenantA);
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  describe('student view', () => {
    it('lists published tracks with their subjects', async () => {
      const res = await t.http().get('/v1/tracks').set(...bearer(student));
      expect(res.status).toBe(200);
      const track = (res.body as Json).items.find((x: Json) => x.id === syl.trackId);
      expect(track).toMatchObject({ id: syl.trackId, status: 'published' });
      expect(track.subjects).toEqual([expect.objectContaining({ id: syl.subjectId, name: 'Physics' })]);
    });

    it('returns the whole tree in one call, with question counts and null mastery', async () => {
      const res = await t.http().get(`/v1/tracks/${syl.trackId}/tree`).set(...bearer(student));
      expect(res.status).toBe(200);
      const body = res.body as Json;
      expect(body.track.id).toBe(syl.trackId);
      const subject = body.subjects[0];
      const chapter = subject.chapters[0];
      const topic = chapter.topics[0];
      const subtopic = topic.subtopics[0];
      expect([subject.id, chapter.id, topic.id, subtopic.id]).toEqual([syl.subjectId, syl.chapterId, syl.topicId, syl.subtopicId]);
      expect(subtopic).toMatchObject({ questionCount: 0, hasTheory: false, mastery: null });
      expect(subject.mastery).toBeNull();
    });

    it('hides a draft sub-topic and everything under an unpublished ancestor', async () => {
      const draftSub = await createSubtopic(tenantA, syl.topicId, 'draft');
      const hidden = await createSyllabus(tenantA, { chapter: 'draft' });

      const tree = await t.http().get(`/v1/tracks/${syl.trackId}/tree`).set(...bearer(student));
      const ids = (tree.body as Json).subjects[0].chapters[0].topics[0].subtopics.map((s: Json) => s.id);
      expect(ids).not.toContain(draftSub);

      for (const [path, id] of [
        ['subtopics', draftSub],
        ['chapters', hidden.chapterId],
        ['topics', hidden.topicId],
        ['subtopics', hidden.subtopicId],
      ] as const) {
        const res = await t.http().get(`/v1/${path}/${id}`).set(...bearer(student));
        expect([path, res.status]).toEqual([path, 404]);
      }
      // the admin view still shows them
      const adminTree = await t.http().get(`/v1/admin/tracks/${hidden.trackId}/tree`).set(...bearer(admin));
      expect(adminTree.body.subjects[0].chapters[0]).toMatchObject({ id: hidden.chapterId, status: 'draft' });
    });

    it('returns breadcrumbs from the track down for every level', async () => {
      const res = await t.http().get(`/v1/subtopics/${syl.subtopicId}`).set(...bearer(student));
      expect(res.status).toBe(200);
      expect((res.body as Json).breadcrumbs.map((b: Json) => b.level)).toEqual(['track', 'subject', 'chapter', 'topic']);
      expect((res.body as Json).breadcrumbs.map((b: Json) => b.id)).toEqual([syl.trackId, syl.subjectId, syl.chapterId, syl.topicId]);

      const chapter = await t.http().get(`/v1/chapters/${syl.chapterId}`).set(...bearer(student));
      expect(chapter.body.breadcrumbs.map((b: Json) => b.level)).toEqual(['track', 'subject']);
      expect(chapter.body.chapter.topics[0].subtopics[0].id).toBe(syl.subtopicId);
    });

    it('never shows another organisation’s syllabus', async () => {
      const other = await createSyllabus(tenantB);
      for (const [path, id] of [
        ['tracks', other.trackId],
        ['subjects', other.subjectId],
        ['chapters', other.chapterId],
        ['topics', other.topicId],
        ['subtopics', other.subtopicId],
      ] as const) {
        expect((await t.http().get(`/v1/${path}/${id}`).set(...bearer(student))).status).toBe(404);
      }
      expect((await t.http().get(`/v1/tracks/${other.trackId}/tree`).set(...bearer(student))).status).toBe(404);
      expect((await t.http().get(`/v1/admin/tracks/${other.trackId}/tree`).set(...bearer(admin))).status).toBe(404);
    });
  });

  describe('theory', () => {
    it('returns published theory blocks in order, with list structure and a reading estimate', async () => {
      const sub = await createSubtopic(tenantA, syl.topicId, 'published', 'Rolling motion');
      await insertContentBlock(tenantA, sub, { text: 'Rolling without slipping ties translation to rotation.', sortOrder: 0 });
      await insertContentBlock(tenantA, sub, {
        format: 'list',
        title: 'Moments of inertia',
        text: 'Thin ring: MR²\nSolid sphere: ⅖MR²',
        contentJson: { items: ['Thin ring: MR²', 'Solid sphere: ⅖MR²'] },
        sortOrder: 1,
      });

      const res = await t.http().get(`/v1/subtopics/${sub}/theory`).set(...bearer(student));
      expect(res.status).toBe(200);
      const body = res.body as Json;
      expect(body).toMatchObject({ subtopicId: sub, title: 'Rolling motion' });
      expect(body.readMinutes).toBeGreaterThanOrEqual(1);
      expect(body.blocks).toHaveLength(2);
      expect(body.blocks[0]).toMatchObject({ type: 'paragraph', title: null });
      expect(body.blocks[1]).toMatchObject({ type: 'list', title: 'Moments of inertia', items: ['Thin ring: MR²', 'Solid sphere: ⅖MR²'] });
    });

    it('leaves out unpublished theory and never returns question or solution blocks', async () => {
      const sub = await createSubtopic(tenantA, syl.topicId, 'published', 'Torque');
      await insertContentBlock(tenantA, sub, { text: 'Published theory.', status: 'published' });
      await insertContentBlock(tenantA, sub, { text: 'Draft theory, not for students.', status: 'approved' });
      await insertContentBlock(tenantA, sub, { kind: 'solution', text: 'The answer is 5 because ...', status: 'published' });
      await insertContentBlock(tenantA, sub, { kind: 'question', text: 'Find the torque.', status: 'published' });

      const res = await t.http().get(`/v1/subtopics/${sub}/theory`).set(...bearer(student));
      expect(res.body.blocks).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toMatch(/answer is 5|Find the torque|not for students/);
    });

    it('is empty (not an error) for a sub-topic with no theory, and 404 for a hidden one', async () => {
      const empty = await t.http().get(`/v1/subtopics/${syl.subtopicId}/theory`).set(...bearer(student));
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ blocks: [], readMinutes: 0 });

      const draft = await createSubtopic(tenantA, syl.topicId, 'draft');
      await insertContentBlock(tenantA, draft, { text: 'Hidden because the sub-topic is a draft.' });
      expect((await t.http().get(`/v1/subtopics/${draft}/theory`).set(...bearer(student))).status).toBe(404);
    });
  });

  describe('admin authoring', () => {
    it('refuses syllabus writes to students', async () => {
      const res = await t.http().post('/v1/admin/tracks').set(...bearer(student)).send({ slug: uniq('t'), name: 'Nope' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('creates a full chain, defaults to draft, and audits every step', async () => {
      const track = await t.http().post('/v1/admin/tracks').set(...bearer(admin)).send({ slug: uniq('jee'), name: 'JEE Main', shortName: 'JEE', examYear: 2027 });
      expect(track.status).toBe(201);
      expect(track.body).toMatchObject({ status: 'draft', shortName: 'JEE', examYear: 2027 });

      const subject = await t.http().post(`/v1/admin/tracks/${track.body.id}/subjects`).set(...bearer(admin)).send({ slug: 'chemistry', name: 'Chemistry', colorHex: '#4361EE', status: 'published' });
      const chapter = await t.http().post(`/v1/admin/subjects/${subject.body.id}/chapters`).set(...bearer(admin)).send({ slug: 'organic', name: 'Organic', weightagePct: 22.5 });
      const topic = await t.http().post(`/v1/admin/chapters/${chapter.body.id}/topics`).set(...bearer(admin)).send({ slug: 'alcohols', name: 'Alcohols' });
      const subtopic = await t.http().post(`/v1/admin/topics/${topic.body.id}/subtopics`).set(...bearer(admin)).send({ slug: 'esterification', name: 'Esterification', description: 'Fischer esterification' });
      expect([subject.status, chapter.status, topic.status, subtopic.status]).toEqual([201, 201, 201, 201]);
      expect(subject.body.colorHex).toBe('#4361EE');
      expect(chapter.body.weightagePct).toBe(22.5);

      expect(await auditActions(tenantA.id, track.body.id)).toEqual(['track.created']);
      expect(await auditActions(tenantA.id, subtopic.body.id)).toEqual(['subtopic.created']);
    });

    it('rejects a duplicate slug among live siblings but allows it after a delete', async () => {
      const track = await t.http().post('/v1/admin/tracks').set(...bearer(admin)).send({ slug: uniq('dup'), name: 'Dup track' });
      const first = await t.http().post(`/v1/admin/tracks/${track.body.id}/subjects`).set(...bearer(admin)).send({ slug: 'physics', name: 'Physics' });
      const clash = await t.http().post(`/v1/admin/tracks/${track.body.id}/subjects`).set(...bearer(admin)).send({ slug: 'physics', name: 'Physics again' });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('SLUG_TAKEN');

      expect((await t.http().delete(`/v1/admin/subjects/${first.body.id}`).set(...bearer(admin))).status).toBe(204);
      const reused = await t.http().post(`/v1/admin/tracks/${track.body.id}/subjects`).set(...bearer(admin)).send({ slug: 'physics', name: 'Physics reborn' });
      expect(reused.status).toBe(201);
    });

    it('updates only what was sent and records a before/after diff', async () => {
      const track = await t.http().post('/v1/admin/tracks').set(...bearer(admin)).send({ slug: uniq('upd'), name: 'Before', description: 'first' });
      const res = await t.http().patch(`/v1/admin/tracks/${track.body.id}`).set(...bearer(admin)).send({ name: 'After', status: 'published' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'After', status: 'published', description: 'first' });

      const { rows } = await db().query<{ before: Json; after: Json }>(
        `SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'track.updated'`,
        [track.body.id],
      );
      expect(rows[0]!.before).toEqual({ name: 'Before', status: 'draft' });
      expect(rows[0]!.after).toEqual({ name: 'After', status: 'published' });
    });

    it('rejects a null name, an invalid slug and an unknown field', async () => {
      const track = await t.http().post('/v1/admin/tracks').set(...bearer(admin)).send({ slug: uniq('val'), name: 'Validation' });
      const nulled = await t.http().patch(`/v1/admin/tracks/${track.body.id}`).set(...bearer(admin)).send({ name: null });
      expect(nulled.status).toBe(400);
      expect(nulled.body.error.details[0]).toMatchObject({ field: 'name' });

      const badSlug = await t.http().post('/v1/admin/tracks').set(...bearer(admin)).send({ slug: 'Not A Slug', name: 'x' });
      expect(badSlug.status).toBe(400);

      const unknown = await t.http().post('/v1/admin/tracks').set(...bearer(admin)).send({ slug: uniq('x'), name: 'x', tenantId: tenantB.id });
      expect(unknown.status).toBe(400);
    });

    it('refuses to delete a node that still has children, questions or blocks', async () => {
      const res = await t.http().delete(`/v1/admin/tracks/${syl.trackId}`).set(...bearer(admin));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NODE_NOT_EMPTY');
      expect(res.body.error.details[0].field).toBe('subjects');

      const sub = await createSubtopic(tenantA, syl.topicId, 'draft');
      await insertContentBlock(tenantA, sub, { text: 'Some theory.' });
      const withBlocks = await t.http().delete(`/v1/admin/subtopics/${sub}`).set(...bearer(admin));
      expect(withBlocks.status).toBe(409);
      expect(withBlocks.body.error.details.map((d: Json) => d.field)).toContain('contentBlocks');
    });

    it('deletes an empty node, hides it from reads and audits it', async () => {
      const sub = await createSubtopic(tenantA, syl.topicId, 'published', 'Temporary');
      expect((await t.http().delete(`/v1/admin/subtopics/${sub}`).set(...bearer(admin))).status).toBe(204);
      expect((await t.http().get(`/v1/subtopics/${sub}`).set(...bearer(student))).status).toBe(404);
      expect((await t.http().patch(`/v1/admin/subtopics/${sub}`).set(...bearer(admin)).send({ name: 'Back?' })).status).toBe(404);
      expect(await auditActions(tenantA.id, sub)).toEqual(['subtopic.deleted']);
    });

    it('cannot touch another organisation’s nodes', async () => {
      expect((await t.http().patch(`/v1/admin/subtopics/${syl.subtopicId}`).set(...bearer(adminB)).send({ name: 'Hijack' })).status).toBe(404);
      expect((await t.http().delete(`/v1/admin/topics/${syl.topicId}`).set(...bearer(adminB))).status).toBe(404);
      expect((await t.http().post(`/v1/admin/topics/${syl.topicId}/subtopics`).set(...bearer(adminB)).send({ slug: 'x', name: 'X' })).status).toBe(404);
    });
  });

  describe('theory authoring', () => {
    let sub: string;
    beforeAll(async () => {
      sub = await createSubtopic(tenantA, syl.topicId, 'published', 'Authoring');
    });

    it('saves a block unpublished, then publishes it on request', async () => {
      const created = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'paragraph', body: 'Angular momentum L = Iω.' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'approved', type: 'paragraph', body: 'Angular momentum L = Iω.' });
      expect(created.body.contentHash).toMatch(/^[0-9a-f]{64}$/);

      expect((await t.http().get(`/v1/subtopics/${sub}/theory`).set(...bearer(student))).body.blocks).toHaveLength(0);

      const published = await t.http().patch(`/v1/admin/theory-blocks/${created.body.id}`).set(...bearer(admin)).send({ status: 'published' });
      expect(published.body).toMatchObject({ status: 'published' });
      expect(published.body.publishedAt).not.toBeNull();

      const theory = await t.http().get(`/v1/subtopics/${sub}/theory`).set(...bearer(student));
      expect(theory.body.blocks).toEqual([expect.objectContaining({ id: created.body.id, body: 'Angular momentum L = Iω.' })]);
      expect(await auditActions(tenantA.id, created.body.id)).toEqual(['theory_block.published', 'theory_block.created']);
    });

    it('creates list and table blocks, and appends them in creation order', async () => {
      const list = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'list', title: 'Results', items: ['Ring: MR²', 'Disc: ½MR²'], publish: true });
      const table = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'table', table: { columns: ['Body', 'I'], rows: [['Ring', 'MR²']] }, publish: true });
      expect([list.status, table.status]).toEqual([201, 201]);
      expect(list.body.items).toEqual(['Ring: MR²', 'Disc: ½MR²']);
      expect(table.body.table).toEqual({ columns: ['Body', 'I'], rows: [['Ring', 'MR²']] });
      expect(table.body.sortOrder).toBeGreaterThan(list.body.sortOrder);
    });

    it('rejects content that does not match the block type', async () => {
      const noBody = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'paragraph' });
      expect(noBody.status).toBe(400);
      expect(noBody.body.error.details[0].field).toBe('body');

      const figure = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'figure', body: 'x' });
      expect(figure.status).toBe(400);

      const ragged = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'table', table: { columns: ['a', 'b'], rows: [['1']] } });
      expect(ragged.status).toBe(400);
    });

    it('edits a block, re-hashes it and can unpublish it', async () => {
      const created = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'callout', title: 'Pitfall', body: 'Original text.', publish: true });
      const edited = await t.http().patch(`/v1/admin/theory-blocks/${created.body.id}`).set(...bearer(admin)).send({ body: 'Corrected text.' });
      expect(edited.body.body).toBe('Corrected text.');
      expect(edited.body.contentHash).not.toBe(created.body.contentHash);
      expect(edited.body.title).toBe('Pitfall');

      const unpublished = await t.http().patch(`/v1/admin/theory-blocks/${created.body.id}`).set(...bearer(admin)).send({ status: 'approved', title: null });
      expect(unpublished.body).toMatchObject({ status: 'approved', title: null, publishedAt: null });
      const ids = (await t.http().get(`/v1/subtopics/${sub}/theory`).set(...bearer(student))).body.blocks.map((b: Json) => b.id);
      expect(ids).not.toContain(created.body.id);
    });

    it('deletes a block and lists both published and unpublished ones for admins', async () => {
      const created = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'paragraph', body: 'Throwaway.' });
      const list = await t.http().get(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin));
      expect(list.body.items.map((b: Json) => b.id)).toContain(created.body.id);
      expect(list.body.items.some((b: Json) => b.status === 'approved')).toBe(true);
      expect(list.body.items.some((b: Json) => b.status === 'published')).toBe(true);

      expect((await t.http().delete(`/v1/admin/theory-blocks/${created.body.id}`).set(...bearer(admin))).status).toBe(204);
      expect((await t.http().delete(`/v1/admin/theory-blocks/${created.body.id}`).set(...bearer(admin))).status).toBe(404);
      const after = await t.http().get(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin));
      expect(after.body.items.map((b: Json) => b.id)).not.toContain(created.body.id);
    });

    it('keeps theory blocks inside their organisation', async () => {
      const created = await t.http().post(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(admin)).send({ type: 'paragraph', body: 'Tenant A only.' });
      expect((await t.http().patch(`/v1/admin/theory-blocks/${created.body.id}`).set(...bearer(adminB)).send({ body: 'Hijacked' })).status).toBe(404);
      expect((await t.http().get(`/v1/admin/subtopics/${sub}/theory-blocks`).set(...bearer(adminB))).status).toBe(404);
    });
  });
});
