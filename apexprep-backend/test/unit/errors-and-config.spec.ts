import { NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { mapException } from '../../src/common/filters/all-exceptions.filter';
import { AppException } from '../../src/common/errors/app-exception';
import { decodeCursor, encodeCursor } from '../../src/common/pagination/cursor';
import { DEV_CORS_ORIGINS, validateEnv } from '../../src/config/env.schema';

const pgError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`duplicate key value violates unique constraint "users_tenant_email_uq"`), { code, severity: 'ERROR', ...extra });

describe('error mapping', () => {
  it('passes AppException codes through', () => {
    expect(mapException(AppException.conflict('taken', 'EMAIL_TAKEN'))).toMatchObject({ status: 409, body: { code: 'EMAIL_TAKEN' } });
  });

  it('maps throttling and unknown routes', () => {
    expect(mapException(new ThrottlerException())).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    expect(mapException(new NotFoundException('Cannot GET /v1/x'))).toMatchObject({ status: 404, body: { message: 'Route not found' } });
  });

  it('maps database errors (raw or wrapped by Drizzle) without leaking SQL details', () => {
    const wrapped = new DrizzleQueryError('insert into "users" ...', [], pgError('23505'));
    const mapped = mapException(wrapped);
    expect(mapped).toMatchObject({ status: 409, body: { code: 'CONFLICT' } });
    expect(JSON.stringify(mapped.body)).not.toMatch(/users_tenant_email_uq|insert/);
    expect(mapException(pgError('23503')).status).toBe(422);
    expect(mapException(pgError('23514')).status).toBe(422);
    expect(mapException(pgError('AP001'))).toMatchObject({ status: 409, body: { code: 'IMMUTABLE_RECORD' } });
    expect(mapException(pgError('AP002'))).toMatchObject({ status: 422, body: { code: 'NOT_PUBLISHABLE' } });
    expect(mapException(pgError('AP003'))).toMatchObject({ status: 409, body: { code: 'CONFLICT' } });
    expect(mapException(pgError('AP004'))).toMatchObject({ status: 422, body: { code: 'UNPROCESSABLE' } });
  });

  it('hides unexpected errors behind a generic 500', () => {
    const mapped = mapException(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    expect(mapped).toEqual({ status: 500, body: { code: 'INTERNAL', message: 'An unexpected error occurred' } });
  });

  it('maps body-parser failures', () => {
    expect(mapException(Object.assign(new Error('bad json'), { type: 'entity.parse.failed', status: 400 })).status).toBe(400);
    expect(mapException(Object.assign(new Error('big'), { type: 'entity.too.large', status: 413 })).status).toBe(413);
  });
});

describe('cursor', () => {
  it('round-trips with microsecond precision and rejects forgeries', () => {
    const pos = { ts: '2026-09-22T04:36:01.123456Z', id: '6f1c2c1e-0000-4000-8000-000000000001' };
    expect(decodeCursor(encodeCursor(pos))).toEqual(pos);
    expect(() => decodeCursor('bm90LWEtY3Vyc29y')).toThrow(AppException);
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ t: "2026'; drop", i: pos.id })).toString('base64url'))).toThrow(AppException);
  });
});

