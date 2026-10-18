import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, PG_POOL, type Database } from '../database/database.module';
import type { ContentBlockRow } from '../database/schema';
import type {
  ApplyDefaultsDto,
  ApprovalResultDto,
  ApproveDocumentDto,
  BlockOutcomeDto,
  JobPreviewDto,
  PreviewSummaryDto,
  ReviewedBlockDto,
  SuggestionOutcomeDto,
} from './dto/ingestion.dto';
import { IngestionRepository } from './ingestion.repository';
import { isFragment } from './readiness';
import { IngestionService } from './ingestion.service';
import { draftOf } from './learning-drafts';
import { openTasksByBlock, ReviewService } from './review.service';
import { SyllabusSuggestionService } from './syllabus-suggestion.service';

/**
 * The administrator's single act on a prepared document: preview it whole, then approve and publish it.
 *
 * Nothing in this codebase publishes ingested content except a person, and this is the one place a person does it
 * for a whole document. It does not invent a second way to publish: every block goes through the same
 * `ReviewService.publish` as a block published on its own, behind the same gates, and the syllabus levels a
 * document proposes are created by the same `SyllabusSuggestionService.approve` a single suggestion goes through.
 * What this adds is order, bookkeeping and honesty:
 *
 *   * **Order.** Syllabus first (so blocks have somewhere to go), then theory, then questions, then learning
 *     drafts (which summarise the theory just published). Theory is embedded once per sub-topic at the end, not once
 *     per block.
 *   * **The approver is the actor.** Every row this writes is audited under the real administrator, and every
 *     publication is theirs: there is no system account that publishes.
 *   * **Blocked is reported, not forced.** A block a gate refuses is listed with the reason and left as it was; the
 *     rest still publishes. A flagged block (nothing blocks it, but the rules ask a person to look) publishes only
 *     if the administrator says they confirm the flagged ones, and that confirmation is recorded per block.
 *   * **Safe to repeat.** Anything already published is left alone, a suggestion already decided is skipped, and a
 *     publication cannot be done twice (`claimForPublication`). Re-running after a failure finishes the job rather
 *     than duplicating it. Two simultaneous approvals of one document are refused with a conflict.
 */
