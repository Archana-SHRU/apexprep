/**
 * Tidies records created by live AI verification in the DEVELOPMENT database.
 *
 *   npm run dev:cleanup-ai              # dry run: lists what would change, changes nothing
 *   npm run dev:cleanup-ai -- --apply   # applies it, in one transaction, with an audit entry
 *
 * Retire and supersede, never erase. Status changes the product already understands do the work:
 *
 *   * AI-generated questions in the dev tenant → `retired` (out of practice; history and attempts intact);
 *   * active visual explanations, revision notes and AI explanations → `superseded` (regenerated on next use);
 *   * open explanation-review tasks raised for those explanations → `cancelled`;
 *   * tutor conversations → deleted (messages cascade). They are the only rows removed.
 *
 * Never touched: `attempts` and `audit_log` (immutable by design — ability is replayed from attempts, so a
 * graded answer is history, not clutter), `block_embeddings` (semantic retrieval needs them), syllabus,
 * seeded content, users. Refuses NODE_ENV=production, and works only on the development seed tenant.
 */
import { Client } from 'pg';
import { loadEnvFile } from '../src/config/load-env-file';

const DEV_TENANT_ID = 'd0000000-0000-4000-8000-000000000001';
const DEV_TENANT_SLUG = 'dev-sandbox';

async function main(): Promise<void> {
  loadEnvFile();
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run: NODE_ENV=production. This script is for the development database only.');
  const apply = process.argv.includes('--apply');
  const db = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'apexprep-dev-cleanup' });
  await db.connect();
  try {
    const tenant = await db.query<{ slug: string; name: string }>(`SELECT slug, name FROM tenants WHERE id = $1`, [DEV_TENANT_ID]);
    if (tenant.rows[0]?.slug !== DEV_TENANT_SLUG || !/DEV ONLY/.test(tenant.rows[0].name)) {
      throw new Error('Refusing to run: the development seed tenant was not found. This is not a development database.');
    }

    await db.query('BEGIN');
    const plan: [string, string][] = [
      ['AI-generated questions to retire', `SELECT count(*)::int AS n FROM questions q JOIN generated_questions g ON g.question_id = q.id WHERE q.tenant_id = $1 AND q.status <> 'retired'`],
      ['visual explanations to supersede', `SELECT count(*)::int AS n FROM visual_explanations WHERE tenant_id = $1 AND status = 'active'`],
      ['revision notes to supersede', `SELECT count(*)::int AS n FROM revision_notes WHERE tenant_id = $1 AND status = 'active'`],
      ['AI explanations to supersede', `SELECT count(*)::int AS n FROM explanations WHERE tenant_id = $1 AND status = 'active' AND source_tier <> 'official_solution'`],
      ['open explanation reviews to cancel', `SELECT count(*)::int AS n FROM review_tasks r JOIN explanations e ON e.id = r.explanation_id WHERE r.tenant_id = $1 AND r.kind = 'explanation_review' AND r.status IN ('open', 'in_progress') AND e.source_tier <> 'official_solution'`],
      ['tutor conversations to delete', `SELECT count(*)::int AS n FROM tutor_conversations WHERE tenant_id = $1`],
      ['attempts (kept: immutable)', `SELECT count(*)::int AS n FROM attempts WHERE tenant_id = $1`],
      ['embeddings (kept: retrieval needs them)', `SELECT count(*)::int AS n FROM block_embeddings WHERE tenant_id = $1`],
    ];
    const counts: Record<string, number> = {};
    for (const [label, sql] of plan) {
      counts[label] = (await db.query<{ n: number }>(sql, [DEV_TENANT_ID])).rows[0]!.n;
      console.log(`${String(counts[label]).padStart(5)}  ${label}`);
    }

    if (!apply) {
      await db.query('ROLLBACK');
      console.log('\nDry run: nothing changed. Re-run with --apply to make these changes.');
      return;
    }

    await db.query(`UPDATE questions q SET status = 'retired' FROM generated_questions g WHERE g.question_id = q.id AND q.tenant_id = $1 AND q.status <> 'retired'`, [DEV_TENANT_ID]);
    await db.query(`UPDATE visual_explanations SET status = 'superseded' WHERE tenant_id = $1 AND status = 'active'`, [DEV_TENANT_ID]);
    await db.query(`UPDATE revision_notes SET status = 'superseded' WHERE tenant_id = $1 AND status = 'active'`, [DEV_TENANT_ID]);
    await db.query(
      `UPDATE review_tasks r SET status = 'cancelled' FROM explanations e
        WHERE e.id = r.explanation_id AND r.tenant_id = $1 AND r.kind = 'explanation_review' AND r.status IN ('open', 'in_progress') AND e.source_tier <> 'official_solution'`,
      [DEV_TENANT_ID],
    );
    await db.query(`UPDATE explanations SET status = 'superseded' WHERE tenant_id = $1 AND status = 'active' AND source_tier <> 'official_solution'`, [DEV_TENANT_ID]);
    await db.query(`DELETE FROM tutor_conversations WHERE tenant_id = $1`, [DEV_TENANT_ID]);
    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, after)
       VALUES ($1, NULL, 'SYSTEM', 'maintenance.live_verification_cleanup', 'tenant', $1, $2::jsonb)`,
      [DEV_TENANT_ID, JSON.stringify(counts)],
    );
    await db.query('COMMIT');
    console.log('\nApplied, and recorded in the audit log.');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
