/**
 * Runs before every e2e test file: configures the app for tests. Values already in the
 * environment (or .env) win, except DATABASE_URL, which always points at TEST_DATABASE_URL
 * so the e2e suite can never touch a development database.
 */
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from '../../src/config/load-env-file';

loadEnvFile();

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error(
    'E2E tests need TEST_DATABASE_URL (a Postgres database whose name ends in _test). ' +
      'Start Docker (`docker compose up -d`), set it in .env, or run only `npm run test:unit`.',
  );
}

const defaults: Record<string, string> = {
  CORS_ORIGINS: 'http://localhost:5173',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  SWAGGER_ENABLED: 'true',
  LOG_LEVEL: 'error',
  // Uploaded objects stay in the process: the e2e suite never writes to the developer's disk.
  // A test that wants the filesystem adapter passes STORAGE_DRIVER through createTestApp.
  STORAGE_DRIVER: 'memory',
  // Several test apps share one database. A long poll leaves each app's worker to run only the jobs its own requests
  // enqueue; the background sweep would close sessions under tests that check the on-touch behaviour.
  INGESTION_POLL_SECONDS: '3600',
  SWEEP_INTERVAL_SECONDS: '0',
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

// Forced for tests regardless of .env:
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: testUrl,
  MAIL_PROVIDER: 'memory', // verification and reset links are read from the in-process outbox
  REFRESH_COOKIE_SECURE: 'false', // supertest speaks plain HTTP
  THROTTLE_LIMIT: '10000', // the maximum env validation allows
  AUTH_THROTTLE_LIMIT: '1000', // maximum allowed; the rate-limit test builds its own app with a low limit
  DEFAULT_TENANT_SLUG: '',
  REQUIRE_VERIFIED_EMAIL: 'false',
  // No real AI provider, whatever .env says: a developer's .env carries a live key, and without this an
  // app built from the environment calls Google or Anthropic from the test suite — network-dependent,
  // billed, and not what "no provider configured" tests mean. Tests that need AI inject the fake.
  AI_PROVIDER: 'none',
  AI_FALLBACK_PROVIDER: 'none',
});
delete process.env.AI_IMAGE_MODEL;