describe('environment validation', () => {
  const valid = {
    CORS_ORIGINS: 'http://localhost:5173',
    DATABASE_URL: 'postgres://u:p@localhost:5432/apexprep',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'Zq3v8Jk2Lm9Np4Rs7Tu1Wx6Yz0Ab5Cd8Ef2Gh4Ij6Kl',
  };

  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env).toMatchObject({ PORT: 3000, JWT_ACCESS_TTL_SECONDS: 900, REFRESH_COOKIE_SAMESITE: 'strict', MAIL_PROVIDER: 'console' });
  });

  it('needs no Redis: background work runs on PostgreSQL, and a Redis URL is only checked when one is given', () => {
    const { REDIS_URL: _unset, ...noRedis } = valid;
    const env = validateEnv(noRedis);
    expect(env.REDIS_URL).toBeUndefined();
    expect(env).toMatchObject({ INGESTION_QUEUE_DRIVER: 'postgres', INGESTION_POLL_SECONDS: 10, INGESTION_LEASE_SECONDS: 120, SWEEP_INTERVAL_SECONDS: 60 });
    expect(() => validateEnv({ ...valid, REDIS_URL: 'http://not-redis' })).toThrow(/REDIS_URL/);
  });

  it('bounds the queue settings so a lease cannot be shorter than its renewal', () => {
    expect(() => validateEnv({ ...valid, INGESTION_LEASE_SECONDS: '3' })).toThrow(/INGESTION_LEASE_SECONDS/);
    expect(() => validateEnv({ ...valid, INGESTION_QUEUE_DRIVER: 'redis' })).toThrow(/INGESTION_QUEUE_DRIVER/);
    expect(validateEnv({ ...valid, SWEEP_INTERVAL_SECONDS: '0' }).SWEEP_INTERVAL_SECONDS).toBe(0);
  });

  it('treats empty values as unset', () => {
    expect(validateEnv({ ...valid, DEFAULT_TENANT_SLUG: '' }).DEFAULT_TENANT_SLUG).toBeUndefined();
  });

  it('refuses a short secret without echoing it', () => {
    const secret = 'too-short-secret';
    expect(() => validateEnv({ ...valid, JWT_ACCESS_SECRET: secret })).toThrow(/JWT_ACCESS_SECRET/);
    try {
      validateEnv({ ...valid, JWT_ACCESS_SECRET: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('enforces production safety rules', () => {
    const prod = {
      ...valid,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.apexprep.in',
      // Production must state its database TLS mode; the rule of its own is asserted below.
      DATABASE_URL: `${valid.DATABASE_URL}?sslmode=verify-full`,
    };
    const https = { APP_PUBLIC_URL: 'https://app.apexprep.in' };
    expect(() => validateEnv({ ...prod, ...https, MAIL_PROVIDER: 'none' })).not.toThrow();
    expect(() => validateEnv({ ...prod, ...https })).toThrow(/MAIL_PROVIDER/); // console mail is development-only
    expect(() => validateEnv({ ...prod, ...https, MAIL_TRANSPORT: 'memory' })).toThrow(/MAIL_TRANSPORT/); // the older name is checked too
    expect(() => validateEnv({ ...prod, MAIL_PROVIDER: 'none' })).toThrow(/APP_PUBLIC_URL/); // email links must be https
    expect(() => validateEnv({ ...prod, ...https, MAIL_PROVIDER: 'none', REFRESH_COOKIE_SECURE: 'false' })).toThrow(/REFRESH_COOKIE_SECURE/);
    expect(() => validateEnv({ ...prod, ...https, MAIL_PROVIDER: 'none', CORS_ORIGINS: 'http://app.apexprep.in' })).toThrow(/CORS_ORIGINS/);
  });

  it('CORS: an exact, env-driven allow-list; the four local Vite origins when unset outside production', () => {
    const { CORS_ORIGINS: _unset, ...noCors } = valid;
    expect(validateEnv(noCors).CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174']);
    expect(validateEnv({ ...valid, CORS_ORIGINS: '' }).CORS_ORIGINS).toEqual(DEV_CORS_ORIGINS);
    // An explicit list wins, exactly as written (a trailing slash is dropped: browsers never send one).
    expect(validateEnv({ ...valid, CORS_ORIGINS: 'http://localhost:5174/, http://127.0.0.1:5174' }).CORS_ORIGINS).toEqual(['http://localhost:5174', 'http://127.0.0.1:5174']);
    expect(() => validateEnv({ ...valid, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() => validateEnv({ ...valid, CORS_ORIGINS: 'https://*.apexprep.in' })).toThrow(/CORS_ORIGINS/);

    // Production has no default: it must name its own https origin(s).
    const prod = { ...noCors, NODE_ENV: 'production', APP_PUBLIC_URL: 'https://app.apexprep.in', MAIL_PROVIDER: 'none', DATABASE_URL: `${valid.DATABASE_URL}?sslmode=verify-full` };
    expect(() => validateEnv(prod)).toThrow(/CORS_ORIGINS: required in production/);
    expect(() => validateEnv({ ...prod, CORS_ORIGINS: DEV_CORS_ORIGINS.join(',') })).toThrow(/production origins must be https/);
    expect(validateEnv({ ...prod, CORS_ORIGINS: 'https://app.apexprep.in' }).CORS_ORIGINS).toEqual(['https://app.apexprep.in']);
  });

  it('refuses to start in production with a database URL that says nothing about TLS', () => {
    const prod = { ...valid, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.apexprep.in', APP_PUBLIC_URL: 'https://app.apexprep.in', MAIL_PROVIDER: 'none' };
    // No sslmode means pg connects in cleartext — the password, every argon2id hash and all tenant
    // data. The omission has to be deliberate, so it is refused rather than defaulted either way.
    expect(() => validateEnv(prod)).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...prod, DATABASE_URL: `${valid.DATABASE_URL}?sslmode=verify-full` })).not.toThrow();
    // A private network with TLS terminated elsewhere is a real deployment — but it must be written down.
    expect(() => validateEnv({ ...prod, DATABASE_URL: `${valid.DATABASE_URL}?sslmode=disable` })).not.toThrow();
    // Development is unaffected.
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('requires Secure cookies for SameSite=None', () => {
    expect(() => validateEnv({ ...valid, REFRESH_COOKIE_SAMESITE: 'none', REFRESH_COOKIE_SECURE: 'false' })).toThrow(/SameSite=None/);
  });
});
