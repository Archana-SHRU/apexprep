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
  insertPracticeQuestion,
  login,
  uniq,
  type Session,
  type TenantFixture,
  type TestApp,
} from './helpers';

/**
 * Phase 8: a learner belongs to one *or more* learning contexts.
 *
 * Before migration 0013 a learner had exactly one track, `users.primary_track_id`, so "Class 10
 * Mathematics, JEE Foundation and Olympiad Mathematics" could not be represented at all. These tests
 * cover the enrolment relation that replaces that single column without removing it, and the two
 * properties that matter most:
 *
 *   * the two representations never disagree — whichever endpoint is used;
 *   * mastery stays isolated per track, because a learner in three tracks must not have progress in
 *     one move their level in another.
 */
describe('Learner tracks (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  interface TrackSpec {
    name: string;
    kind?: string | null;
    gradeLabel?: string | null;
    gradeOrdinal?: number | null;
    examFamily?: string | null;
    curriculum?: string | null;
    status?: string;
  }

  /** A track with a learning context, created straight in the database as an admin would have. */
  async function makeTrack(tenant: TenantFixture, spec: TrackSpec): Promise<string> {
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO tracks (tenant_id, slug, name, kind, grade_label, grade_ordinal, exam_family, curriculum, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        tenant.id,
        uniq('track'),
        spec.name,
        spec.kind ?? null,
        spec.gradeLabel ?? null,
        spec.gradeOrdinal ?? null,
        spec.examFamily ?? null,
        spec.curriculum ?? null,
        spec.status ?? 'published',
      ],
    );
    return rows[0]!.id;
  }

  async function arrange() {
    const tenant = await createTenant();
    const student = await createUser(tenant, 'STUDENT');
    const session = await login(t, student, tenant.slug);
    return { tenant, student, session };
  }

  const list = (s: Session) => t.http().get('/v1/me/tracks').set(...bearer(s));
  const enrol = (s: Session, body: Record<string, unknown>) =>
    t
      .http()
      .post('/v1/me/tracks')
      .set(...bearer(s))
      .send(body);
  const patch = (s: Session, trackId: string, body: Record<string, unknown>) =>
    t
      .http()
      .patch(`/v1/me/tracks/${trackId}`)
      .set(...bearer(s))
      .send(body);
  const leave = (s: Session, trackId: string) => t.http().delete(`/v1/me/tracks/${trackId}`).set(...bearer(s));

  const usersPrimary = async (userId: string): Promise<string | null> => {
    const { rows } = await db().query<{ primary_track_id: string | null }>(
      `SELECT primary_track_id FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0]!.primary_track_id;
  };

  // ------------------------------------------------------------------ A. several contexts at once

  describe('a learner can be in several learning contexts at once', () => {
    it('holds a school class, a competitive exam and an Olympiad together', async () => {
      const { tenant, session } = await arrange();
      const school = await makeTrack(tenant, {
        name: 'Class 10 Mathematics',
        kind: 'school',
        gradeLabel: 'Class 10',
        gradeOrdinal: 10,
        curriculum: 'CBSE',
      });
      const exam = await makeTrack(tenant, { name: 'JEE Foundation', kind: 'competitive_exam', examFamily: 'JEE' });
      const olympiad = await makeTrack(tenant, { name: 'Mathematics Olympiad', kind: 'olympiad' });

      expect((await enrol(session, { trackId: school })).status).toBe(201);
      expect((await enrol(session, { trackId: exam })).status).toBe(201);
      expect((await enrol(session, { trackId: olympiad })).status).toBe(201);

      const res = await list(session);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect(res.body.map((e: { trackId: string }) => e.trackId).sort()).toEqual([school, exam, olympiad].sort());
      // The learning context travels with each one, so a home screen can group them without parsing names.
      const kinds = Object.fromEntries(res.body.map((e: { trackId: string; track: { kind: string } }) => [e.trackId, e.track.kind]));
      expect(kinds).toEqual({ [school]: 'school', [exam]: 'competitive_exam', [olympiad]: 'olympiad' });
      const schoolEntry = res.body.find((e: { trackId: string }) => e.trackId === school);
      expect(schoolEntry.track).toMatchObject({ gradeLabel: 'Class 10', gradeOrdinal: 10, curriculum: 'CBSE' });
    });

    it('reports an uncategorised track as null rather than guessing a kind', async () => {
      // Every track that existed before migration 0013 is in this state, and a frontend that read
      // null as "competitive exam" would reintroduce exactly the assumption being removed.
      const { tenant, session } = await arrange();
      const legacy = await makeTrack(tenant, { name: 'JEE Advanced 2027' });
      await enrol(session, { trackId: legacy });
      const entry = (await list(session)).body[0];
      expect(entry.track).toMatchObject({
        kind: null,
        educationStage: null,
        gradeLabel: null,
        gradeOrdinal: null,
        examFamily: null,
        curriculum: null,
        locale: null,
      });
    });

    it('records the learner’s own goal per track, not one goal for the learner', async () => {
      const { tenant, session } = await arrange();
      const school = await makeTrack(tenant, { name: 'Class 5 Mathematics', kind: 'school', gradeLabel: 'Class 5', gradeOrdinal: 5 });
      const exam = await makeTrack(tenant, { name: 'NEET', kind: 'competitive_exam', examFamily: 'NEET' });
      await enrol(session, { trackId: school, goalText: 'Get comfortable with fractions' });
      await enrol(session, { trackId: exam, goalText: 'Finish the biology syllabus' });
      const goals = Object.fromEntries(
        (await list(session)).body.map((e: { trackId: string; goalText: string }) => [e.trackId, e.goalText]),
      );
      expect(goals[school]).toBe('Get comfortable with fractions');
      expect(goals[exam]).toBe('Finish the biology syllabus');
    });
  });

  // ------------------------------------------------------------------ B. the primary track

  describe('the primary track', () => {
    it('makes the first enrolment primary, because a learner with tracks needs a home', async () => {
      const { tenant, student, session } = await arrange();
      const first = await makeTrack(tenant, { name: 'Class 6 Science', kind: 'school', gradeLabel: 'Class 6', gradeOrdinal: 6 });
      const second = await makeTrack(tenant, { name: 'Olympiad Science', kind: 'olympiad' });

      const one = await enrol(session, { trackId: first });
      expect(one.body.isPrimary).toBe(true);
      expect(await usersPrimary(student.id)).toBe(first);

      // A later enrolment does not take the primary slot unless asked.
      const two = await enrol(session, { trackId: second });
      expect(two.body.isPrimary).toBe(false);
      expect(await usersPrimary(student.id)).toBe(first);
    });

    it('moves the primary track, and keeps the profile column in step', async () => {
      const { tenant, student, session } = await arrange();
      const a = await makeTrack(tenant, { name: 'Class 7 Mathematics', kind: 'school', gradeLabel: 'Class 7', gradeOrdinal: 7 });
      const b = await makeTrack(tenant, { name: 'JEE Main', kind: 'competitive_exam', examFamily: 'JEE' });
      await enrol(session, { trackId: a });
      await enrol(session, { trackId: b });

      const moved = await patch(session, b, { isPrimary: true });
      expect(moved.status).toBe(200);
      expect(moved.body.isPrimary).toBe(true);
      expect(await usersPrimary(student.id)).toBe(b);

      // Exactly one primary in the enrolment table, which the database itself guarantees.
      const { rows } = await db().query<{ track_id: string }>(
        `SELECT track_id FROM learner_tracks WHERE user_id = $1 AND is_primary`,
        [student.id],
      );
      expect(rows.map((r) => r.track_id)).toEqual([b]);
    });

    it('refuses to be asked for "not primary", which is not a state a learner can be in', async () => {
      const { tenant, session } = await arrange();
      const track = await makeTrack(tenant, { name: 'Class 8 Mathematics', kind: 'school', gradeLabel: 'Class 8', gradeOrdinal: 8 });
      await enrol(session, { trackId: track });
      const res = await patch(session, track, { isPrimary: false });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toMatchObject({ field: 'isPrimary' });
    });

    it('cannot be made to hold two primary tracks, whatever order the requests arrive in', async () => {
      const { tenant, student, session } = await arrange();
      const a = await makeTrack(tenant, { name: 'Track A', kind: 'school', gradeLabel: 'Class 9', gradeOrdinal: 9 });
      const b = await makeTrack(tenant, { name: 'Track B', kind: 'olympiad' });
      await enrol(session, { trackId: a });
      await enrol(session, { trackId: b });

      await Promise.all([patch(session, a, { isPrimary: true }), patch(session, b, { isPrimary: true })]);
      const { rows } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM learner_tracks WHERE user_id = $1 AND is_primary`,
        [student.id],
      );
      expect(rows[0]!.n).toBe('1');
      // And whichever won, the profile column names the same track.
      const { rows: primary } = await db().query<{ track_id: string }>(
        `SELECT track_id FROM learner_tracks WHERE user_id = $1 AND is_primary`,
        [student.id],
      );
      expect(await usersPrimary(student.id)).toBe(primary[0]!.track_id);
    });
  });

  // ------------------------------------------------------------------ C. the older endpoint

  describe('the profile endpoint that predates enrolments', () => {
    it('sets the primary track through /me/profile and materialises the enrolment', async () => {
      const { tenant, student, session } = await arrange();
      const track = await makeTrack(tenant, { name: 'Class 4 Mathematics', kind: 'school', gradeLabel: 'Class 4', gradeOrdinal: 4 });

      const res = await t
        .http()
        .patch('/v1/me/profile')
        .set(...bearer(session))
        .send({ primaryTrackId: track });
      expect(res.status).toBe(200);
      expect(res.body.primaryTrackId).toBe(track);

      // The enrolment exists and is primary, without the learner ever calling the new endpoint.
      const entries = (await list(session)).body;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ trackId: track, isPrimary: true, status: 'active' });
      expect(await usersPrimary(student.id)).toBe(track);
    });

    it('materialises an enrolment lazily for a learner who had a primary track all along', async () => {
      // Migration 0013 back-fills nothing, so this is the state of every existing learner: a
      // primary_track_id and no enrolment row. The first read converts it, once.
      const { tenant, student, session } = await arrange();
      const track = await makeTrack(tenant, { name: 'NEET 2027', kind: 'competitive_exam', examFamily: 'NEET' });
      await db().query(`UPDATE users SET primary_track_id = $2 WHERE id = $1`, [student.id, track]);
      const { rows: none } = await db().query(`SELECT 1 FROM learner_tracks WHERE user_id = $1`, [student.id]);
      expect(none).toHaveLength(0);

      const first = await list(session);
      expect(first.status).toBe(200);
      expect(first.body).toHaveLength(1);
      expect(first.body[0]).toMatchObject({ trackId: track, isPrimary: true });

      // Idempotent: reading again does not add a second row.
      await list(session);
      const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM learner_tracks WHERE user_id = $1`, [
        student.id,
      ]);
      expect(rows[0]!.n).toBe('1');
    });

    it('leaves a learner with no primary track exactly as they were', async () => {
      // Nothing is invented for a learner who has never chosen a track.
      const { student, session } = await arrange();
      expect((await list(session)).body).toEqual([]);
      const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM learner_tracks WHERE user_id = $1`, [
        student.id,
      ]);
      expect(rows[0]!.n).toBe('0');
      expect(await usersPrimary(student.id)).toBeNull();
    });
  });

  // ------------------------------------------------------------------ D. leaving and rejoining

  describe('leaving a track', () => {
    it('keeps the enrolment as history rather than deleting it', async () => {
      const { tenant, session } = await arrange();
      const track = await makeTrack(tenant, { name: 'Class 3 Mathematics', kind: 'school', gradeLabel: 'Class 3', gradeOrdinal: 3 });
      await enrol(session, { trackId: track, goalText: 'Times tables' });

      const left = await leave(session, track);
      expect(left.status).toBe(200);
      expect(left.body).toMatchObject({ status: 'left', isPrimary: false });
      expect(left.body.leftAt).not.toBeNull();

      const entries = (await list(session)).body;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: 'left', goalText: 'Times tables' });
    });

    it('leaves the learner with no primary track, and promotes nothing in its place', async () => {
      const { tenant, student, session } = await arrange();
      const a = await makeTrack(tenant, { name: 'Primary track', kind: 'school', gradeLabel: 'Class 2', gradeOrdinal: 2 });
      const b = await makeTrack(tenant, { name: 'Second track', kind: 'olympiad' });
      await enrol(session, { trackId: a });
      await enrol(session, { trackId: b });

      await leave(session, a);
      expect(await usersPrimary(student.id)).toBeNull();
      const { rows } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM learner_tracks WHERE user_id = $1 AND is_primary`,
        [student.id],
      );
      expect(rows[0]!.n).toBe('0');
      // Which track matters most is the learner's to say, so b was not chosen for them.
      const entries = (await list(session)).body;
      expect(entries.find((e: { trackId: string }) => e.trackId === b).isPrimary).toBe(false);
    });

    it('rejoins the enrolment it already has rather than starting a second history', async () => {
      const { tenant, student, session } = await arrange();
      const track = await makeTrack(tenant, { name: 'Class 1 Mathematics', kind: 'school', gradeLabel: 'Class 1', gradeOrdinal: 1 });
      const created = await enrol(session, { trackId: track });
      await leave(session, track);
      const rejoined = await enrol(session, { trackId: track });

      expect(rejoined.status).toBe(201);
      expect(rejoined.body.id).toBe(created.body.id); // the same row
      expect(rejoined.body).toMatchObject({ status: 'active', leftAt: null });
      const { rows } = await db().query<{ n: string }>(
        `SELECT count(*) AS n FROM learner_tracks WHERE user_id = $1 AND track_id = $2`,
        [student.id, track],
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('refuses to change a track the learner has left, and says how to fix it', async () => {
      const { tenant, session } = await arrange();
      const track = await makeTrack(tenant, { name: 'Left track', kind: 'olympiad' });
      await enrol(session, { trackId: track });
      await leave(session, track);
      const res = await patch(session, track, { goalText: 'still trying' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
    });
  });

  // ------------------------------------------------------------------ E. mastery isolation

  describe('mastery is isolated per track', () => {
    it('does not move a learner’s level in one track when they practise in another', async () => {
      // Structural, not defended by a check: `ability_scores` is unique per
      // (tenant, user, subtopic) and a sub-topic belongs to exactly one track, so two tracks cannot
      // share an ability row. This test is what keeps that true.
      const { tenant, student, session } = await arrange();
      const schoolSyllabus = await createSyllabus(tenant);
      const examSyllabus = await createSyllabus(tenant);
      await db().query(`UPDATE tracks SET kind = 'school', grade_label = 'Class 9', grade_ordinal = 9 WHERE id = $1`, [
        schoolSyllabus.trackId,
      ]);
      await db().query(`UPDATE tracks SET kind = 'competitive_exam', exam_family = 'JEE' WHERE id = $1`, [examSyllabus.trackId]);
      await createEngineConfig(tenant, {});
      await insertPracticeQuestion(tenant, schoolSyllabus.subtopicId, { b: 1000 });
      await insertPracticeQuestion(tenant, examSyllabus.subtopicId, { b: 1000 });

      await enrol(session, { trackId: schoolSyllabus.trackId });
      await enrol(session, { trackId: examSyllabus.trackId });

      // Answer one question in the school track.
      const started = await t
        .http()
        .post('/v1/practice/sessions')
        .set(...bearer(session))
        .send({ subtopicId: schoolSyllabus.subtopicId });
      expect(started.status).toBe(201);
      const served = await t
        .http()
        .get(`/v1/practice/sessions/${started.body.session.id}/next`)
        .set(...bearer(session));
      expect(served.status).toBe(200);
      await ageServedItem(served.body.item.id as string, 30_000);
      const answered = await t
        .http()
        .post('/v1/practice/attempts')
        .set(...bearer(session))
        .set('Idempotency-Key', uniq('isolation'))
        .send({ sessionItemId: served.body.item.id, response: { optionKeys: ['A'] }, totalTimeMs: 30_000 });
      expect(answered.status).toBe(201);

      // One ability row exists, for the school sub-topic. The exam track has none at all.
      const { rows } = await db().query<{ subtopic_id: string; attempts_count: number }>(
        `SELECT subtopic_id, attempts_count FROM ability_scores WHERE user_id = $1`,
        [student.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subtopic_id: schoolSyllabus.subtopicId, attempts_count: 1 });
    });
  });

  // ------------------------------------------------------------------ F. isolation and validation

  describe('enrolment is scoped and validated', () => {
    it('cannot enrol in another organisation’s track', async () => {
      const { session } = await arrange();
      const other = await createTenant();
      const theirs = await makeTrack(other, { name: 'Their track', kind: 'school', gradeLabel: 'Class 5', gradeOrdinal: 5 });
      const res = await enrol(session, { trackId: theirs });
      // The same answer a track that does not exist gives, so nothing is revealed about what exists.
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('REFERENCE_NOT_FOUND');
    });

    it('cannot enrol in a track that is not published yet', async () => {
      const { tenant, session } = await arrange();
      const draft = await makeTrack(tenant, { name: 'Draft track', kind: 'school', gradeLabel: 'Class 5', gradeOrdinal: 5, status: 'draft' });
      const res = await enrol(session, { trackId: draft });
      expect(res.status).toBe(422);
    });

    it('refuses an unknown track id and a malformed one differently', async () => {
      const { session } = await arrange();
      expect((await enrol(session, { trackId: '00000000-0000-0000-0000-000000000000' })).status).toBe(422);
      expect((await enrol(session, { trackId: 'not-a-uuid' })).status).toBe(400);
    });

    it('never shows one learner another learner’s enrolments', async () => {
      const { tenant, session } = await arrange();
      const track = await makeTrack(tenant, { name: 'Shared track', kind: 'school', gradeLabel: 'Class 5', gradeOrdinal: 5 });
      await enrol(session, { trackId: track });

      const other = await createUser(tenant, 'STUDENT');
      const otherSession = await login(t, other, tenant.slug);
      expect((await list(otherSession)).body).toEqual([]);
      // ...and cannot change the first learner's enrolment by naming the same track.
      expect((await patch(otherSession, track, { isPrimary: true })).status).toBe(404);
      expect((await leave(otherSession, track)).status).toBe(404);
    });

    it('needs a signed-in learner', async () => {
      const res = await t.http().get('/v1/me/tracks');
      expect(res.status).toBe(401);
    });

    it('is not an admin endpoint', async () => {
      const { tenant } = await arrange();
      const adminUser = await createUser(tenant, 'ADMIN');
      const adminSession = await login(t, adminUser, tenant.slug);
      expect((await list(adminSession)).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------ G. the audit trail

  it('records enrolling, moving the primary track and leaving', async () => {
    const { tenant, session } = await arrange();
    const a = await makeTrack(tenant, { name: 'Audited A', kind: 'school', gradeLabel: 'Class 5', gradeOrdinal: 5 });
    const b = await makeTrack(tenant, { name: 'Audited B', kind: 'olympiad' });
    await enrol(session, { trackId: a });
    await enrol(session, { trackId: b });
    await patch(session, b, { isPrimary: true });
    await leave(session, a);

    const { rows } = await db().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_type = 'learner_track' ORDER BY occurred_at`,
      [tenant.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('learner_track.enrolled');
    expect(actions).toContain('learner_track.updated');
    expect(actions).toContain('learner_track.left');
  });
});
