import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FORGOT_PASSWORD_MESSAGE } from '../../src/auth/auth.controller';
import { MAIL_SMTP, type MailMessage, type SmtpSender } from '../../src/mail/mail.service';
import { bearer, closeDb, createTenant, createTestApp, createUser, db, login, uniq, type TenantFixture, type TestApp } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Registration and password-reset email, end to end: the real controllers, guards, validation, services and
 * database, with the memory mail provider standing in for the SMTP server (and, where a failure is the point,
 * a failing SMTP transport).
 */
describe('Registration email and password reset (e2e)', () => {
  let t: TestApp;
  let tenant: TenantFixture;
  const logged: string[] = [];
  const spies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    // Everything the application logs during this suite is kept, so the end can assert no reset token ever reached a log.
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))));
    }
    t = await createTestApp();
    tenant = await createTenant({ selfRegistration: true });
  });
  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    await t.close();
    await closeDb();
  });

  const register = (app: TestApp, email: string) =>
    app.http().post('/v1/auth/register').send({ displayName: 'Asha <b>Rao</b>', email, password: 'correct-horse-9', tenantSlug: tenant.slug });
  const forgot = (email: string, app: TestApp = t) => app.http().post('/v1/auth/forgot-password').send({ email, tenantSlug: tenant.slug });
  const mailTo = (to: string, kind: MailMessage['kind']) => t.outbox.filter((m) => m.to === to && m.kind === kind);
  const tokenOf = (m: MailMessage) => /[?&]token=([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;

  /** Reset links are issued off the request path, so the test waits for the email rather than assuming it. */
  async function resetMail(to: string, count = 1): Promise<MailMessage[]> {
    for (let i = 0; i < 100; i++) {
      const found = mailTo(to, 'password_reset');
      if (found.length >= count) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`expected ${count} reset email(s) to ${to}`);
  }
  /** Long enough for any background issuance to have finished, for tests asserting that nothing was sent. */
  const settle = () => new Promise((r) => setTimeout(r, 400));
  const resetRows = (userId: string) =>
    db().query<{ token_hash: Buffer; consumed_at: Date | null; expires_at: Date; created_at: Date }>(
      `SELECT token_hash, consumed_at, expires_at, created_at FROM user_tokens WHERE user_id = $1 AND purpose = 'password_reset' ORDER BY created_at`,
      [userId],
    );
  /** Moves the user's reset tokens back in time, past the one-per-minute cooldown (and, with `expire`, past expiry). */
  const backdate = (userId: string, expire = false) =>
    db().query(
      `UPDATE user_tokens SET created_at = created_at - interval '2 hours', expires_at = ${expire ? `now() - interval '1 minute'` : 'expires_at'}
        WHERE user_id = $1 AND purpose = 'password_reset'`,
      [userId],
    );

  describe('registration email', () => {
    it('a successful registration sends the welcome email to the address used, with no secrets in it', async () => {
      const email = `${uniq('welcome')}@example.test`;
      const res = await register(t, email);
      expect(res.status).toBe(201);
      const [welcome, ...more] = mailTo(email, 'registration_welcome');
      expect(more).toHaveLength(0);
      expect(welcome!.subject).toBe('Welcome to ApexPrep — Registration Successful');
      expect(welcome!.text).toMatch(/registration was successful/i);
      expect(welcome!.html).toContain('Asha'); // the display name is used…
      expect(welcome!.html).not.toContain('<b>'); // …and escaped
      const body = res.body as Json;
      for (const secret of ['correct-horse-9', body.accessToken as string, (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!.split('=')[1]!, body.user.id as string]) {
        expect(welcome!.text).not.toContain(secret);
        expect(welcome!.html).not.toContain(secret);
      }
    });

    it('a repeated registration with the same email sends no second welcome email', async () => {
      const email = `${uniq('twice')}@example.test`;
      expect((await register(t, email)).status).toBe(201);
      expect((await register(t, email)).status).toBe(409);
      expect((await register(t, email.toUpperCase())).status).toBe(409);
      expect(mailTo(email, 'registration_welcome')).toHaveLength(1);
    });

    it('registration still succeeds when the mail server fails, and the failure is logged without credentials', async () => {
      let attempts = 0;
      const broken: SmtpSender = {
        sendMail: () => {
          attempts += 1;
          return Promise.reject(Object.assign(new Error('Invalid login: 535 for secret-smtp-pass'), { code: 'EAUTH', responseCode: 535 }));
        },
      };
      const smtpApp = await createTestApp(
        { MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.invalid', MAIL_FROM_ADDRESS: 'no-reply@apexprep.test', SMTP_USER: 'apexprep', SMTP_PASSWORD: 'secret-smtp-pass' },
        [{ token: MAIL_SMTP, value: broken }],
      );
      try {
        const email = `${uniq('mailfail')}@example.test`;
        const res = await register(smtpApp, email);
        expect(res.status).toBe(201);
        expect((res.body as Json).user.email).toBe(email);
        await settle();
        expect(attempts).toBe(2); // the welcome and verification emails were both attempted
        const failures = logged.filter((l) => /Email delivery failed/.test(l));
        expect(failures.some((l) => /kind=registration_welcome .*code=EAUTH smtp=535/.test(l))).toBe(true);
        expect(logged.join('\n')).not.toContain('secret-smtp-pass');
        // The account exists and works.
        expect((await smtpApp.http().post('/v1/auth/login').send({ email, password: 'correct-horse-9', tenantSlug: tenant.slug })).status).toBe(200);
      } finally {
        await smtpApp.close();
      }
    });
  });

  describe('POST /v1/auth/forgot-password', () => {
    it('answers an unknown email, an unknown organisation and a real account identically', async () => {
      const user = await createUser(tenant);
      const responses = [
        await forgot(user.email),
        await forgot(`${uniq('nobody')}@example.test`),
        await t.http().post('/v1/auth/forgot-password').send({ email: user.email, tenantSlug: 'no-such-tenant' }),
      ];
      for (const res of responses) {
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      }
      await resetMail(user.email);
    });

    it('stores only the SHA-256 of a single short-lived token, and emails the link', async () => {
      const user = await createUser(tenant);
      await forgot(user.email).expect(202);
      const [mail] = await resetMail(user.email);
      expect(mail!.subject).toBe('Reset your ApexPrep password');
      expect(mail!.text).toMatch(/^http:\/\/localhost:5173\/reset-password\?token=[A-Za-z0-9_-]{43}$/m);
      expect(mail!.text).not.toContain(user.id);
      const token = tokenOf(mail!);

      const { rows } = await resetRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash.equals(createHash('sha256').update(token).digest())).toBe(true);
      expect(rows[0]!.consumed_at).toBeNull();
      const lifetime = rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime();
      expect(lifetime).toBeGreaterThan(29 * 60_000);
      expect(lifetime).toBeLessThanOrEqual(30 * 60_000 + 1000);
      // The raw token appears nowhere in the database.
      const raw = await db().query(`SELECT count(*)::int AS n FROM user_tokens WHERE encode(token_hash, 'escape') LIKE $1`, [`%${token}%`]);
      expect(raw.rows[0].n).toBe(0);
    });

    it('sends nothing for a disabled account', async () => {
      const user = await createUser(tenant, 'STUDENT', { status: 'disabled' });
      await forgot(user.email).expect(202);
      await settle();
      expect(mailTo(user.email, 'password_reset')).toHaveLength(0);
      expect((await resetRows(user.id)).rows).toHaveLength(0);
    });

    it('sends at most one link per account per minute, whatever the request count', async () => {
      const user = await createUser(tenant);
      for (let i = 0; i < 3; i++) await forgot(user.email).expect(202);
      await resetMail(user.email);
      await settle();
      expect(mailTo(user.email, 'password_reset')).toHaveLength(1);
      expect((await resetRows(user.id)).rows).toHaveLength(1);
    });

    it('a new request invalidates the previous unused link', async () => {
      const user = await createUser(tenant);
      await forgot(user.email).expect(202);
      const first = tokenOf((await resetMail(user.email))[0]!);
      await backdate(user.id); // past the cooldown, not expired
      await forgot(user.email).expect(202);
      const second = tokenOf((await resetMail(user.email, 2))[1]!);
      expect(second).not.toBe(first);
      expect((await resetRows(user.id)).rows).toHaveLength(1);

      const stale = await t.http().post('/v1/auth/reset-password').send({ token: first, password: 'a-brand-new-pass-1' });
      expect(stale.status).toBe(422);
      expect((stale.body as Json).error.code).toBe('TOKEN_INVALID');
      expect((await t.http().post('/v1/auth/reset-password').send({ token: second, password: 'a-brand-new-pass-1' })).status).toBe(200);
    });

    it('is rate-limited per client (429 RATE_LIMITED)', async () => {
      const limited = await createTestApp({ AUTH_THROTTLE_LIMIT: '3' });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
          const res = await forgot(`${uniq('flood')}@example.test`, limited);
          statuses.push(res.status);
          if (res.status === 429) expect((res.body as Json).error.code).toBe('RATE_LIMITED');
        }
        expect(statuses).toEqual([202, 202, 202, 429, 429]);
      } finally {
        await limited.close();
      }
    });

    it('with MAIL_PROVIDER=smtp, an existing account’s request reaches the SMTP transport addressed to that account', async () => {
      // The regression this guards: the request succeeds and a token is stored, but no email is handed to the
      // mail server. Here the provider is the real smtp path; only the network edge (nodemailer) is replaced.
      const sent: { to: string; subject: string; text: string; from: { address: string } }[] = [];
      const smtp: SmtpSender = { sendMail: (m) => (sent.push(m), Promise.resolve({})) };
      const smtpApp = await createTestApp(
        { MAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', MAIL_FROM_ADDRESS: 'no-reply@apexprep.test' },
        [{ token: MAIL_SMTP, value: smtp }],
      );
      try {
        const user = await createUser(tenant);
        const unknown = `${uniq('nobody')}@example.test`;
        const [known, missing] = [await forgot(user.email, smtpApp), await forgot(unknown, smtpApp)];
        expect(known.body).toEqual(missing.body); // still no account enumeration
        for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
        await settle();

        expect(sent).toHaveLength(1);
        expect(sent[0]!.to).toBe(user.email);
        expect(sent[0]!.subject).toBe('Reset your ApexPrep password');
        expect(sent[0]!.from.address).toBe('no-reply@apexprep.test');
        const token = /[?&]token=([A-Za-z0-9_-]{43})/.exec(sent[0]!.text)![1]!;
        const { rows } = await resetRows(user.id);
        expect(rows.at(-1)!.token_hash.equals(createHash('sha256').update(token).digest())).toBe(true);
        expect(sent.some((m) => m.to === unknown)).toBe(false);
        expect(logged.some((l) => l.includes('Email sent: kind=password_reset via smtp'))).toBe(true);
      } finally {
        await smtpApp.close();
      }
    });

    it('validates the email address', async () => {
      const res = await t.http().post('/v1/auth/forgot-password').send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
      expect((res.body as Json).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /v1/auth/reset-password', () => {
    async function linkFor(user: { email: string }): Promise<string> {
      await forgot(user.email).expect(202);
      return tokenOf((await resetMail(user.email)).at(-1)!);
    }

    it('sets the new password, consumes the token, and signs out every existing session', async () => {
      const user = await createUser(tenant);
      const phone = await login(t, user, tenant.slug);
      const laptop = await login(t, user, tenant.slug);
      const token = await linkFor(user);

      const res = await t.http().post('/v1/auth/reset-password').send({ token, password: 'my-new-password-7' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ passwordReset: true });

      // Old password out, new password in, stored as argon2id.
      expect((await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: tenant.slug })).status).toBe(401);
      expect((await t.http().post('/v1/auth/login').send({ email: user.email, password: 'my-new-password-7', tenantSlug: tenant.slug })).status).toBe(200);
      const { rows } = await db().query(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);

      // Sessions from before the reset are gone: refresh tokens revoked, access tokens rejected.
      for (const s of [phone, laptop]) {
        expect((await t.http().post('/v1/auth/refresh').set('Cookie', s.refreshCookie).send({})).status).toBe(401);
        expect((await t.http().get('/v1/auth/me').set(...bearer(s))).status).toBe(401);
      }
      const revoked = await db().query(
        `SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_reason = 'password_change'`,
        [user.id],
      );
      expect(revoked.rows[0].n).toBe(2);
      expect((await resetRows(user.id)).rows[0]!.consumed_at).not.toBeNull();

      const audit = await db().query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'auth.password_reset'`, [user.id]);
      expect(audit.rows[0].n).toBe(1);
    });

    it('rejects a used token', async () => {
      const user = await createUser(tenant);
      const token = await linkFor(user);
      expect((await t.http().post('/v1/auth/reset-password').send({ token, password: 'first-new-pass-1' })).status).toBe(200);
      const again = await t.http().post('/v1/auth/reset-password').send({ token, password: 'second-new-pass-2' });
      expect(again.status).toBe(422);
      expect((again.body as Json).error.code).toBe('TOKEN_INVALID');
      expect((await t.http().post('/v1/auth/login').send({ email: user.email, password: 'first-new-pass-1', tenantSlug: tenant.slug })).status).toBe(200);
    });

    it('rejects an expired token', async () => {
      const user = await createUser(tenant);
      const token = await linkFor(user);
      await backdate(user.id, true);
      const res = await t.http().post('/v1/auth/reset-password').send({ token, password: 'my-new-password-7' });
      expect(res.status).toBe(422);
      expect((res.body as Json).error.code).toBe('TOKEN_INVALID');
      expect((await t.http().post('/v1/auth/login').send({ email: user.email, password: user.password, tenantSlug: tenant.slug })).status).toBe(200);
    });

    it('rejects an unknown or malformed token, without saying whose it might be', async () => {
      const unknown = await t.http().post('/v1/auth/reset-password').send({ token: 'C'.repeat(43), password: 'my-new-password-7' });
      expect(unknown.status).toBe(422);
      expect(unknown.body).toEqual({ error: expect.objectContaining({ code: 'TOKEN_INVALID', message: expect.not.stringMatching(/@|user|account id/i) }) });
      const malformed = await t.http().post('/v1/auth/reset-password').send({ token: 'short', password: 'my-new-password-7' });
      expect(malformed.status).toBe(400);
    });

    it('applies the password policy and leaves the token usable after a rejected password', async () => {
      const user = await createUser(tenant);
      const token = await linkFor(user);
      const short = await t.http().post('/v1/auth/reset-password').send({ token, password: 'short' });
      expect(short.status).toBe(400);
      const asEmail = await t.http().post('/v1/auth/reset-password').send({ token, password: user.email });
      expect(asEmail.status).toBe(400);
      expect(JSON.stringify(asEmail.body)).toMatch(/must not be your email address/);
      expect((await t.http().post('/v1/auth/reset-password').send({ token, password: 'a-good-password-9' })).status).toBe(200);
    });

    it('two concurrent resets with one link: exactly one succeeds', async () => {
      const user = await createUser(tenant);
      const token = await linkFor(user);
      const results = await Promise.all([
        t.http().post('/v1/auth/reset-password').send({ token, password: 'racer-number-one-1' }),
        t.http().post('/v1/auth/reset-password').send({ token, password: 'racer-number-two-2' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    });
  });

  it('never wrote a reset token, a password or the SMTP password to the application log', () => {
    const tokens = t.outbox.filter((m) => m.kind === 'password_reset').map(tokenOf);
    expect(tokens.length).toBeGreaterThan(5);
    const all = logged.join('\n');
    for (const token of tokens) expect(all).not.toContain(token);
    for (const secret of ['correct-horse-9', 'my-new-password-7', 'secret-smtp-pass']) expect(all).not.toContain(secret);
  });
});
