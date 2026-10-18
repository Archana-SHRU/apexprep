import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env.schema';
import { DRIZZLE, type Database } from '../database/database.module';
import type { JobHandler, JobQueue, QueuedJob } from './job-queue';

/**
 * The durable queue: PostgreSQL is the broker.
 *
 * A job is a row in `ingestion_jobs`. There is no second copy of it anywhere (no Redis list, no in-memory array) to
 * disagree with the row, so what the queue believes and what the administrator sees cannot drift apart.
 *
 *   * **Claiming.** A worker takes the oldest claimable row with `FOR UPDATE SKIP LOCKED`, so two workers (two API
 *     instances, or a restart overlapping a shutdown) never take the same job, and neither waits for the other. The
 *     claim stamps `locked_by` and a lease, `locked_until`.
 *   * **Lease.** While a job runs, the worker renews the lease on a timer. A worker that dies stops renewing; after
 *     the lease lapses another worker sees a job in a working state with no live lease and takes it over. Every stage
 *     of the pipeline is idempotent (see `IngestionPipeline`), so running it again repeats machine work and loses
 *     nothing a reviewer did.
 *   * **Recovery on restart.** `process()` looks for work immediately, so jobs queued while the service was down, and
 *     jobs the previous process died holding (once their lease lapses), are picked up without anyone retrying them.
 *     A job stranded by the old in-process runner has no lease at all, and is recoverable at once.
 *   * **Retries and exhaustion.** Taking over a dead worker's job counts as an attempt. A job that has been started
 *     `max_attempts` times and still has no result (it keeps killing its worker) is failed for good with
 *     `attempts_exhausted`, instead of being retried forever. An administrator's explicit retry is a decision, not a
 *     recovery, and is always honoured. A handler that throws something it did not record backs the job off
 *     (`next_attempt_at`) rather than spinning on it.
 *   * **One at a time.** A worker runs one job at a time. Ingestion is CPU- and IO-heavy; it must not compete with
 *     serving students.
 *
 * What it does not do: stop a job that is alive but stuck. The lease only detects a *dead* worker, and JavaScript
 * cannot interrupt a running synchronous parse. A genuinely hung job is visible as `progress` that never moves and
 * is left for an operator to retry once the process is restarted.
 *
 * No temporary files exist to clean up: the PDF is read from object storage into memory and nothing is written to
 * local disk by the pipeline.
 */

/** The statuses in which a worker is actively working on a job. */
const WORKING = ['extracting', 'ocr', 'segmenting', 'classifying', 'tagging', 'normalizing', 'matching', 'deduplicating'] as const;
const WORKING_SQL = sql.join(WORKING.map((s) => sql`${s}`), sql`, `);

/** How long a shutdown waits for the job in flight before it hands the job back. */
const SHUTDOWN_WAIT_MS = 30_000;

@Injectable()
export class PostgresJobQueue implements JobQueue, OnModuleDestroy {
  readonly driver = 'postgres';
  private readonly logger = new Logger(PostgresJobQueue.name);
  private readonly workerId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  private readonly leaseSeconds: number;
  private readonly pollMs: number;
  private handler: JobHandler | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private current: string | null = null;
  private stopped = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {
    this.leaseSeconds = config.get('INGESTION_LEASE_SECONDS', { infer: true });
    this.pollMs = config.get('INGESTION_POLL_SECONDS', { infer: true }) * 1000;
  }

  process(handler: JobHandler): void {
    this.handler = handler;
    if (!this.timer) {
      this.timer = setInterval(() => this.kick(), this.pollMs);
      this.timer.unref();
    }
    // Recovery on start: whatever was queued or abandoned while this process was not running.
    this.kick();
  }

  /** The job already exists as a row; this only wakes the worker so it is picked up without waiting for the poll. */
  enqueue(job: QueuedJob): Promise<string> {
    if (!this.handler) return Promise.reject(new Error('no ingestion handler is registered'));
    this.kick();
    return Promise.resolve(`pg:${job.jobId}:${job.attempt}`);
  }

  async drain(): Promise<void> {
    for (;;) {
      this.kick();
      const running = this.running;
      if (!running) return;
      await running;
      if (!this.running) return;
    }
  }

