import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database } from '../database/database.module';
import type { IngestionJobRow, ReviewTaskRow } from '../database/schema';
import type { IngestionJobDto, IngestionJobListDto, JobDetailDto, ListJobsQueryDto, ReviewTaskDto } from './dto/ingestion.dto';
import { IngestionRepository } from './ingestion.repository';
import { JOB_QUEUE, type JobQueue } from './job-queue';

const DEFAULT_LIMIT = 25;

/**
 * Reading and re-running ingestion jobs.
 *
 * The job row is the pipeline's only progress report, which is deliberate: an admin asking what
 * happened to an upload gets the answer from the database rather than from logs they cannot reach.
 * `status` is the stage, `progressPct` is how far through, the block counters say what came out,
 * and `errorCode`/`errorMessage` say why it stopped — the code stable enough for a client to
 * branch on, the message readable enough for a person.
 */
@Injectable()
export class IngestionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly repo: IngestionRepository,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, query: ListJobsQueryDto): Promise<IngestionJobListDto> {
    const jobs = await this.repo.listJobs(auth.tenantId, { status: query.status, limit: query.limit ?? DEFAULT_LIMIT });
    const open = await this.repo.openTaskCountsByJob(
      auth.tenantId,
      jobs.map((job) => job.id),
    );
    return { items: jobs.map((job) => toJobDto(job, open.get(job.id) ?? 0)) };
  }

  async get(auth: AuthContext, jobId: string): Promise<JobDetailDto> {
    const job = await this.requireJob(auth, jobId);
    const tasks = await this.repo.tasksOfJob(auth.tenantId, jobId);
    const open = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').length;
    return { job: toJobDto(job, open), reviewTasks: tasks.map(toTaskDto) };
  }

  /**
   * Runs a job again.
   *
   * Safe because every stage is idempotent: the pages, the machine-written blocks and the
   * machine-opened review tasks of this job are replaced, not added to, and anything a reviewer has
   * touched is left alone (see `IngestionRepository.replaceMachineBlocks`). So a retry after a
   * failure — or after a crash left a job stranded mid-stage — costs the machine's work and nothing
   * of the reviewer's.
   *
   * Two states refuse. A **published** job has already produced questions students may have
   * attempted; re-running it would be a second, silent authoring pass. A job **already waiting in
   * the queue** does not need a second place in it. Everything else, including a stage that never
   * finished, is re-runnable, which is what makes a stranded job recoverable rather than stuck.
   */
  async retry(auth: AuthContext, jobId: string): Promise<JobDetailDto> {
    const job = await this.db.transaction(async (tx) => {
      const current = await this.repo.findJob(auth.tenantId, jobId, tx, true);
      if (!current) throw AppException.notFound('Ingestion job not found');
      if (current.status === 'published') {
        throw AppException.conflict('this job has already been published; its questions exist and re-running it would author them a second time', 'INVALID_STATE');
      }
      if (current.status === 'queued' && current.attemptCount > 0) {
        throw AppException.conflict('this job is already queued to run', 'INVALID_STATE');
      }
      const reset = await this.repo.updateJob(
        auth.tenantId,
        jobId,
        { status: 'queued', progressPct: 0, errorCode: null, errorMessage: null, startedAt: null, finishedAt: null, nextAttemptAt: null, lockedBy: null, lockedUntil: null },
        tx,
      );
      if (!reset) throw AppException.notFound('Ingestion job not found');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'ingestion_job.retried',
          entityType: 'ingestion_job',
          entityId: jobId,
          before: { status: current.status, errorCode: current.errorCode, attemptCount: current.attemptCount },
          after: { status: 'queued' },
        },
        tx,
      );
      return reset;
    });

    // Enqueued after the transaction: a handler that picked the job up before the reset committed
    // would read the old row and repeat the failure it was retried to escape.
    const queueJobId = await this.queue.enqueue({ jobId, tenantId: auth.tenantId, attempt: job.attemptCount + 1 });
    await this.repo.updateJob(auth.tenantId, jobId, { queueJobId, updatedAt: sql`now()` });

    return this.get(auth, jobId);
  }

  private async requireJob(auth: AuthContext, jobId: string): Promise<IngestionJobRow> {
    const job = await this.repo.findJob(auth.tenantId, jobId);
    if (!job) throw AppException.notFound('Ingestion job not found');
    return job;
  }
}

export function toJobDto(job: IngestionJobRow, openReviewTasks: number): IngestionJobDto {
  return {
    id: job.id,
    assetId: job.assetId,
    status: job.status,
    progressPct: job.progressPct,
    attemptCount: job.attemptCount,
    pagesTotal: job.pagesTotal,
    pagesOcr: job.pagesOcr,
    blocks: {
      theory: job.blocksTheory,
      question: job.blocksQuestion,
      solution: job.blocksSolution,
      ambiguous: job.blocksAmbiguous,
    },
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    openReviewTasks,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    hierarchy: job.hierarchy ?? null,
  };
}

export function toTaskDto(task: ReviewTaskRow): ReviewTaskDto {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    priority: task.priority,
    reason: task.reason,
    contentBlockId: task.contentBlockId,
    subtopicId: task.subtopicId,
    suggestion: task.suggestion ?? null,
    createdAt: task.createdAt.toISOString(),
  };
}
