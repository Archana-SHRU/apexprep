/**
 * Adds newly required engine parameters to each organisation's active configuration:
 *   npm run engine:upgrade                 # show what would change, change nothing
 *   npm run engine:upgrade -- --apply      # do it
 *
 * WHY THIS SCRIPT EXISTS
 *
 * The engine has no defaults, on purpose: a missing parameter is refused loudly rather than filled in
 * with a number nobody chose (docs/DECISIONS.md). The consequence is that adding a *required*
 * parameter breaks every database whose active configuration predates it — `GET /practice/...` returns
 * 422 ENGINE_CONFIG_INVALID naming the missing key, and practice stops until a configuration
 * containing it is activated.
 *
 * Phase 8 adds one such parameter, `expected_time`, for the §6.4 rule that an admin's estimate of how
 * long a question takes is replaced by the observed median once `calibration_n` reaches 30. So
 * deploying Phase 8 over an existing database is a two-step operation: migrate, then run this. It is
 * listed as a required deployment step in the Phase 8 report for exactly that reason.
 *
 * WHAT IT DOES, PRECISELY
 *
 * For each tenant whose active configuration is missing one of the parameters below, it inserts the
 * next version carrying that configuration's existing parameters **plus** the missing block, and
 * activates it in the same transaction. Nothing else changes: every value the organisation had chosen
 * is copied across untouched, and a tenant whose configuration already has the key is skipped.
 *
 * An activated `engine_config` version is immutable by trigger (AP001), which is why this adds a
 * version rather than editing one — and that is the right shape anyway: the change is recorded, the
 * previous version is still there, and `attempts.engine_config_id` still points at whichever version
 * each past attempt was graded under, so replay is unaffected.
 *
 * It is a **dry run by default**. A script that rewrites production configuration on being run by
 * accident is not one to have in a repository.
 */
import { Client } from 'pg';
import { parseEngineParams } from '../src/adaptive/engine-params';
import { loadEnvFile } from '../src/config/load-env-file';

/**
 * The parameters this script knows how to add, with the value and where it comes from.
 *
 * Every value here is **stated by the requirements** — none is a default chosen to make the error go
 * away. A parameter the requirements do not specify must not be added by a script: it needs a person
 * to decide it, through the admin API.
 */
const ADDITIONS: { key: string; value: unknown; why: string }[] = [
  {
    key: 'expected_time',
    value: {
      recalibrate_after_attempts: 30,
      exclude_probable_guesses: true,
      min_seconds: 5,
      max_seconds: 7200,
    },
    why:
      '§6.4: expected_time_seconds is admin-set at first and replaced by the observed median once ' +
      'calibration_n reaches 30. The threshold and the statistic are the document’s. min/max mirror the ' +
      'questions_expected_time_range CHECK, so calibration cannot store a value an admin could not type. ' +
      'exclude_probable_guesses is a documented decision, not a requirement (see docs/DECISIONS.md).',
  },
];

interface ActiveConfig {
  tenant_id: string;
  tenant_slug: string;
  id: string;
  version: number;
  params: Record<string, unknown>;
}

async function main(): Promise<void> {
  loadEnvFile();
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = new Client({ connectionString: url, application_name: 'apexprep-engine-upgrade' });
  await client.connect();
  try {
    const { rows } = await client.query<ActiveConfig>(`
      SELECT c.tenant_id, t.slug AS tenant_slug, c.id, c.version, c.params
        FROM engine_config c
        JOIN tenants t ON t.id = c.tenant_id
       WHERE c.is_active
       ORDER BY t.slug
    `);

    if (rows.length === 0) {
      console.log('No active engine configuration in this database; nothing to upgrade.');
      return;
    }

    let changed = 0;
    for (const config of rows) {
      const missing = ADDITIONS.filter((a) => config.params[a.key] === undefined);
      if (missing.length === 0) {
        console.log(`${config.tenant_slug}: v${config.version} already has every required parameter — skipped.`);
        continue;
      }

      const next = { ...config.params };
      for (const addition of missing) next[addition.key] = addition.value;

      // Validated before it is stored. If the merged object still does not satisfy the engine, storing
      // it would replace one broken configuration with another and the failure would move rather than
      // go away — so say what is still missing and change nothing.
      const parsed = parseEngineParams(next);
      if (!parsed.ok) {
        console.error(`${config.tenant_slug}: v${config.version} would still be invalid after this change:`);
        for (const issue of parsed.issues) console.error(`    ${issue.field}: ${issue.message}`);
        console.error('    Nothing was changed for this organisation. Its configuration needs a person.');
        continue;
      }

      const note =
        `Phase 8: added ${missing.map((m) => m.key).join(', ')} to v${config.version}. ` +
        missing.map((m) => m.why).join(' ');

      console.log(`${config.tenant_slug}: v${config.version} → v${config.version + 1}, adding ${missing.map((m) => m.key).join(', ')}`);
      if (!apply) continue;

      await client.query('BEGIN');
      try {
        // Deactivate, then insert active: engine_config_one_active_uq allows one active version per
        // tenant, and both statements are in one transaction so there is never a moment with none.
        await client.query(
          `UPDATE engine_config SET is_active = false, deactivated_at = now() WHERE id = $1 AND is_active`,
          [config.id],
        );
        await client.query(
          `INSERT INTO engine_config (tenant_id, version, params, change_note, created_by, is_active, activated_at)
           VALUES ($1, $2, $3::jsonb, $4, NULL, true, now())`,
          [config.tenant_id, config.version + 1, JSON.stringify(next), note],
        );
        await client.query('COMMIT');
        changed += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('');
    if (apply) {
      console.log(`Done: ${changed} organisation(s) upgraded.`);
    } else {
      console.log('Dry run — nothing was changed. Re-run with --apply to make these changes.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
