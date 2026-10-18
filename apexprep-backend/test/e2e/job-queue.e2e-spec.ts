import { JOB_QUEUE, type JobQueue } from '../../src/ingestion/job-queue';
import { PostgresJobQueue } from '../../src/ingestion/postgres-job-queue';
import { OBJECT_STORAGE } from '../../src/storage/object-storage';
import { makePdf } from '../fixtures/make-pdf';
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
  uniq,
  type Session,
  type TenantFixture,
  type TestApp,
} from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The durable queue, against the real database: claiming, leases, recovery after a restart, and giving up on a job
 * that keeps killing its worker. Each "restart" is a second real application started on the same database, which is
 * what a restart is.
 */

const page = (): string =>
  [
    'Angular Momentum',
    '',
    'The angular momentum of a rigid body about a fixed axis is the product of its moment of inertia and its angular velocity.',
    `Reference ${uniq('q')}.`,
    '',
    '1. A ring of mass 2 kg and radius 0.5 m rolls without slipping at 1 rad/s. Find its angular momentum about the axis.',
    '(A) 0.25 kg m^2/s',
    '(B) 0.50 kg m^2/s',
    'Answer: B',
  ].join('\n');

interface Ctx {
  tenant: TenantFixture;
  admin: Session;
  first: TestApp;
}

async function setup(): Promise<Ctx> {
  const first = await createTestApp();
  const tenant = await createTenant();
  const [adminUser] = await Promise.all([createUser(tenant, 'ADMIN'), createSyllabus(tenant)]);
  await createEngineConfig(tenant, {});
  return { tenant, admin: await login(first, adminUser, tenant.slug), first };
}

/** Another application on the same database and the same object storage: a restart, or a second instance. */
const restart = (ctx: Ctx): Promise<TestApp> => createTestApp({}, [{ token: OBJECT_STORAGE, value: ctx.first.app.get(OBJECT_STORAGE) }]);

async function upload(ctx: Ctx, app: TestApp): Promise<string> {
  const res = await app
    .http()
    .post('/v1/admin/ingestion/assets')
    .set(...bearer(ctx.admin))
    .set('Content-Type', 'application/pdf')
    .set('X-Filename', 'q.pdf')
    .send(makePdf({ pages: [page()], compress: true }));
  expect(res.status).toBe(201);
  await app.app.get<JobQueue>(JOB_QUEUE).drain();
  return (res.body as Json).jobId as string;
}

const job = async (id: string): Promise<Json> =>
  (await db().query(`SELECT status, attempt_count, locked_by, locked_until, error_code, max_attempts FROM ingestion_jobs WHERE id = $1`, [id])).rows[0];
const blockCount = async (id: string): Promise<number> => Number((await db().query(`SELECT count(*)::int AS n FROM content_blocks WHERE job_id = $1`, [id])).rows[0].n);

