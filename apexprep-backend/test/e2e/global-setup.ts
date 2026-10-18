/**
 * Once per e2e run: reset and migrate TEST_DATABASE_URL. Refuses any database whose
 * name does not end in _test. Skips the pgvector migration only when the server cannot
 * provide the extension (the docker-compose image can), and says so.
 */
import { loadEnvFile } from '../../src/config/load-env-file';
import { runMigrations, unavailableExtensionMigrations } from '../../src/database/migrate';

export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'E2E tests need TEST_DATABASE_URL (a Postgres database whose name ends in _test). ' +
        'Start Docker (`docker compose up -d`), set it in .env, or run only `npm run test:unit`.',
    );
  }
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) throw new Error(`Refusing to reset "${name}": test database names must end in _test`);

  process.env.NODE_ENV = 'test';
  const skip = await unavailableExtensionMigrations(url);
  if (skip.length) console.warn(`\n[e2e] pgvector not installed on this server; skipping ${skip.join(', ')}`);
  await runMigrations(url, { reset: true, skip, log: () => undefined });
}