@Injectable()
export class DocumentApprovalService {
  private readonly logger = new Logger(DocumentApprovalService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repo: IngestionRepository,
    private readonly jobs: IngestionService,
    private readonly review: ReviewService,
    private readonly syllabus: SyllabusSuggestionService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- the preview

  async preview(auth: AuthContext, jobId: string): Promise<JobPreviewDto> {
    const [detail, syllabus, all] = await Promise.all([
      this.jobs.get(auth, jobId),
      this.syllabus.list(auth, jobId),
      this.review.blocksOfJob(auth, jobId),
    ]);
    // A merged-away block is a leftover of a merge: its text lives in the survivor.
    const blocks = all.filter((b) => b.mergedIntoId === null);
    return { job: detail.job, summary: this.summarise(detail.job.status, blocks, syllabus), syllabus, blocks };
  }

  private summarise(jobStatus: string, blocks: ReviewedBlockDto[], syllabus: JobPreviewDto['syllabus']): PreviewSummaryDto {
    const live = blocks.filter((b) => b.readiness !== 'excluded');
    const count = (r: ReviewedBlockDto['readiness']): number => blocks.filter((b) => b.readiness === r).length;
    const pending = syllabus.suggestions.filter((s) => s.status === 'pending');
    const publishable = live.filter((b) => b.kind === 'question' || b.kind === 'theory');
    const questions = live.filter((b) => b.kind === 'question');
    const ready = publishable.filter((b) => b.readiness === 'ready').length;
    const flagged = publishable.filter((b) => b.readiness === 'flagged').length;
    const canApprove = jobStatus === 'awaiting_review';
    return {
      readiness: { ready: count('ready'), flagged: count('flagged'), blocked: count('blocked'), done: count('done'), excluded: count('excluded') },
      questions: questions.length,
      theory: live.filter((b) => b.kind === 'theory' && !b.draft).length,
      solutionsAttached: live.filter((b) => b.kind === 'solution' && b.readiness === 'ready').length,
      drafts: live.filter((b) => b.draft !== null).length,
      suggestionsPending: pending.length,
      suggestionsNeedingNames: pending.filter((s) => s.needsNames).length,
      questionsMissingValues: questions.filter((b) => b.readiness !== 'done' && missingValue(b)).length,
      answersToVerify: questions.filter((b) => b.readiness !== 'done' && (b.question as { answerSource?: string } | null)?.answerSource === 'ai_unverified').length,
      wouldPublish: { ready, withFlagged: ready + flagged },
      canApprove,
      cannotApproveBecause: canApprove ? null : jobStatus === 'published' ? 'this document has already been published' : `the document is ${jobStatus}, not waiting for review`,
    };
  }

  // ---------------------------------------------------------------- bulk values

  /**
   * Fills the difficulty and expected time that no document states, from values the administrator chooses or
   * accepts in one go. See `ReviewService.applyQuestionDefaults` for why this does not count as reviewing them.
   */
  async applyDefaults(auth: AuthContext, jobId: string, dto: ApplyDefaultsDto): Promise<{ updated: number; questions: number }> {
    const job = await this.repo.findJob(auth.tenantId, jobId);
    if (!job) throw AppException.notFound('Ingestion job not found');
    if (job.status !== 'awaiting_review') throw AppException.conflict(`this document is ${job.status}, not waiting for review`, 'INVALID_STATE');
    const byType = dto.expectedTimeSecondsByType ?? {};
    for (const [type, seconds] of Object.entries(byType)) {
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 7200) {
        throw AppException.validation([{ field: `expectedTimeSecondsByType.${type}`, message: 'seconds must be a whole number between 5 and 7200' }]);
      }
    }

    const blocks = (await this.repo.blocksOfJob(auth.tenantId, jobId)).filter((b) => b.kind === 'question' && b.status !== 'published' && b.status !== 'rejected' && b.status !== 'superseded');
    let updated = 0;
    for (const block of blocks) {
      const type = (block.contentJson as { question?: { type?: string } } | null)?.question?.type;
      const changed = await this.review.applyQuestionDefaults(auth, block.id, {
        acceptSuggested: dto.acceptSuggested,
        difficultyLabel: dto.difficultyLabel,
        expectedTimeSeconds: type ? byType[type] : undefined,
      });
      if (changed) updated += 1;
    }
    return { updated, questions: blocks.length };
  }

  // ---------------------------------------------------------------- the approval

