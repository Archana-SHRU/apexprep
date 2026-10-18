import { randomUUID } from 'node:crypto';
import { TokenService } from '../../src/auth/token.service';
import {
  bearer,
  closeDb,
  createTenant,
  createTestApp,
  createUser,
  db,
  findSecrets,
  login,
  type Session,
  type TenantFixture,
  type TestApp,
  type UserFixture,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('RBAC and tenant isolation (e2e)', () => {
  let t: TestApp;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let platform: TenantFixture;
  let studentA: UserFixture;
  let studentA2: UserFixture;
  let adminA: UserFixture;
  let studentB: UserFixture;
  let adminB: UserFixture;
  let superAdmin: UserFixture;
  let sStudentA: Session;
  let sAdminA: Session;
  let sAdminB: Session;
  let sSuper: Session;
  let trackA: string;
  let trackB: string;

  beforeAll(async () => {
    t = await createTestApp();
    tenantA = await createTenant();
    tenantB = await createTenant();
    platform = await createTenant({ selfRegistration: false });
    studentA = await createUser(tenantA, 'STUDENT');
    studentA2 = await createUser(tenantA, 'STUDENT');
    adminA = await createUser(tenantA, 'ADMIN');
    studentB = await createUser(tenantB, 'STUDENT');
    adminB = await createUser(tenantB, 'ADMIN');
    superAdmin = await createUser(platform, 'SUPER_ADMIN');
    [sStudentA, sAdminA, sAdminB, sSuper] = await Promise.all([
      login(t, studentA, tenantA.slug),
      login(t, adminA, tenantA.slug),
      login(t, adminB, tenantB.slug),
      login(t, superAdmin, platform.slug),
    ]);
    const insertTrack = async (tenantId: string) =>
      (
        await db().query<{ id: string }>(
          `INSERT INTO tracks (tenant_id, slug, name, status) VALUES ($1, 'jee-' || substr(md5(random()::text), 1, 6), 'JEE', 'published') RETURNING id`,
          [tenantId],
        )
      ).rows[0]!.id;
    trackA = await insertTrack(tenantA.id);
    trackB = await insertTrack(tenantB.id);
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  describe('authentication is required by default', () => {
    it.each([
      ['GET', '/v1/auth/me'],
      ['PATCH', '/v1/me/profile'],
      ['GET', '/v1/admin/students'],
      ['GET', '/v1/admin/tenants'],
    ])('%s %s → 401 without a token', async (method, path) => {
      const res = await t.http()[method.toLowerCase() as 'get' | 'patch'](path).send({});
      expect(res.status).toBe(401);
      expect((res.body as Json).error.code).toBe('UNAUTHENTICATED');
    });

    it('public health checks need no token', async () => {
      expect((await t.http().get('/v1/health/live')).status).toBe(200);
      expect((await t.http().get('/v1/health/ready')).body).toMatchObject({ status: 'ok', database: 'ok' });
    });
  });

  describe('student role', () => {
    it('can update their own profile and complete onboarding', async () => {
      const res = await t
        .http()
        .patch('/v1/me/profile')
        .set(...bearer(sStudentA))
        .send({ primaryTrackId: trackA, goal: 'IIT Bombay CSE', targetRank: 500, dailyQuestionGoal: 40, targetExamDate: '2027-05-23', completeOnboarding: true });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: studentA.id,
        primaryTrackId: trackA,
        goal: 'IIT Bombay CSE',
        targetRank: 500,
        dailyQuestionGoal: 40,
        targetExamDate: '2027-05-23',
        onboarded: true,
      });
      expect(findSecrets(res.body)).toEqual([]);
    });

    it('is refused admin and platform routes with 403', async () => {
      for (const path of ['/v1/admin/students', `/v1/admin/students/${studentA2.id}`, '/v1/admin/tenants']) {
        const res = await t.http().get(path).set(...bearer(sStudentA));
        expect({ path, status: res.status, code: (res.body as Json).error?.code }).toEqual({ path, status: 403, code: 'FORBIDDEN' });
      }
      const res = await t.http().patch(`/v1/admin/users/${studentA2.id}/status`).set(...bearer(sStudentA)).send({ status: 'disabled' });
      expect(res.status).toBe(403);
    });
  });

  describe('admin role', () => {
    it('lists only students of their own organisation, with cursor pagination', async () => {
      const first = await t.http().get('/v1/admin/students?limit=1').set(...bearer(sAdminA));
      expect(first.status).toBe(200);
      const page1 = first.body as Json;
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toEqual(expect.any(String));

      const second = await t.http().get(`/v1/admin/students?limit=10&cursor=${page1.nextCursor as string}`).set(...bearer(sAdminA));
      const ids = [...page1.items, ...(second.body as Json).items].map((u: Json) => u.id);
      expect(ids.sort()).toEqual([studentA.id, studentA2.id].sort());
      expect(ids).not.toContain(studentB.id);
      expect(ids).not.toContain(adminA.id); // staff are not "students"
      expect(findSecrets([first.body, second.body])).toEqual([]);
    });

    it('can search students by email', async () => {
      const res = await t.http().get(`/v1/admin/students?search=${encodeURIComponent(studentA2.email.slice(0, 12))}`).set(...bearer(sAdminA));
      expect((res.body as Json).items.map((u: Json) => u.id)).toEqual([studentA2.id]);
    });

    it('rejects a forged cursor', async () => {
      const res = await t.http().get('/v1/admin/students?cursor=bm90LWEtY3Vyc29y').set(...bearer(sAdminA));
      expect(res.status).toBe(400);
      expect((res.body as Json).error.details[0]).toMatchObject({ field: 'cursor' });
    });

    it('cannot use student self-service routes', async () => {
      const res = await t.http().patch('/v1/me/profile').set(...bearer(sAdminA)).send({ goal: 'x' });
      expect(res.status).toBe(403);
    });

    it('cannot reach platform administration', async () => {
      expect((await t.http().get('/v1/admin/tenants').set(...bearer(sAdminA))).status).toBe(403);
      expect((await t.http().get(`/v1/admin/tenants/${tenantA.id}/users`).set(...bearer(sAdminA))).status).toBe(403);
    });

    it('can disable a student, which ends their sessions immediately, and the change is audited', async () => {
      const victim = await createUser(tenantA);
      const sVictim = await login(t, victim, tenantA.slug);
      const res = await t.http().patch(`/v1/admin/users/${victim.id}/status`).set(...bearer(sAdminA)).send({ status: 'disabled' });
      expect(res.status).toBe(200);
      expect((res.body as Json).status).toBe('disabled');
      expect((await t.http().get('/v1/auth/me').set(...bearer(sVictim))).status).toBe(401);
      expect((await t.http().post('/v1/auth/refresh').set('Cookie', sVictim.refreshCookie).send({})).status).toBe(401);

      const audit = await db().query(
        `SELECT actor_user_id, actor_role, before, after, request_id FROM audit_log WHERE action = 'user.status_changed' AND entity_id = $1`,
        [victim.id],
      );
      expect(audit.rows).toEqual([
        {
          actor_user_id: adminA.id,
          actor_role: 'ADMIN',
          before: { status: 'active' },
          after: { status: 'disabled' },
          request_id: res.headers['x-request-id'],
        },
      ]);
    });

    it('cannot change the status of another admin or of themselves', async () => {
      const otherAdmin = await createUser(tenantA, 'ADMIN');
      expect((await t.http().patch(`/v1/admin/users/${otherAdmin.id}/status`).set(...bearer(sAdminA)).send({ status: 'disabled' })).status).toBe(403);
      expect((await t.http().patch(`/v1/admin/users/${adminA.id}/status`).set(...bearer(sAdminA)).send({ status: 'disabled' })).status).toBe(422);
    });
  });

  describe('tenant isolation', () => {
    it("an admin gets 404 (not 403) for another organisation's student", async () => {
      const res = await t.http().get(`/v1/admin/students/${studentB.id}`).set(...bearer(sAdminA));
      expect(res.status).toBe(404);
    });

    it("an admin cannot change another organisation's user", async () => {
      const res = await t.http().patch(`/v1/admin/users/${studentB.id}/status`).set(...bearer(sAdminA)).send({ status: 'disabled' });
      expect(res.status).toBe(404);
      const { rows } = await db().query('SELECT status, token_version FROM users WHERE id = $1', [studentB.id]);
      expect(rows[0]).toEqual({ status: 'active', token_version: 0 });
      const audit = await db().query(`SELECT 1 FROM audit_log WHERE entity_id = $1`, [studentB.id]);
      expect(audit.rowCount).toBe(0);
    });

    it('each admin sees only their own students', async () => {
      const b = await t.http().get('/v1/admin/students?limit=100').set(...bearer(sAdminB));
      expect((b.body as Json).items.map((u: Json) => u.id)).toEqual([studentB.id]);
    });

    it('ignores nothing: a tenantId in the body is rejected outright', async () => {
      const res = await t.http().patch('/v1/me/profile').set(...bearer(sStudentA)).send({ tenantId: tenantB.id, goal: 'x' });
      expect(res.status).toBe(400);
    });

    it("a student cannot pick another organisation's track", async () => {
      const res = await t.http().patch('/v1/me/profile').set(...bearer(sStudentA)).send({ primaryTrackId: trackB });
      expect(res.status).toBe(422);
      expect((res.body as Json).error.code).toBe('REFERENCE_NOT_FOUND');
    });

    it('a validly signed token claiming a different tenant is rejected (tenant comes from the database, not the claim)', async () => {
      const forged = t.app
        .get(TokenService)
        .signAccessToken({ userId: studentA.id, tenantId: tenantB.id, role: 'STUDENT', tokenVersion: 0 });
      expect((await t.http().get('/v1/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    });

    it('a token claiming a higher role does not grant it (role comes from the database)', async () => {
      const inflated = t.app
        .get(TokenService)
        .signAccessToken({ userId: studentA.id, tenantId: tenantA.id, role: 'SUPER_ADMIN', tokenVersion: 0 });
      const res = await t.http().get('/v1/admin/tenants').set('Authorization', `Bearer ${inflated}`);
      expect(res.status).toBe(403);
    });
  });

  describe('super admin', () => {
    it('lists organisations and can read another organisation\'s users', async () => {
      const tenants = await t.http().get('/v1/admin/tenants?limit=100').set(...bearer(sSuper));
      expect(tenants.status).toBe(200);
      expect((tenants.body as Json).items.map((x: Json) => x.id)).toEqual(expect.arrayContaining([tenantA.id, tenantB.id]));

      const users = await t.http().get(`/v1/admin/tenants/${tenantB.id}/users`).set(...bearer(sSuper));
      expect(users.status).toBe(200);
      expect((users.body as Json).items.map((u: Json) => u.id).sort()).toEqual([studentB.id, adminB.id].sort());
    });

    it('creates an organisation (sign-up closed by default) and an admin in it, both audited', async () => {
      const slug = `org-${randomUUID().slice(0, 8)}`;
      const created = await t.http().post('/v1/admin/tenants').set(...bearer(sSuper)).send({ slug, name: 'New Org' });
      expect(created.status).toBe(201);
      const org = created.body as Json;
      expect(org).toMatchObject({ slug, selfRegistrationEnabled: false, status: 'active' });

      const dup = await t.http().post('/v1/admin/tenants').set(...bearer(sSuper)).send({ slug, name: 'Again' });
      expect(dup.status).toBe(409);
      expect((dup.body as Json).error.code).toBe('SLUG_TAKEN');

      const admin = await t
        .http()
        .post(`/v1/admin/tenants/${org.id as string}/admins`)
        .set(...bearer(sSuper))
        .send({ email: 'Head@New-Org.test', displayName: 'Head Admin', password: 'initial-pass-123' });
      expect(admin.status).toBe(201);
      expect(admin.body).toMatchObject({ role: 'ADMIN', tenantId: org.id, email: 'head@new-org.test' });
      expect(findSecrets(admin.body)).toEqual([]);

      const newAdminLogin = await t.http().post('/v1/auth/login').send({ email: 'head@new-org.test', password: 'initial-pass-123', tenantSlug: slug });
      expect(newAdminLogin.status).toBe(200);

      const audit = await db().query(`SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY occurred_at`, [org.id]);
      expect(audit.rows.map((r: Json) => r.action)).toEqual(['tenant.created', 'user.created']);
    });

    it('suspending an organisation signs its users out', async () => {
      const org = await createTenant();
      const member = await createUser(org);
      const s = await login(t, member, org.slug);
      const res = await t.http().patch(`/v1/admin/tenants/${org.id}`).set(...bearer(sSuper)).send({ status: 'suspended' });
      expect(res.status).toBe(200);
      expect((await t.http().get('/v1/auth/me').set(...bearer(s))).status).toBe(401);
    });

    it('returns 404 for an unknown or malformed tenant id', async () => {
      expect((await t.http().patch(`/v1/admin/tenants/${randomUUID()}`).set(...bearer(sSuper)).send({ name: 'x' })).status).toBe(404);
      expect((await t.http().get('/v1/admin/tenants/not-a-uuid/users').set(...bearer(sSuper))).status).toBe(404);
    });
  });
});
