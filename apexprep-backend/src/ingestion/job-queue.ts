import { Injectable, Logger } from '@nestjs/common';

/**
 * The queue boundary.
 *
 * The architecture this project was designed against puts ingestion on BullMQ with Redis and a
 * separate worker process. **BullMQ is not installable in this workspace** — the npm registry is
 * blocked (DECISIONS.md §D) — and no Redis is running here either, so the pipeline runs on an
 * in-process runner behind this interface.
 *
 * That is stated plainly rather than papered over, and the shape is chosen so the swap is a module
 * binding and nothing else: `enqueue` hands over a job id and returns, exactly as `Queue.add`
 * does, and the work is driven by a handler registered once at startup, exactly as a `Worker`
 * is. What the in-process runner does **not** give you is durability across a restart or a second
 * instance — a job in flight when the process dies stays in its last recorded stage. The database
 * is what makes that recoverable: `ingestion_jobs` records the stage and the attempt count, and a
 * stalled job is re-runnable through the same idempotent stages, so no work is lost, only delayed.
 */

export interface QueuedJob {
  /** The `ingestion_jobs.id` this refers to. */
  jobId: string;
  tenantId: string;
  /** Which attempt this is, so a handler can decide whether to keep retrying. */
  attempt: number;
}

export type JobHandler = (job: QueuedJob) => Promise<void>;

export interface JobQueue {
  readonly driver: string;
  /** Registers the one handler that processes jobs. Called once, at startup. */
  process(handler: JobHandler): void;
  /** Hands a job over for processing. Returns the queue's own id for it. */
  enqueue(job: QueuedJob): Promise<string>;
  /** Waits for everything currently queued to finish. Tests and shutdown use it. */
  drain(): Promise<void>;
  readonly pending: number;
}

export const JOB_QUEUE = Symbol('JOB_QUEUE');

/**
 * Runs jobs in this process, one at a time, off the request's critical path.
 *
 * Sequential on purpose: ingestion is IO- and CPU-heavy, and running several at once inside the
 * API process would compete with serving students. A real queue would run them on a worker.
 *
 * `enqueue` resolves as soon as the job is accepted — the HTTP request that uploaded a PDF does
 * not wait for it to be processed — and the promise chain that actually runs the work is kept so
 * `drain()` can await it. A handler that throws is logged and does not take the runner down: the
 * stage that failed has already recorded the failure on the job row.
 */
@Injectable()
export class InProcessJobQueue implements JobQueue {
  readonly driver = 'in-process';
  private readonly logger = new Logger(InProcessJobQueue.name);
  private handler: JobHandler | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;

  process(handler: JobHandler): void {
    this.handler = handler;
  }

  enqueue(job: QueuedJob): Promise<string> {
    const handler = this.handler;
    if (!handler) return Promise.reject(new Error('no ingestion handler is registered'));
    this.queued += 1;
    const id = `inproc:${job.jobId}:${job.attempt}`;
    this.chain = this.chain
      .then(() => handler(job))
      .catch((error: unknown) => {
        // The stage has already written the failure to the job row; this is the last resort so one
        // bad job cannot stop the runner from picking up the next.
        this.logger.error(`ingestion job ${job.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.queued -= 1;
      });
    return Promise.resolve(id);
  }

  async drain(): Promise<void> {
    // Each awaited chain may itself have queued more work, so keep going until nothing is left.
    while (this.queued > 0) await this.chain;
    await this.chain;
  }

  get pending(): number {
    return this.queued;
  }
}
