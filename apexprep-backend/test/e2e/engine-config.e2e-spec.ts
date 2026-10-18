import { engineParamsJson } from '../fixtures/engine-params';
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
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Engine configuration (e2e)', () => {
  let t: TestApp;
  let tenant: TenantFixture;
  let platform: TenantFixture;
  let admin: Session;
  let student: Session;
  let superAdmin: Session;

  const create = (body: Record<string, unknown>, target: TenantFixture = tenant, as: Session = superAdmin) =>
    t.http().post(`/v1/admin/tenants/${target.id}/engine-config`).set(...bearer(as)).send(body);

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant();
    platform = await createTenant({ selfRegistration: false });
    const [adminUser, studentUser, superUser] = await Promise.all([
      createUser(tenant, 'ADMIN'),
      createUser(tenant, 'STUDENT'),
      createUser(platform, 'SUPER_ADMIN'),
    ]);
    [admin, student, superAdmin] = await Promise.all([
      login(t, adminUser, tenant.slug),
      login(t, studentUser, tenant.slug),
      login(t, superUser, platform.slug),
    ]);
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  describe('reading', () => {
    it('tells an admin when the organisation has no configuration yet', async () => {
      const res = await t.http().get('/v1/admin/engine-config').set(...bearer(admin));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ENGINE_CONFIG_MISSING');
    });

    it('returns the active version, flagged valid and provisional', async () => {
      await createEngineConfig(tenant);
      const res = await t.http().get('/v1/admin/engine-config').set(...bearer(admin));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: 1, isActive: true, paramsValid: true, provisional: true });
      expect(res.body.paramsIssues).toEqual([]);
      expect(res.body.params.target_success).toBe(0.72);
    });

    it('reports exactly which keys are missing from a version that predates a parameter', async () => {
      const other = await createTenant();
      await db().query(
        `INSERT INTO engine_config (tenant_id, version, params, change_note, is_active, activated_at)
         VALUES ($1, 1, '{"elo_scale": 400}'::jsonb, 'incomplete', true, now())`,
        [other.id],
      );
      const otherAdmin = await login(t, await createUser(other, 'ADMIN'), other.slug);
      const res = await t.http().get('/v1/admin/engine-config').set(...bearer(otherAdmin));
      expect(res.status).toBe(200);
      expect(res.body.paramsValid).toBe(false);
      expect(res.body.paramsIssues.map((i: Json) => i.field)).toEqual(
        expect.arrayContaining(['params.k_student', 'params.k_question', 'params.probe', 'params.level_bands', 'params.cold_start']),
      );
    });

    it('is closed to students, and never shows another organisation', async () => {
      expect((await t.http().get('/v1/admin/engine-config').set(...bearer(student))).status).toBe(403);
      const foreign = await t.http().get(`/v1/admin/tenants/${tenant.id}/engine-config`).set(...bearer(admin));
      expect(foreign.status).toBe(403); // a tenant admin has engine_config:read, not :manage
    });
  });

  describe('creating versions', () => {
    it('rejects a parameter set with a missing key, naming it, and stores nothing', async () => {
      const params = engineParamsJson();
      delete (params).probe;
      const res = await create({ params, changeNote: 'missing probe settings' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((d: Json) => d.field)).toContain('params.probe');

      const versions = await t.http().get('/v1/admin/engine-config/versions').set(...bearer(admin));
      expect(versions.body.items).toHaveLength(1);
    });

    it('rejects an out-of-range value', async () => {
      const res = await create({ params: engineParamsJson({ target_success: 1.5 }), changeNote: 'bad target' });
      expect(res.status).toBe(400);
      expect(res.body.error.details.map((d: Json) => d.field)).toContain('params.target_success');
    });

    it('creates the next version without activating it by default', async () => {
      const res = await create({ params: engineParamsJson({ k_student: { steady: 24 } }), changeNote: 'calmer student updates' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ version: 2, isActive: false, paramsValid: true, changeNote: 'calmer student updates' });

      const active = await t.http().get('/v1/admin/engine-config').set(...bearer(admin));
      expect(active.body).toMatchObject({ version: 1 });
    });

    it('can create and activate in one step, deactivating the previous version', async () => {
      const res = await create({ params: engineParamsJson({ k_student: { steady: 20 } }), changeNote: 'activate on create', activate: true });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ version: 3, isActive: true });

      const active = await t.http().get('/v1/admin/engine-config').set(...bearer(admin));
      expect(active.body).toMatchObject({ version: 3, params: { k_student: { steady: 20 } } });

      const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM engine_config WHERE tenant_id = $1 AND is_active`, [tenant.id]);
      expect(rows[0]!.n).toBe('1');
    });

    it('writes audit rows from inside the database for creation, activation and deactivation', async () => {
      const { rows } = await db().query<{ action: string }>(
        `SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_type = 'engine_config' ORDER BY occurred_at`,
        [tenant.id],
      );
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining(['engine_config.created', 'engine_config.activated', 'engine_config.deactivated', 'engine_config.platform_created']),
      );

      // The database rows record the event; the service row names the platform administrator,
      // who cannot be referenced by the tenant-scoped created_by column.
      const { rows: platform } = await db().query<{ actor_user_id: string | null; actor_role: string }>(
        `SELECT actor_user_id, actor_role FROM audit_log WHERE tenant_id = $1 AND action = 'engine_config.platform_created' LIMIT 1`,
        [tenant.id],
      );
      expect(platform[0]).toMatchObject({ actor_role: 'SUPER_ADMIN' });
      expect(platform[0]!.actor_user_id).not.toBeNull();
    });

    it('refuses a version whose parameters are only half-filled, even from a super admin', async () => {
      const res = await create({ params: { elo_scale: 400 }, changeNote: 'half a config' });
      expect(res.status).toBe(400);
      expect(res.body.error.details.length).toBeGreaterThan(5);
    });
  });

  describe('activation', () => {
    it('activates a stored version and refuses to activate it twice', async () => {
      const versions = await t.http().get('/v1/admin/engine-config/versions').set(...bearer(admin));
      const v2 = (versions.body as Json).items.find((v: Json) => v.version === 2);

      const activated = await t.http().post(`/v1/admin/tenants/${tenant.id}/engine-config/versions/${v2.id}/activate`).set(...bearer(superAdmin));
      expect(activated.status).toBe(200);
      expect(activated.body).toMatchObject({ version: 2, isActive: true });
      expect(activated.body.deactivatedAt).toBeNull();

      const again = await t.http().post(`/v1/admin/tenants/${tenant.id}/engine-config/versions/${v2.id}/activate`).set(...bearer(superAdmin));
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('INVALID_STATE');
    });

    it('refuses to activate a version the engine could not run on', async () => {
      const { rows } = await db().query<{ id: string }>(
        `INSERT INTO engine_config (tenant_id, version, params, change_note)
         VALUES ($1, 99, '{"elo_scale": 400}'::jsonb, 'imported, incomplete') RETURNING id`,
        [tenant.id],
      );
      const res = await t.http().post(`/v1/admin/tenants/${tenant.id}/engine-config/versions/${rows[0]!.id}/activate`).set(...bearer(superAdmin));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ENGINE_CONFIG_INVALID');
    });

    it('keeps exactly one version active throughout', async () => {
      const { rows } = await db().query<{ n: string }>(`SELECT count(*) AS n FROM engine_config WHERE tenant_id = $1 AND is_active`, [tenant.id]);
      expect(rows[0]!.n).toBe('1');
    });
  });

  describe('immutability and isolation', () => {
    it('cannot change a stored version through the database', async () => {
      const { rows } = await db().query<{ id: string }>(`SELECT id FROM engine_config WHERE tenant_id = $1 LIMIT 1`, [tenant.id]);
      await expect(db().query(`UPDATE engine_config SET params = '{}'::jsonb WHERE id = $1`, [rows[0]!.id])).rejects.toMatchObject({ code: 'AP001' });
    });

    it('is refused to tenant admins and students', async () => {
      const body = { params: engineParamsJson(), changeNote: 'not allowed' };
      expect((await create(body, tenant, admin)).status).toBe(403);
      expect((await create(body, tenant, student)).status).toBe(403);
    });

    it('lets a super admin manage another organisation, but never mixes the two', async () => {
      const other = await createTenant();
      const res = await create({ params: engineParamsJson({ k_student: { steady: 99 } }), changeNote: 'for the other organisation', activate: true }, other);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ tenantId: other.id, version: 1 });

      const ours = await t.http().get('/v1/admin/engine-config').set(...bearer(admin));
      expect(ours.body.params.k_student.steady).not.toBe(99);
    });
  });

  describe('what the question bank reads', () => {
    it('uses the active version to set a new question’s starting difficulty', async () => {
      const fresh = await createTenant();
      const freshAdmin = await login(t, await createUser(fresh, 'ADMIN'), fresh.slug);
      const syl = await createSyllabus(fresh);
      await create({ params: engineParamsJson({ initial_b_by_level: { '1': 111, '2': 222, '3': 333, '4': 444, '5': 555 } }), changeNote: 'custom scale', activate: true }, fresh);

      const question = await t
        .http()
        .post('/v1/admin/questions')
        .set(...bearer(freshAdmin))
        .send({ subtopicId: syl.subtopicId, type: 'long_form', stem: 'Derive the result.', difficultyLabel: 3, expectedTimeSeconds: 300 });
      expect(question.status).toBe(201);
      expect(question.body.difficultyB).toBe(333);
    });
  });
});
