import { randomUUID } from 'node:crypto';
import { bearer, closeDb, createEngineConfig, createTenant, createTestApp, createUser, login, type Session, type TenantFixture, type TestApp } from './helpers';

/**
 * The admin surface is closed to students — proven over **every** registered `/v1/admin/*` route, not a
 * hand-picked sample, so an admin route added later is covered the day it exists.
 *
 * Guards run before parameter pipes and body validation, so a student is refused with 403 whatever path
 * parameters or body the route would otherwise want; the placeholder UUIDs below never reach a handler.
 */
describe('admin access control (e2e)', () => {
  let t: TestApp;
  let tenant: TenantFixture;
  let student: Session;
  let admin: Session;
  let superAdmin: Session;

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant();
    await createEngineConfig(tenant);
    const [s, a, sa] = await Promise.all([createUser(tenant, 'STUDENT'), createUser(tenant, 'ADMIN'), createUser(tenant, 'SUPER_ADMIN')]);
    [student, admin, superAdmin] = await Promise.all([login(t, s, tenant.slug), login(t, a, tenant.slug), login(t, sa, tenant.slug)]);
  });

  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  /** Every route the HTTP server actually registered under /v1/admin, with its method. */
  function adminRoutes(): { method: string; path: string }[] {
    const instance = t.app.getHttpAdapter().getInstance() as { _router?: { stack: Layer[] }; router?: { stack: Layer[] } };
    const stack = instance.router?.stack ?? instance._router?.stack ?? [];
    const routes: { method: string; path: string }[] = [];
    for (const layer of stack) {
      const route = layer.route;
      if (!route || typeof route.path !== 'string' || !/^\/v\d+\/admin(\/|$)/.test(route.path)) continue;
      for (const [method, on] of Object.entries(route.methods ?? {})) if (on && method !== '_all') routes.push({ method, path: route.path });
    }
    return routes;
  }
  const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, () => randomUUID());
  const call = (method: string, path: string) => (t.http() as unknown as Record<string, (p: string) => ReturnType<ReturnType<TestApp['http']>['get']>>)[method]!(path);

  it('finds the admin surface it is testing', () => {
    const routes = adminRoutes();
    // Syllabus, questions, ingestion, explanations review, engine config, students, tenants, generated questions.
    expect(routes.length).toBeGreaterThan(40);
    for (const prefix of ['/v1/admin/tracks', '/v1/admin/questions', '/v1/admin/ingestion', '/v1/admin/students', '/v1/admin/engine-config', '/v1/admin/tenants']) {
      expect(routes.some((r) => r.path.startsWith(prefix))).toBe(true);
    }
  });

  it('CASE B: a student gets 403 from every admin API route', async () => {
    const leaks: string[] = [];
    for (const { method, path } of adminRoutes()) {
      const res = await call(method, concrete(path)).set(...bearer(student)).send({});
      if (res.status !== 403) leaks.push(`${method.toUpperCase()} ${path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('unauthenticated callers get 401 from every admin API route', async () => {
    const leaks: string[] = [];
    for (const { method, path } of adminRoutes()) {
      const res = await call(method, concrete(path)).send({});
      if (res.status !== 401) leaks.push(`${method.toUpperCase()} ${path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('a 403 to a student carries no admin data', async () => {
    const res = await t.http().get('/v1/admin/students').set(...bearer(student));
    expect(res.status).toBe(403);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('CASE D: an admin reaches the admin APIs their permissions allow, and not the platform ones', async () => {
    for (const path of ['/v1/admin/tracks', '/v1/admin/students', '/v1/admin/ingestion/jobs', '/v1/admin/questions', '/v1/admin/engine-config', '/v1/admin/generated-questions']) {
      const res = await t.http().get(path).set(...bearer(admin));
      expect([path, res.status]).toEqual([path, 200]);
    }
    // Platform administration is SUPER_ADMIN-only: the per-route permissions still decide inside the surface.
    expect((await t.http().get('/v1/admin/tenants').set(...bearer(admin))).status).toBe(403);
  });

  it('SUPER_ADMIN reaches tenant and platform admin APIs', async () => {
    for (const path of ['/v1/admin/tracks', '/v1/admin/students', '/v1/admin/tenants']) {
      const res = await t.http().get(path).set(...bearer(superAdmin));
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it('/auth/me reports the real role the frontend gates on', async () => {
    expect((await t.http().get('/v1/auth/me').set(...bearer(student))).body.role).toBe('STUDENT');
    expect((await t.http().get('/v1/auth/me').set(...bearer(admin))).body.role).toBe('ADMIN');
    expect((await t.http().get('/v1/auth/me').set(...bearer(superAdmin))).body.role).toBe('SUPER_ADMIN');
  });

  it('CASE E: after logout the browser cannot get back into the admin APIs', async () => {
    const fresh = await login(t, await createUser(tenant, 'ADMIN'), tenant.slug);
    expect((await t.http().get('/v1/admin/students').set(...bearer(fresh))).status).toBe(200);

    // Logout revokes this device's refresh token: the app discards its in-memory access token on logout, and
    // the cookie it would use to get a new one no longer works — so a reload or "back" cannot restore access.
    expect((await t.http().post('/v1/auth/logout').set('Cookie', fresh.refreshCookie).send({})).status).toBe(204);
    expect((await t.http().post('/v1/auth/refresh').set('Cookie', fresh.refreshCookie).send({})).status).toBe(401);

    // "Sign out everywhere" also invalidates outstanding access tokens immediately (token_version).
    const other = await login(t, await createUser(tenant, 'ADMIN'), tenant.slug);
    expect((await t.http().post('/v1/auth/logout').set('Cookie', other.refreshCookie).send({ allDevices: true })).status).toBe(204);
    expect((await t.http().get('/v1/admin/students').set(...bearer(other))).status).toBe(401);
  });

  it('keeps an admin inside their own organisation', async () => {
    const elsewhere = await createTenant();
    const theirStudent = await createUser(elsewhere, 'STUDENT');
    expect((await t.http().get(`/v1/admin/students/${theirStudent.id}`).set(...bearer(admin))).status).toBe(404);
  });
});

interface Layer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
}
