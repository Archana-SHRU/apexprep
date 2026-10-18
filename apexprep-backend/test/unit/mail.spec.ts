import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateEnv, type Env } from '../../src/config/env.schema';
import { smtpTransport } from '../../src/mail/mail.module';
import { MailService, redactTokens, type MailMessage, type SmtpSender } from '../../src/mail/mail.service';
import { escapeHtml, passwordResetEmail, registrationWelcomeEmail } from '../../src/mail/templates';

const base = {
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgres://u:p@localhost:5432/apexprep',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'Zq3v8Jk2Lm9Np4Rs7Tu1Wx6Yz0Ab5Cd8Ef2Gh4Ij6Kl',
};
const SMTP_SECRET = 'smtp-Pa55word-never-logged';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';

function configOf(env: Record<string, string>): ConfigService<Env, true> {
  return new ConfigService(validateEnv({ ...base, ...env }));
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('email templates', () => {
  const welcome = registrationWelcomeEmail({ to: 'asha@example.com', displayName: 'Asha Rao', signInUrl: 'https://app.apexprep.in/login' });
  const reset = passwordResetEmail({ to: 'asha@example.com', displayName: 'Asha Rao', resetUrl: `https://app.apexprep.in/reset-password?token=${TOKEN}`, ttlMinutes: 30 });

  it('registration email: subject, content, html and plain-text parts', () => {
    expect(welcome.subject).toBe('Welcome to ApexPrep — Registration Successful');
    expect(welcome.kind).toBe('registration_welcome');
    for (const body of [welcome.text, welcome.html!]) {
      expect(body).toMatch(/Welcome to ApexPrep/);
      expect(body).toMatch(/registration was successful/i);
      expect(body).toMatch(/account has been created/);
      expect(body).toMatch(/sign in/i);
      expect(body).toContain('https://app.apexprep.in/login');
      expect(body).toContain('Asha');
    }
  });

  it('password reset email: link, expiry and the did-not-request warning, no internal ids', () => {
    expect(reset.subject).toBe('Reset your ApexPrep password');
    for (const body of [reset.text, reset.html!]) {
      expect(body).toContain(`https://app.apexprep.in/reset-password?token=${TOKEN}`);
      expect(body).toMatch(/expires in 30 minutes/);
      expect(body).toMatch(/did not request a password reset/);
      expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/); // no uuids
    }
  });

  it('escapes user-controlled values in HTML', () => {
    const hostile = registrationWelcomeEmail({ to: 'x@example.com', displayName: '<img src=x onerror=alert(1)>', signInUrl: 'https://a.example/login?a=1&b="2"' });
    expect(hostile.html).not.toContain('<img src=x');
    expect(hostile.html).toContain('&lt;img');
    expect(hostile.html).toContain('href="https://a.example/login?a=1&amp;b=&quot;2&quot;"');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('MailService', () => {
  describe('startup: says where email goes', () => {
    const smtpEnv = { MAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', MAIL_FROM_ADDRESS: 'no-reply@apexprep.local', SMTP_USER: 'u', SMTP_PASSWORD: SMTP_SECRET };

    it('console mode warns that nothing is delivered (the reason a reset email never reached Mailpit)', () => {
      const logs = captureLogs();
      try {
        new MailService(configOf({ MAIL_TRANSPORT: 'console' }), [], null).onApplicationBootstrap();
        expect(logs.lines.join('\n')).toMatch(/Mail provider: console — emails are written to this log and NOT delivered/);
      } finally {
        logs.restore();
      }
    });

    it('smtp mode names the server and confirms it is reachable, without credentials', async () => {
      const logs = captureLogs();
      try {
        const smtp: SmtpSender = { sendMail: () => Promise.resolve({}), verify: () => Promise.resolve(true) };
        new MailService(configOf(smtpEnv), [], smtp).onApplicationBootstrap();
        await flush();
        const out = logs.lines.join('\n');
        expect(out).toMatch(/Mail provider: smtp → 127\.0\.0\.1:1025 .*from no-reply@apexprep\.local/);
        expect(out).toMatch(/SMTP server reachable/);
        expect(out).not.toContain(SMTP_SECRET);
      } finally {
        logs.restore();
      }
    });

    it('an unreachable SMTP server is reported at startup with its error code only, and does not stop the app', async () => {
      const logs = captureLogs();
      try {
        const refused = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:1025 user=${SMTP_SECRET}`), { code: 'ESOCKET' });
        const smtp: SmtpSender = { sendMail: () => Promise.resolve({}), verify: () => Promise.reject(refused) };
        expect(() => new MailService(configOf(smtpEnv), [], smtp).onApplicationBootstrap()).not.toThrow();
        await flush();
        const out = logs.lines.join('\n');
        expect(out).toMatch(/SMTP server not reachable \(code=ESOCKET\)/);
        expect(out).not.toContain(SMTP_SECRET);
        expect(out).not.toContain('ECONNREFUSED 127');
      } finally {
        logs.restore();
      }
    });
  });

  it('console provider says what would be sent, with the token redacted', async () => {
    const logs = captureLogs();
    try {
      const mail = new MailService(configOf({ MAIL_PROVIDER: 'console' }), [], null);
      await mail.send(passwordResetEmail({ to: 'a@example.com', displayName: 'A', resetUrl: `http://localhost:5173/reset-password?token=${TOKEN}`, ttlMinutes: 30 }));
      expect(logs.lines.join('\n')).toMatch(/not sent.*kind=password_reset/);
      expect(logs.lines.join('\n')).toContain('token=[redacted]');
      expect(logs.lines.join('\n')).not.toContain(TOKEN);
    } finally {
      logs.restore();
    }
  });

  it('smtp provider hands the message, with both parts, to the transport', async () => {
    const sent: unknown[] = [];
    const smtp: SmtpSender = { sendMail: (m) => (sent.push(m), Promise.resolve({})) };
    const config = configOf({ MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM_ADDRESS: 'no-reply@apexprep.in' });
    const message = registrationWelcomeEmail({ to: 'a@example.com', displayName: 'A', signInUrl: 'http://x/login' });
    await new MailService(config, [], smtp).send(message);
    expect(sent).toEqual([
      { from: { name: 'ApexPrep', address: 'no-reply@apexprep.in' }, to: 'a@example.com', subject: message.subject, text: message.text, html: message.html },
    ]);
  });

  it('dispatch never throws, and a delivery failure logs no credentials, tokens or server reply', async () => {
    const logs = captureLogs();
    try {
      const failure = Object.assign(new Error(`Invalid login: 535 auth failed for user with ${SMTP_SECRET}`), { code: 'EAUTH', responseCode: 535 });
      const smtp: SmtpSender = { sendMail: () => Promise.reject(failure) };
      const config = configOf({ MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM_ADDRESS: 'no-reply@apexprep.in', SMTP_USER: 'u', SMTP_PASSWORD: SMTP_SECRET });
      const mail = new MailService(config, [], smtp);
      expect(() => mail.dispatch(passwordResetEmail({ to: 'a@example.com', resetUrl: `http://x/r?token=${TOKEN}`, ttlMinutes: 30 }))).not.toThrow();
      await flush();
      const out = logs.lines.join('\n');
      expect(out).toMatch(/Email delivery failed: kind=password_reset provider=smtp code=EAUTH smtp=535/);
      expect(out).not.toContain(SMTP_SECRET);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain('Invalid login');
    } finally {
      logs.restore();
    }
  });

  it('memory provider records the message synchronously (tests read it straight after the request)', () => {
    const outbox: MailMessage[] = [];
    new MailService(configOf({ MAIL_PROVIDER: 'memory' }), outbox, null).dispatch(registrationWelcomeEmail({ to: 'a@example.com', signInUrl: 'http://x/login' }));
    expect(outbox).toHaveLength(1);
  });

  it('redactTokens hides token query values only', () => {
    expect(redactTokens(`open http://x/verify-email?token=${TOKEN} now`)).toBe('open http://x/verify-email?token=[redacted] now');
    expect(redactTokens('http://x/a?b=1&token=abc&c=2')).toBe('http://x/a?b=1&token=[redacted]&c=2');
  });
});

describe('mail configuration', () => {
  it('MAIL_PROVIDER wins; MAIL_TRANSPORT is still read; console is the default', () => {
    expect(validateEnv(base).MAIL_PROVIDER).toBe('console');
    expect(validateEnv({ ...base, MAIL_TRANSPORT: 'memory' }).MAIL_PROVIDER).toBe('memory');
    expect(validateEnv({ ...base, MAIL_TRANSPORT: 'memory', MAIL_PROVIDER: 'none' }).MAIL_PROVIDER).toBe('none');
  });

  it('smtp needs a host and a from address, and user/password together', () => {
    expect(() => validateEnv({ ...base, MAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST[\s\S]*MAIL_FROM_ADDRESS/);
    const smtp = { ...base, MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM_ADDRESS: 'no-reply@apexprep.in' };
    expect(() => validateEnv(smtp)).not.toThrow();
    expect(() => validateEnv({ ...smtp, SMTP_USER: 'u' })).toThrow(/SMTP_PASSWORD/);
  });

  it('a configuration error never echoes the SMTP password', () => {
    try {
      validateEnv({ ...base, MAIL_PROVIDER: 'smtp', SMTP_PASSWORD: SMTP_SECRET });
      throw new Error('expected a validation error');
    } catch (e) {
      expect((e as Error).message).toMatch(/SMTP_HOST/);
      expect((e as Error).message).not.toContain(SMTP_SECRET);
    }
  });

  it('production accepts smtp with https links, and requires STARTTLS when not on implicit TLS', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.apexprep.in',
      DATABASE_URL: `${base.DATABASE_URL}?sslmode=verify-full`,
      FRONTEND_URL: 'https://app.apexprep.in/',
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      MAIL_FROM_ADDRESS: 'no-reply@apexprep.in',
      SMTP_USER: 'u',
      SMTP_PASSWORD: SMTP_SECRET,
    };
    const env = validateEnv(prod);
    expect(env.FRONTEND_URL).toBe('https://app.apexprep.in'); // trailing slash trimmed
    expect(() => validateEnv({ ...prod, FRONTEND_URL: 'http://app.apexprep.in' })).toThrow(/FRONTEND_URL/);

    const options = (t: unknown) => (t as { options: Record<string, unknown> }).options;
    const startTls = options(smtpTransport(new ConfigService(env)));
    expect(startTls).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false, requireTLS: true });
    const implicit = options(smtpTransport(new ConfigService(validateEnv({ ...prod, SMTP_SECURE: 'true', SMTP_PORT: '465' }))));
    expect(implicit).toMatchObject({ port: 465, secure: true });
    expect(smtpTransport(configOf({ MAIL_PROVIDER: 'console' }))).toBeNull();
  });

  it('the reset link path and lifetime are configurable and bounded', () => {
    expect(validateEnv(base)).toMatchObject({ PASSWORD_RESET_PATH: '/reset-password', PASSWORD_RESET_TTL_MINUTES: 30, FRONTEND_URL: 'http://localhost:5173' });
    expect(() => validateEnv({ ...base, PASSWORD_RESET_PATH: 'https://evil.example/' })).toThrow(/PASSWORD_RESET_PATH/);
    expect(() => validateEnv({ ...base, PASSWORD_RESET_TTL_MINUTES: '1440' })).toThrow(/PASSWORD_RESET_TTL_MINUTES/);
  });
});