  get pending(): number {
    return this.running ? 1 : 0;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const running = this.running;
    if (running) {
      await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref())]);
    }
    // A job still running after the wait is handed back at once, so another instance does not wait out the lease.
    if (this.current) await this.release(this.current).catch(() => undefined);
  }

  // ---------------------------------------------------------------- the worker loop

  private kick(): void {
    if (this.stopped || !this.handler || this.running) return;
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  private async loop(): Promise<void> {
    try {
      await this.failExhausted();
      while (!this.stopped) {
        const job = await this.claim();
        if (!job) return;
        await this.runOne(job);
      }
    } catch (error) {
      // A database outage must not kill the worker: the next poll tries again.
      this.logger.error(`the ingestion worker could not reach the queue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runOne(job: QueuedJob): Promise<void> {
    const handler = this.handler!;
    this.current = job.jobId;
    const renew = setInterval(() => {
      void this.renew(job.jobId).then((held) => {
        if (!held) this.logger.warn(`ingestion job ${job.jobId}: this worker no longer holds the lease`);
      }).catch(() => undefined);
    }, Math.max(1000, (this.leaseSeconds * 1000) / 3));
    try {
      await handler(job);
    } catch (error) {
      // The pipeline records its own failures on the row. Reaching here means something it did not: back the job off
      // so one bad job cannot spin the worker, and give up on it when it has used its attempts.
      this.logger.error(`ingestion job ${job.jobId} threw: ${error instanceof Error ? error.message : String(error)}`);
      await this.backOff(job).catch(() => undefined);
    } finally {
      clearInterval(renew);
      this.current = null;
      await this.release(job.jobId).catch((error: unknown) => {
        this.logger.warn(`could not release the lease on ingestion job ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  // ---------------------------------------------------------------- the queue, in SQL

  /** Takes the oldest claimable job, atomically. Null when there is nothing to do. */
  async claim(): Promise<QueuedJob | null> {
    const rows = await this.db.execute<{ id: string; tenant_id: string; attempt_count: number }>(sql`
      WITH next AS (
        SELECT id FROM ingestion_jobs
         WHERE (locked_until IS NULL OR locked_until < now())
           AND (
                (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
             OR (status IN (${WORKING_SQL}) AND attempt_count < max_attempts)
           )
         ORDER BY created_at
           FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE ingestion_jobs j
         SET locked_by = ${this.workerId},
             locked_until = now() + make_interval(secs => ${this.leaseSeconds}),
             updated_at = now()
        FROM next
       WHERE j.id = next.id
      RETURNING j.id, j.tenant_id, j.attempt_count`);
    const row = rows.rows[0];
    return row ? { jobId: row.id, tenantId: row.tenant_id, attempt: row.attempt_count + 1 } : null;
  }

  private async renew(jobId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      UPDATE ingestion_jobs SET locked_until = now() + make_interval(secs => ${this.leaseSeconds})
       WHERE id = ${jobId} AND locked_by = ${this.workerId}
      RETURNING id`);
    return rows.rows.length > 0;
  }

  private async release(jobId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE ingestion_jobs SET locked_by = NULL, locked_until = NULL
       WHERE id = ${jobId} AND locked_by = ${this.workerId}`);
  }

  /** A job the handler could not finish and did not account for: wait before it is tried again, or fail it for good. */
  private async backOff(job: QueuedJob): Promise<void> {
    const seconds = Math.min(600, 30 * job.attempt);
    await this.db.execute(sql`
      UPDATE ingestion_jobs
         SET status = 'queued', next_attempt_at = now() + make_interval(secs => ${seconds})
       WHERE id = ${job.jobId} AND status IN ('queued', ${WORKING_SQL}) AND attempt_count < max_attempts`);
    await this.failExhausted();
  }

  /** Jobs that were started as often as they are allowed to be and never produced a result: failed, and said so. */
  private async failExhausted(): Promise<void> {
    const rows = await this.db.execute<{ id: string; tenant_id: string; attempt_count: number }>(sql`
      UPDATE ingestion_jobs
         SET status = 'failed',
             error_code = 'attempts_exhausted',
             error_message = 'the job was started ' || attempt_count || ' times without finishing, which usually means it stops the worker; it was not retried again',
             finished_at = now(), locked_by = NULL, locked_until = NULL
       WHERE status IN ('queued', ${WORKING_SQL}) AND attempt_count >= max_attempts
         AND (locked_until IS NULL OR locked_until < now())
         AND (status <> 'queued' OR next_attempt_at IS NOT NULL)
      RETURNING id, tenant_id, attempt_count`);
    for (const row of rows.rows) {
      this.logger.error(`ingestion job ${row.id} failed for good after ${row.attempt_count} attempts`);
      await this.audit
        .record({ tenantId: row.tenant_id, action: 'ingestion_job.failed', entityType: 'ingestion_job', entityId: row.id, after: { code: 'attempts_exhausted', attempt: row.attempt_count } })
        .catch(() => undefined);
    }
  }
}
