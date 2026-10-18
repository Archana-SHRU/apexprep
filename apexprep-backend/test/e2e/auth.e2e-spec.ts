import { createHmac, randomUUID } from 'node:crypto';
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
  refreshCookieFrom,
  uniq,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Auth (e2e)', () => {
  let t: TestApp;
  let tenant: TenantFixture;
  const responses: unknown[] = []; // every body we receive is scanned for secrets at the end

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant({ selfRegistration: true });
  });
  afterAll(async () => {
    await t.close();
    await closeDb();
  });

  const keep = <T extends { body: unknown }>(res: T): T => {
    responses.push(res.body);
    return res;
  };

  const register = (overrides: Json = {}) =>
    t
      .http()
      .post('/v1/auth/register')
      .send({ displayName: 'Arjun Verma', email: `${uniq('s')}@example.test`, password: 'correct-horse-9', tenantSlug: tenant.slug, ...overrides })
      .then(keep);

  describe('POST /v1/auth/register', () => {
    it('creates a STUDENT, signs them in and sets an HttpOnly refresh cookie', async () => {
      const email = `${uniq('new')}@Example.TEST`;
      const res = await register({ email });

      expect(res.status).toBe(201);
      const body = res.body as Json;
      expect(body).toEqual({
        accessToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: 900,
        user: expect.objectContaining({
          email: email.toLowerCase(),
          displayName: 'Arjun Verma',
          role: 'STUDENT',
          status: 'active',
          tenantId: tenant.id,
          emailVerified: false,
          onboarded: false,
        }),
      });
      expect(body.refreshToken).toBeUndefined(); // browsers only ever get it in the cookie

      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('apx_refresh='))!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/v1\/auth/);
      expect(cookie).toMatch(/SameSite=Strict/);

      const { rows } = await db().query('SELECT password_hash, role FROM users WHERE id = $1', [body.user.id]);
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0].role).toBe('STUDENT');
    });

    it('rejects a duplicate email in the same organisation (case-insensitive) with 409 EMAIL_TAKEN', async () => {
      const email = `${uniq('dup')}@example.test`;
      expect((await register({ email })).status).toBe(201);
      const again = await register({ email: email.toUpperCase() });
      expect(again.status).toBe(409);
      expect((again.body as Json).error).toMatchObject({ code: 'EMAIL_TAKEN', requestId: expect.any(String) });
    });

    it('allows the same email in a different organisation', async () => {
      const other = await createTenant({ selfRegistration: true });
      const email = `${uniq('shared')}@example.test`;
      expect((await register({ email })).status).toBe(201);
      expect((await register({ email, tenantSlug: other.slug })).status).toBe(201);
    });

    it('validates email, password and name with field-level details', async () => {
      const res = await register({ email: 'not-an-email', password: 'short', displayName: '' });
      expect(res.status).toBe(400);
      const error = (res.body as Json).error;
      expect(error.code).toBe('VALIDATION_FAILED');
      const fields = (error.details as Json[]).map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['email', 'password', 'displayName']));
    });

    it('rejects a password equal to the email address', async () => {
      const email = `${uniq('same')}@example.test`;
      const res = await register({ email, password: email });
      expect(res.status).toBe(400);
      expect((res.body as Json).error.details[0]).toMatchObject({ field: 'password' });
    });

    it('refuses privilege-escalation fields (role, tenantId) instead of ignoring them', async () => {
      const res = await register({ role: 'SUPER_ADMIN', tenantId: randomUUID() });
      expect(res.status).toBe(400);
      const fields = ((res.body as Json).error.details as Json[]).map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['role', 'tenantId']));
    });

    it('refuses sign-up where the organisation has not opened registration', async () => {
      const closed = await createTenant({ selfRegistration: false });
      const res = await register({ tenantSlug: closed.slug });
      expect(res.status).toBe(403);
      expect((res.body as Json).error.code).toBe('REGISTRATION_CLOSED');
    });

    it('returns 404 TENANT_NOT_FOUND for an unknown organisation', async () => {
      const res = await register({ tenantSlug: 'no-such-org' });
      expect(res.status).toBe(404);
      expect((res.body as Json).error.code).toBe('TENANT_NOT_FOUND');
    });

    it('rejects malformed JSON with a clean 400', async () => {
      const res = await t.http().post('/v1/auth/register').set('Content-Type', 'application/json').send('{"email":').then(keep);
      expect(res.status).toBe(400);
      expect((res.body as Json).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /v1/auth/login', () => {
    it('signs in with the correct password and records last login', async () => {
      const user = await createUser(tenant);
      const res = await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: tenant.slug }).then(keep);
      expect(res.status).toBe(200);
      expect((res.body as Json).user).toMatchObject({ id: user.id, role: 'STUDENT', lastLoginAt: expect.any(String) });
      expect(refreshCookieFrom(res)).toMatch(/^apx_refresh=[A-Za-z0-9_-]{43}$/);
    });

    it('upgrades a weaker password hash to the configured parameters on login', async () => {
      const user = await createUser(tenant); // fixture uses m=4096
      await login(t, user, tenant.slug);
      const { rows } = await db().query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
      expect(rows[0].password_hash).toMatch(/\$m=19456,t=2,p=1\$/);
    });

    it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
      const user = await createUser(tenant);
      const res = await t.http().post('/v1/auth/login').send({ email: user.email, password: 'wrong-password-1', tenantSlug: tenant.slug }).then(keep);
      expect(res.status).toBe(401);
      expect((res.body as Json).error.code).toBe('INVALID_CREDENTIALS');
    });

    it('answers an unknown email exactly like a wrong password', async () => {
      const res = await t.http().post('/v1/auth/login').send({ email: 'nobody@example.test', password: 'whatever-123', tenantSlug: tenant.slug }).then(keep);
      expect(res.status).toBe(401);
      expect((res.body as Json).error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    });

    it('does not let a user of one organisation sign in to another', async () => {
      const other = await createTenant();
      const user = await createUser(tenant);
      const res = await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: other.slug });
      expect(res.status).toBe(401);
    });

    it('locks the account after repeated failures, even for the right password', async () => {
      const user = await createUser(tenant);
      for (let i = 0; i < 10; i++) {
        await t.http().post('/v1/auth/login').send({ email: user.email, password: `wrong-${i}-xxxx`, tenantSlug: tenant.slug });
      }
      const res = await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: tenant.slug }).then(keep);
      expect(res.status).toBe(429);
      expect((res.body as Json).error.code).toBe('TOO_MANY_ATTEMPTS');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('refuses a disabled account after a correct password', async () => {
      const user = await createUser(tenant, 'STUDENT', { status: 'disabled' });
      const res = await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: tenant.slug });
      expect(res.status).toBe(403);
      expect((res.body as Json).error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('access tokens and GET /v1/auth/me', () => {
    it('returns the signed-in user for a valid access token', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);
      const res = await t.http().get('/v1/auth/me').set(...bearer(s)).then(keep);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: user.id, email: user.email, tenantId: tenant.id, role: 'STUDENT' });
    });

    it('rejects missing, malformed, tampered and foreign-signed tokens with 401', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);
      const [h, p] = s.accessToken.split('.') as [string, string];
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Json;
      const forgedPayload = Buffer.from(JSON.stringify({ ...payload, role: 'SUPER_ADMIN' })).toString('base64url');
      const foreignSig = createHmac('sha256', 'some-other-secret-that-is-long-enough').update(`${h}.${p}`).digest('base64url');
      const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');

      const attempts: Array<[string, string | undefined]> = [
        ['no header', undefined],
        ['not bearer', `Basic ${s.accessToken}`],
        ['garbage', 'Bearer abc.def.ghi'],
        ['tampered payload', `Bearer ${h}.${forgedPayload}.${s.accessToken.split('.')[2]}`],
        ['foreign signature', `Bearer ${h}.${p}.${foreignSig}`],
        ['alg none', `Bearer ${noneHeader}.${p}.`],
      ];
      for (const [label, header] of attempts) {
        const req = t.http().get('/v1/auth/me');
        const res = await (header ? req.set('Authorization', header) : req);
        expect({ label, status: res.status }).toEqual({ label, status: 401 });
      }
    });

    it('rejects an expired access token with TOKEN_EXPIRED', async () => {
      const user = await createUser(tenant);
      const issuedAnHourAgo = Math.floor(Date.now() / 1000) - 3600; // 15-minute token, long expired
      const expired = t.app
        .get(TokenService)
        .signAccessToken({ userId: user.id, tenantId: tenant.id, role: 'STUDENT', tokenVersion: 0 }, issuedAnHourAgo);
      const res = await t.http().get('/v1/auth/me').set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
      expect((res.body as Json).error.code).toBe('TOKEN_EXPIRED');
    });

    it('stops accepting a token as soon as the account is disabled', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);
      await db().query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [user.id]);
      const res = await t.http().get('/v1/auth/me').set(...bearer(s));
      expect(res.status).toBe(401);
    });

    it('stops accepting tokens when the organisation is suspended', async () => {
      const suspended = await createTenant();
      const user = await createUser(suspended);
      const s = await login(t, user, suspended.slug);
      await db().query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [suspended.id]);
      expect((await t.http().get('/v1/auth/me').set(...bearer(s))).status).toBe(401);
    });
  });

  describe('POST /v1/auth/refresh (rotation)', () => {
    it('issues a new access token and a new refresh token, and revokes the old one', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);

      const first = await t.http().post('/v1/auth/refresh').set('Cookie', s.refreshCookie).send({}).then(keep);
      expect(first.status).toBe(200);
      const rotatedCookie = refreshCookieFrom(first);
      expect(rotatedCookie).not.toEqual(s.refreshCookie);
      expect((first.body as Json).accessToken).toEqual(expect.any(String));

      const next = await t.http().post('/v1/auth/refresh').set('Cookie', rotatedCookie).send({});
      expect(next.status).toBe(200);

      const { rows } = await db().query(
        `SELECT revoked_reason, count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 GROUP BY 1 ORDER BY 1`,
        [user.id],
      );
      expect(rows).toEqual([
        { revoked_reason: 'rotated', n: 2 },
        { revoked_reason: null, n: 1 },
      ]);
    });

    it('treats reuse of a rotated token as theft: revokes the whole family and audits it', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);
      const rotated = refreshCookieFrom(await t.http().post('/v1/auth/refresh').set('Cookie', s.refreshCookie).send({}));

      const replay = await t.http().post('/v1/auth/refresh').set('Cookie', s.refreshCookie).send({}).then(keep);
      expect(replay.status).toBe(401);
      expect((replay.body as Json).error.code).toBe('TOKEN_INVALID');

      // The legitimate successor is now dead too.
      expect((await t.http().post('/v1/auth/refresh').set('Cookie', rotated).send({})).status).toBe(401);

      const audit = await db().query(
        `SELECT actor_role FROM audit_log WHERE action = 'auth.refresh_token_reuse_detected' AND entity_id = $1`,
        [user.id],
      );
      expect(audit.rows).toEqual([{ actor_role: 'SYSTEM' }]);
    });

    it('accepts the token in the JSON body for non-browser clients', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);
      const res = await t.http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken });
      expect(res.status).toBe(200);
    });

    it('validates the refresh token payload', async () => {
      const res = await t.http().post('/v1/auth/refresh').send({ refreshToken: 'not a token' });
      expect(res.status).toBe(400);
      expect((res.body as Json).error.details[0]).toMatchObject({ field: 'refreshToken' });
    });

    it('rejects an unknown token and a request with no token', async () => {
      expect((await t.http().post('/v1/auth/refresh').send({ refreshToken: 'A'.repeat(43) })).status).toBe(401);
      expect((await t.http().post('/v1/auth/refresh').send({})).status).toBe(401);
    });

    it('refuses a cookie-borne refresh from an origin outside the CORS allow-list', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);
      const res = await t.http().post('/v1/auth/refresh').set('Cookie', s.refreshCookie).set('Origin', 'https://evil.example').send({});
      expect(res.status).toBe(403);
      expect((res.body as Json).error.code).toBe('ORIGIN_NOT_ALLOWED');
      const ok = await t.http().post('/v1/auth/refresh').set('Cookie', s.refreshCookie).set('Origin', 'http://localhost:5173').send({});
      expect(ok.status).toBe(200);
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('revokes the session: the refresh token stops working and the cookie is cleared', async () => {
      const user = await createUser(tenant);
      const s = await login(t, user, tenant.slug);
      const res = await t.http().post('/v1/auth/logout').set('Cookie', s.refreshCookie).send({});
      expect(res.status).toBe(204);
      expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/apx_refresh=;/);
      expect((await t.http().post('/v1/auth/refresh').set('Cookie', s.refreshCookie).send({})).status).toBe(401);
    });

    it('with allDevices, ends every session and invalidates outstanding access tokens immediately', async () => {
      const user = await createUser(tenant);
      const phone = await login(t, user, tenant.slug);
      const laptop = await login(t, user, tenant.slug);
      expect((await t.http().get('/v1/auth/me').set(...bearer(laptop))).status).toBe(200);

      await t.http().post('/v1/auth/logout').send({ refreshToken: phone.refreshToken, allDevices: true }).expect(204);

      expect((await t.http().get('/v1/auth/me').set(...bearer(laptop))).status).toBe(401);
      expect((await t.http().post('/v1/auth/refresh').set('Cookie', laptop.refreshCookie).send({})).status).toBe(401);
    });

    it('is idempotent for unknown or missing tokens', async () => {
      expect((await t.http().post('/v1/auth/logout').send({})).status).toBe(204);
      expect((await t.http().post('/v1/auth/logout').send({ refreshToken: 'B'.repeat(43) })).status).toBe(204);
    });
  });

  describe('email verification', () => {
    it('verifies with the emailed token once; the link cannot be reused', async () => {
      const email = `${uniq('verify')}@example.test`;
      const reg = await register({ email });
      const message = t.outbox.find((m) => m.to === email && m.kind === 'email_verification');
      const token = /token=([A-Za-z0-9_-]{43})/.exec(message?.text ?? '')?.[1];
      expect(token).toBeDefined();

      const ok = await t.http().post('/v1/auth/verify-email').send({ token }).then(keep);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ emailVerified: true });

      const me = await t.http().get('/v1/auth/me').set('Authorization', `Bearer ${(reg.body as Json).accessToken}`);
      expect((me.body as Json).emailVerified).toBe(true);

      const reuse = await t.http().post('/v1/auth/verify-email').send({ token });
      expect(reuse.status).toBe(422);
      expect((reuse.body as Json).error.code).toBe('TOKEN_INVALID');
    });

    it('resend issues a fresh link and invalidates the previous one', async () => {
      const email = `${uniq('resend')}@example.test`;
      const reg = await register({ email });
      const firstToken = /token=([A-Za-z0-9_-]{43})/.exec(t.outbox.filter((m) => m.to === email && m.kind === 'email_verification').at(-1)!.text)![1];
      await t.http().post('/v1/auth/resend-verification').set('Authorization', `Bearer ${(reg.body as Json).accessToken}`).expect(202);
      const secondToken = /token=([A-Za-z0-9_-]{43})/.exec(t.outbox.filter((m) => m.to === email && m.kind === 'email_verification').at(-1)!.text)![1];
      expect(secondToken).not.toEqual(firstToken);
      expect((await t.http().post('/v1/auth/verify-email').send({ token: firstToken })).status).toBe(422);
      expect((await t.http().post('/v1/auth/verify-email').send({ token: secondToken })).status).toBe(200);
    });

    it('can require a verified email before login', async () => {
      const strict = await createTestApp({ REQUIRE_VERIFIED_EMAIL: 'true' });
      try {
        const user = await createUser(tenant);
        const res = await strict.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: tenant.slug });
        expect(res.status).toBe(403);
        expect((res.body as Json).error.code).toBe('EMAIL_NOT_VERIFIED');
      } finally {
        await strict.close();
      }
    });
  });

  it('uses DEFAULT_TENANT_SLUG when the request names no organisation', async () => {
    const defaulted = await createTestApp({ DEFAULT_TENANT_SLUG: tenant.slug });
    try {
      const user = await createUser(tenant);
      const res = await defaulted.http().post('/v1/auth/login').send({ email: user.email, password: user.password });
      expect(res.status).toBe(200);
      expect((res.body as Json).user.tenantId).toBe(tenant.id);
    } finally {
      await defaulted.close();
    }
  });

  it('rate-limits authentication endpoints (429 RATE_LIMITED)', async () => {
    const limited = await createTestApp({ AUTH_THROTTLE_LIMIT: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await limited.http().post('/v1/auth/login').send({ email: 'x@example.test', password: 'whatever-123', tenantSlug: tenant.slug });
        statuses.push(res.status);
        if (res.status === 429) expect((res.body as Json).error.code).toBe('RATE_LIMITED');
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      // Other routes use the general limit, not the auth one.
      expect((await limited.http().get('/v1/health/live')).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('never returns a password hash or other credential internals in any response', () => {
    expect(responses.length).toBeGreaterThan(20);
    expect(findSecrets(responses)).toEqual([]);
  });
});