describe('the durable job queue', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => {
    await ctx.first.close();
    await closeDb();
  });

  it('is the default, and runs an uploaded document to review leaving no lease behind', async () => {
    expect(ctx.first.app.get<JobQueue>(JOB_QUEUE).driver).toBe('postgres');
    const id = await upload(ctx, ctx.first);
    expect(await job(id)).toMatchObject({ status: 'awaiting_review', attempt_count: 1, locked_by: null, locked_until: null });
  });

  it('can be switched to the in-process runner', async () => {
    const memory = await createTestApp({ INGESTION_QUEUE_DRIVER: 'memory' });
    try {
      expect(memory.app.get<JobQueue>(JOB_QUEUE).driver).toBe('in-process');
    } finally {
      await memory.close();
    }
  });

  it('takes over a job whose worker died, after a restart, without anyone retrying it', async () => {
    const id = await upload(ctx, ctx.first);
    const blocksBefore = await blockCount(id);
    // What a crash mid-stage leaves behind: a working status, and a lease that has since lapsed.
    await db().query(`UPDATE ingestion_jobs SET status = 'segmenting', locked_by = 'dead-worker', locked_until = now() - interval '1 minute' WHERE id = $1`, [id]);

    const restarted = await restart(ctx);
    try {
      await restarted.app.get<JobQueue>(JOB_QUEUE).drain();
      expect(await job(id)).toMatchObject({ status: 'awaiting_review', attempt_count: 2, locked_by: null });
      // The re-run replaced the machine's work; it did not double it.
      expect(await blockCount(id)).toBe(blocksBefore);
    } finally {
      await restarted.close();
    }
  });

  it('takes over a job stranded without any lease, as the old in-process runner left it', async () => {
    const id = await upload(ctx, ctx.first);
    await db().query(`UPDATE ingestion_jobs SET status = 'matching', locked_by = NULL, locked_until = NULL WHERE id = $1`, [id]);
    const restarted = await restart(ctx);
    try {
      await restarted.app.get<JobQueue>(JOB_QUEUE).drain();
      expect((await job(id)).status).toBe('awaiting_review');
    } finally {
      await restarted.close();
    }
  });

  it('leaves a job alone while its worker is alive and renewing the lease', async () => {
    const id = await upload(ctx, ctx.first);
    await db().query(`UPDATE ingestion_jobs SET status = 'segmenting', locked_by = 'live-worker', locked_until = now() + interval '10 minutes' WHERE id = $1`, [id]);
    const other = await restart(ctx);
    try {
      await other.app.get<JobQueue>(JOB_QUEUE).drain();
      expect(await job(id)).toMatchObject({ status: 'segmenting', locked_by: 'live-worker', attempt_count: 1 });
    } finally {
      await other.close();
      await db().query(`UPDATE ingestion_jobs SET status = 'awaiting_review', locked_by = NULL, locked_until = NULL WHERE id = $1`, [id]);
    }
  });

  it('gives up on a job that has been started as often as allowed and never finished', async () => {
    const id = await upload(ctx, ctx.first);
    await db().query(
      `UPDATE ingestion_jobs SET status = 'extracting', attempt_count = max_attempts, locked_by = 'dead-worker', locked_until = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    const restarted = await restart(ctx);
    try {
      await restarted.app.get<JobQueue>(JOB_QUEUE).drain();
      expect(await job(id)).toMatchObject({ status: 'failed', error_code: 'attempts_exhausted', locked_by: null });
      const audit = await db().query(`SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'ingestion_job.failed'`, [id]);
      expect(audit.rows).toHaveLength(1);
      // An administrator's retry is a decision, not a recovery: it is honoured, and gets a fresh run.
      const retry = await restarted.http().post(`/v1/admin/ingestion/jobs/${id}/retry`).set(...bearer(ctx.admin)).send({});
      expect(retry.status).toBe(202);
      await restarted.app.get<JobQueue>(JOB_QUEUE).drain();
      expect((await job(id)).status).toBe('awaiting_review');
    } finally {
      await restarted.close();
    }
  });

  it('never hands one job to two workers, however many ask at once', async () => {
    const ids = [await upload(ctx, ctx.first), await upload(ctx, ctx.first), await upload(ctx, ctx.first)];
    await db().query(`UPDATE ingestion_jobs SET status = 'queued', locked_by = NULL, locked_until = NULL, next_attempt_at = NULL WHERE id = ANY($1::uuid[])`, [ids]);

    const second = await restart(ctx);
    try {
      const a = ctx.first.app.get(PostgresJobQueue);
      const b = second.app.get(PostgresJobQueue);
      const claimed: string[] = [];
      const take = async (q: PostgresJobQueue): Promise<void> => {
        for (;;) {
          const j = await q.claim();
          if (!j) return;
          claimed.push(j.jobId);
        }
      };
      await Promise.all([take(a), take(b), take(a), take(b)]);
      expect(new Set(claimed).size).toBe(claimed.length);
      for (const id of ids) expect(claimed).toContain(id);
    } finally {
      await second.close();
      await db().query(`UPDATE ingestion_jobs SET status = 'awaiting_review', locked_by = NULL, locked_until = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    }
  });
});