  async approve(auth: AuthContext, jobId: string, dto: ApproveDocumentDto): Promise<ApprovalResultDto> {
    const job = await this.repo.findJob(auth.tenantId, jobId);
    if (!job) throw AppException.notFound('Ingestion job not found');
    if (job.status !== 'awaiting_review') {
      throw AppException.conflict(
        job.status === 'published' ? 'this document has already been published' : `this document is ${job.status}, not waiting for review`,
        'INVALID_STATE',
      );
    }
    const dryRun = dto.dryRun === true;

    return this.withJobLock(jobId, async () => {
      const suggestions: SuggestionOutcomeDto[] = [];
      const blockOutcomes: BlockOutcomeDto[] = [];

      // ---- 1. the syllabus the document proposes
      const listing = await this.syllabus.list(auth, jobId);
      const edits = new Map((dto.suggestions ?? []).map((s) => [s.id, s]));
      const rejects = new Set(dto.rejectSuggestionIds ?? []);
      for (const suggestion of listing.suggestions.filter((s) => s.status === 'pending')) {
        if (rejects.has(suggestion.id)) {
          try {
            if (!dryRun) await this.syllabus.reject(auth, jobId, suggestion.id, { reason: 'rejected in the document approval' });
            suggestions.push({ id: suggestion.id, outcome: 'rejected', detail: dryRun ? 'would be rejected' : null });
          } catch (error) {
            suggestions.push(failure(suggestion.id, error));
          }
          continue;
        }
        const names: Partial<Record<'chapterName' | 'topicName' | 'subtopicName', string>> = edits.get(suggestion.id) ?? {};
        const unresolved = (['chapter', 'topic', 'subtopic'] as const).filter(
          (l) => suggestion[l].state === 'unresolved' && !names[`${l}Name` as 'chapterName' | 'topicName' | 'subtopicName'],
        );
        if (unresolved.length > 0) {
          suggestions.push({ id: suggestion.id, outcome: 'skipped', detail: `the PDF does not state the ${unresolved.join(' or ')}; name it, or reject the suggestion` });
          continue;
        }
        if (dryRun) {
          suggestions.push({ id: suggestion.id, outcome: 'approved', detail: 'would be approved' });
          continue;
        }
        try {
          await this.syllabus.approve(auth, jobId, suggestion.id, { chapterName: names.chapterName, topicName: names.topicName, subtopicName: names.subtopicName });
          suggestions.push({ id: suggestion.id, outcome: 'approved', detail: null });
        } catch (error) {
          suggestions.push(failure(suggestion.id, error));
        }
      }

      // ---- 2. the blocks, in the order that makes each one possible
      const params = await this.review.ingestionParams(auth.tenantId);
      let blocks = await this.repo.blocksOfJob(auth.tenantId, jobId);
      if (!dryRun) await this.fileDrafts(auth, blocks);
      blocks = dryRun ? blocks : await this.repo.blocksOfJob(auth.tenantId, jobId);
      const tasks = openTasksByBlock(await this.repo.tasksOfJob(auth.tenantId, jobId));
      const byId = new Map(blocks.map((b) => [b.id, b]));
      const live = blocks.filter((b) => b.mergedIntoId === null);

      const rank = (b: ContentBlockRow): number => (draftOf(b.contentJson) ? 3 : b.kind === 'theory' ? 1 : b.kind === 'question' ? 2 : 4);
      const ordered = [...live].sort((a, b) => rank(a) - rank(b) || (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || a.sortOrder - b.sortOrder);
      const touchedSubtopics: string[] = [];

      for (const block of ordered) {
        const outcome = (o: Omit<BlockOutcomeDto, 'blockId' | 'sourcePage' | 'title'>): void => {
          blockOutcomes.push({ blockId: block.id, sourcePage: block.sourcePage, title: block.title, ...o });
        };
        if (block.kind === 'solution' || block.status === 'published' || block.status === 'rejected' || block.status === 'superseded') continue;
        // Re-read the block: a draft just filed, or a task just closed, changes what it is.
        const fresh = (await this.repo.findBlock(auth.tenantId, block.id)) ?? block;
        const dto2 = await this.review.assess(auth, fresh, params, tasks.get(fresh.id) ?? [], byId);

        if (dto2.readiness === 'excluded' || dto2.readiness === 'done') continue;
        if (dto2.readiness === 'blocked') {
          outcome({ outcome: 'blocked', reasons: dto2.readinessReasons, questionId: null });
          continue;
        }
        if (dto2.readiness === 'flagged' && dto.confirmFlagged !== true) {
          outcome({ outcome: 'skipped', reasons: dto2.readinessReasons, questionId: null });
          continue;
        }
        if (dryRun) {
          outcome({ outcome: dto2.readiness === 'flagged' ? 'confirmed_and_published' : 'published', reasons: ['would be published'], questionId: null });
          continue;
        }

        try {
          if (dto2.readiness === 'flagged') await this.review.confirm(auth, fresh.id, 'confirmed in the document approval');
          const result = await this.review.publish(auth, fresh.id, { index: false });
          if (fresh.kind === 'theory' && !draftOf(fresh.contentJson) && fresh.subtopicId) touchedSubtopics.push(fresh.subtopicId);
          outcome({
            outcome: dto2.readiness === 'flagged' ? 'confirmed_and_published' : 'published',
            reasons: result.note ? [result.note] : [],
            questionId: result.questionId,
          });
        } catch (error) {
          const reasons = error instanceof AppException && error.details?.length ? error.details.map((d) => d.message) : [error instanceof Error ? error.message : 'unknown error'];
          outcome({ outcome: error instanceof AppException && error.code === 'NOT_PUBLISHABLE' ? 'blocked' : 'failed', reasons, questionId: null });
          if (!(error instanceof AppException)) this.logger.error(`approving job ${jobId}: block ${block.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      }

      // ---- 3. re-embed each sub-topic once
      let embeddings: ApprovalResultDto['embeddings'] = null;
      if (!dryRun && touchedSubtopics.length > 0) {
        const results = await this.review.reindexSubtopics(auth, touchedSubtopics);
        embeddings = { attempted: results.length, embedded: results.filter((r) => r.embedded !== null).length };
      }

      // ---- 4. the document's own state
      const totals = {
        published: blockOutcomes.filter((o) => o.outcome === 'published' || o.outcome === 'confirmed_and_published').length,
        confirmed: blockOutcomes.filter((o) => o.outcome === 'confirmed_and_published').length,
        skipped: blockOutcomes.filter((o) => o.outcome === 'skipped').length,
        blocked: blockOutcomes.filter((o) => o.outcome === 'blocked').length,
        failed: blockOutcomes.filter((o) => o.outcome === 'failed').length,
      };
      let complete = false;
      if (!dryRun) {
        complete = await this.settle(auth, jobId, totals, suggestions);
        await this.audit.record({
          tenantId: auth.tenantId,
          action: 'ingestion_job.approved',
          entityType: 'ingestion_job',
          entityId: jobId,
          after: { confirmFlagged: dto.confirmFlagged === true, ...totals, complete, suggestions: suggestions.map((s) => ({ id: s.id, outcome: s.outcome })) },
        });
      }
      return { dryRun, suggestions, blocks: blockOutcomes, totals, complete, embeddings };
    });
  }

  /**
   * Gives each learning draft the sub-topic its source theory now sits under. The pipeline drafts material while the
   * syllabus is still only proposed, so a draft can have been written for a path that did not exist yet.
   */
  private async fileDrafts(auth: AuthContext, blocks: ContentBlockRow[]): Promise<void> {
    const byId = new Map(blocks.map((b) => [b.id, b]));
    for (const block of blocks) {
      const draft = draftOf(block.contentJson);
      if (!draft || block.subtopicId || block.status === 'published' || block.status === 'rejected' || block.status === 'superseded') continue;
      const sourceSubtopic = draft.coveredBlockIds.map((id) => byId.get(id)?.subtopicId ?? null).find((id) => id !== null) ?? null;
      if (sourceSubtopic) await this.repo.updateBlock(auth.tenantId, block.id, { subtopicId: sourceSubtopic, taggingConfidence: 1 });
    }
  }

  /**
   * Marks the document complete when nothing is left to do: every block is published, left out, or a solution
   * attached to something that was. Otherwise it stays waiting for review, with what the last approval did on it.
   */
  private async settle(auth: AuthContext, jobId: string, totals: Record<string, number>, suggestions: SuggestionOutcomeDto[]): Promise<boolean> {
    const blocks = (await this.repo.blocksOfJob(auth.tenantId, jobId)).filter((b) => b.mergedIntoId === null);
    const open = blocks.filter((b) => {
      if (b.status === 'published' || b.status === 'rejected' || b.status === 'superseded') return false;
      return b.kind !== 'solution' && !isFragment(b);
    });
    const pendingSuggestions = (await this.syllabus.list(auth, jobId)).suggestions.filter((s) => s.status === 'pending').length;
    const complete = open.length === 0 && pendingSuggestions === 0 && blocks.some((b) => b.status === 'published');

    const job = await this.repo.findJob(auth.tenantId, jobId);
    const hierarchy = { ...((job?.hierarchy ?? {}) as Record<string, unknown>), approval: { at: new Date().toISOString(), by: auth.userId, ...totals, suggestions: suggestions.length } };
    await this.repo.updateJob(auth.tenantId, jobId, complete ? { status: 'published', progressPct: 100, finishedAt: sql`now()`, hierarchy } : { hierarchy });
    return complete;
  }

  /**
   * Runs `work` while holding a lock on this document, on a connection of its own, so two approvals of the same
   * document cannot interleave. A session-level advisory lock rather than a transaction, because publication is a
   * series of transactions of its own; and it is released by the database if this process dies.
   */
  private async withJobLock<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`ingestion-approval:${jobId}`]);
      if (!rows[0]?.locked) throw AppException.conflict('this document is already being approved by someone else', 'CONFLICT');
      try {
        return await work();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`ingestion-approval:${jobId}`]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }
}

function failure(id: string, error: unknown): SuggestionOutcomeDto {
  const detail = error instanceof AppException && error.details?.length ? error.details.map((d) => d.message).join('; ') : error instanceof Error ? error.message : 'unknown error';
  return { id, outcome: 'failed', detail };
}

/** A question still missing the difficulty or expected time that only a person can supply. */
function missingValue(block: ReviewedBlockDto): boolean {
  const q = block.question as { difficultyLabel?: number | null; sourceDifficulty?: string | null; expectedTimeSeconds?: number | null } | null;
  if (!q) return false;
  return (q.difficultyLabel ?? null) === null || (q.expectedTimeSeconds ?? null) === null;
}
