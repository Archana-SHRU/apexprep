import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database } from '../database/database.module';
import type { ContentBlockRow, ReviewTaskRow } from '../database/schema';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { ExplanationsService } from '../explanations/explanations.service';
import { LearningAiRepository } from '../learning-ai/learning-ai.repository';
import { sourceHash } from '../learning-ai/source';
import { QuestionsAdminService } from '../questions/questions-admin.service';
import type {
  BlockPatchDto,
  EmbeddingOutcome,
  MergeBlocksDto,
  PublishBlockResultDto,
  ReclassifyBlockDto,
  ReviewBlockDto,
  ReviewedBlockDto,
  SplitBlockDto,
} from './dto/ingestion.dto';
import { parseIngestionParams, type IngestionParams } from './ingestion-params';
import { IngestionRepository } from './ingestion.repository';
import { draftOf, isNotesShape, renderNotesText, type RevisionNotesDraft } from './learning-drafts';
import { readProvenance, setProvenance, withEdited, isAiTouched } from './provenance';
import { checkBlockGates, checkQuestionGates, referencesDiagram, type GateResult } from './quality-gates';
import { assessReadiness, isFragment, type Assessment } from './readiness';
import { hashText } from './segmentation';
import { reassess, type ExtractedQuestion } from './question-extraction';
import { sourceDifficultyToLabel } from './question-extraction';

/**
 * The reviewer's side of ingestion: what a person does with what the pipeline produced.
 *
 * Six actions, all on `content_blocks` and all audited: **approve**, **edit**, **reject**,
 * **reclassify**, **merge** and **split**. There is no separate review system — `review_tasks`
 * already was one, so a reviewer's decision resolves the tasks that named the block.
 *
 * Rules worth stating, because they are what makes this safe:
 *
 *   * **Publication is gated, never implicit.** `publish` runs the quality gates and refuses with
 *     the list of failures; nothing here can push incomplete content into the student-visible
 *     tables. A question is created through `QuestionsAdminService`, so Phase 3's own validation,
 *     versioning, difficulty-from-configuration and audit trail all apply — there is no second
 *     question model.
 *   * **A question is published last.** It is created as an invisible draft, given its solution, and only then
 *     published, in that order, so a student can never see a question without the solution it is meant to have, and
 *     a failure part-way leaves nothing visible behind. The block is marked published in the same step that records
 *     the question's id; until then the block only carries a publication claim, which expires if its owner dies.
 *   * **Reviewed means a person looked at the content.** Choosing a block's sub-topic is not that: it is recorded as
 *     a mapping-only touch, which keeps a re-run from undoing it but does not clear the gates that ask for review.
 *   * **Rejecting keeps the content.** A rejected block is marked `rejected` and stays, with its
 *     source page and text, because a rejection is a judgement that may be revisited and because
 *     the source document is evidence.
 *   * **Approval is reversible** inside `ingestion.approval_reversal_window_hours`. After that it
 *     is not, and the reviewer is told why rather than silently failing.
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: IngestionRepository,
    private readonly questions: QuestionsAdminService,
    private readonly engineConfig: EngineConfigService,
    private readonly explanations: ExplanationsService,
    private readonly learning: LearningAiRepository,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- reading

  async blocksOfJob(auth: AuthContext, jobId: string): Promise<ReviewedBlockDto[]> {
    const job = await this.repo.findJob(auth.tenantId, jobId);
    if (!job) throw AppException.notFound('Ingestion job not found');
    const [blocks, tasks, params] = await Promise.all([
      this.repo.blocksOfJob(auth.tenantId, jobId),
      this.repo.tasksOfJob(auth.tenantId, jobId),
      this.params(auth.tenantId),
    ]);
    const open = openTasksByBlock(tasks);
    const byId = new Map(blocks.map((b) => [b.id, b]));
    return blocks.map((block) => this.toDto(block, params, open.get(block.id) ?? [], byId));
  }

  /**
   * One block, assessed against the gates exactly as `publish` and the preview assess it. Exposed so the document
   * approval decides readiness with the same code that decides publication.
   */
  async assess(auth: AuthContext, block: ContentBlockRow, params: IngestionParams, tasks: ReviewTaskRow[], blocks?: ReadonlyMap<string, ContentBlockRow>): Promise<ReviewedBlockDto> {
    void auth;
    return this.toDto(block, params, tasks, blocks);
  }

  // ---------------------------------------------------------------- the six actions

  /** Approve: this block is right as it stands. Resolves the tasks that named it. */
  async approve(auth: AuthContext, blockId: string, dto: ReviewBlockDto): Promise<ReviewedBlockDto> {
    return this.decide(auth, blockId, 'approved', dto.note ?? null);
  }

  /**
   * Reject: this block is not usable. It is kept, not deleted — the source document is evidence
   * and a rejection can be revisited.
   */
  async reject(auth: AuthContext, blockId: string, dto: ReviewBlockDto): Promise<ReviewedBlockDto> {
    if (!dto.note) {
      throw AppException.validation([{ field: 'note', message: 'say why: a rejection without a reason is not reviewable' }]);
    }
    return this.decide(auth, blockId, 'rejected', dto.note);
  }

  /**
   * Edit anything a reviewer can correct: the text, title, sub-topic, the question (stem, type, options, answer,
   * difficulty, expected time), the solution beside it, or the notes of a learning draft.
   *
   * Every call is a save — there is no draft state to lose — which is how autosave is supported without a second
   * table: the client PATCHes as the reviewer types and the last write wins.
   *
   * What an edit counts as matters, because the publication gates ask whether a *person looked at the content*:
   *
   *   * Changing text, a question, a solution or notes **is** review, and marks the block reviewed.
   *   * Choosing the sub-topic alone is not. It is recorded (so a re-run of the pipeline cannot undo it) as a
   *     mapping-only touch, which leaves the review gates exactly where they were.
   *
   * Where the reviewer sets an answer, a difficulty or an expected time, the question remembers that it was a
   * person who did; `acceptSuggested` copies the model's or the estimate's proposal into those fields, which is how a
   * reviewer says "yes" to a suggestion without retyping it. Nothing suggested counts until then.
   */
  async edit(auth: AuthContext, blockId: string, dto: BlockPatchDto): Promise<ReviewedBlockDto> {
    const params = await this.params(auth.tenantId);
    const updated = await this.db.transaction(async (tx) => {
      const block = await this.requireBlock(auth, blockId, tx);
      if (block.status === 'published') {
        throw AppException.conflict('this block is published; unpublish it before editing', 'INVALID_STATE');
      }
      if (dto.subtopicId) await this.requireSubtopic(auth, dto.subtopicId);

      const json = { ...((block.contentJson ?? {}) as Record<string, unknown>) };
      // Remember what the machine produced before this edit. A re-run of the job recognises the
      // block by that hash and does not write a second copy of content a person has already fixed.
      json.sourceContentHash ??= block.contentHash;

      const patch: Record<string, unknown> = {};
      let text = block.normalizedText ?? block.rawText;
      if (dto.text !== undefined) text = dto.text;
      if (dto.title !== undefined) patch.title = dto.title;

      // ---- the question
      if (dto.question !== undefined) {
        const current = (json.question ?? null) as ExtractedQuestion | null;
        if (!current) {
          throw AppException.unprocessable('this block has no question to edit', 'UNPROCESSABLE', [{ field: 'question', message: 'only a block read as a question can be edited as one' }]);
        }
        json.question = this.editedQuestion(current, dto.question);
      }

      // ---- the solution beside it
      if (dto.solutionText !== undefined) {
        const existing = (json.solution ?? null) as Record<string, unknown> | null;
        json.solution = {
          ...(existing ?? { blockId: null, questionBlockId: block.id, confidence: 1, reason: 'written or corrected by the reviewer', answerConflict: false }),
          text: dto.solutionText,
          // A person wrote or corrected it: there is nothing left to confirm about the match.
          confirmed: true,
          editedByReviewer: true,
        };
      }

      // ---- a learning draft's notes
      if (dto.draft !== undefined) {
        const draft = draftOf(json);
        if (!draft) throw AppException.unprocessable('this block is not a learning draft', 'UNPROCESSABLE', [{ field: 'draft', message: 'only a drafted revision-notes block has notes to edit' }]);
        if (!isNotesShape(dto.draft.notes)) {
          throw AppException.validation([{ field: 'draft.notes', message: 'notes need a title, an overview and lists of items with their text' }]);
        }
        json.draft = { ...draft, notes: dto.draft.notes, edited: true } satisfies RevisionNotesDraft;
        text = renderNotesText(dto.draft.notes);
        patch.title ??= `Revision notes — ${dto.draft.notes.title}`.slice(0, 300);
      }

      const contentChanged = dto.text !== undefined || dto.title !== undefined || dto.question !== undefined || dto.solutionText !== undefined || dto.draft !== undefined;
      if (dto.text !== undefined || dto.draft !== undefined) {
        patch.normalizedText = text;
        patch.contentHash = hashText(text);
      }
      if (dto.subtopicId !== undefined) {
        patch.subtopicId = dto.subtopicId;
        // A human choosing the sub-topic is certainty, not a guess: the machine's confidence no
        // longer describes this mapping.
        patch.taggingConfidence = 1;
      }

      if (contentChanged) {
        json.provenance = withEdited(readProvenance(json));
        json.reviewScope = 'content';
        json.reviewerEdit = { at: new Date().toISOString(), by: auth.userId, fields: Object.keys(definedOnly(dto)) };
        patch.reviewedBy = auth.userId;
        patch.reviewedAt = sql`now()`;
      } else if (dto.subtopicId !== undefined && block.reviewedBy === null) {
        // Kept from being overwritten by a re-run, but not mistaken for a review of the content.
        json.reviewScope = 'mapping_only';
        patch.reviewedBy = auth.userId;
        patch.reviewedAt = sql`now()`;
      }
      patch.contentJson = json;

      const row = await this.repo.updateBlock(auth.tenantId, blockId, patch, tx);
      if (!row) throw AppException.notFound('Content block not found');

      // A fix settles what the machine flagged about the content; it does not settle a duplicate warning, which
      // is a decision about *another* question and has to be made on purpose.
      if (contentChanged) await this.resolveTasks(auth, blockId, 'edited by the reviewer', tx, 'resolved', (t) => t.kind !== 'duplicate_candidate');
      else if (dto.subtopicId !== undefined) await this.resolveTasks(auth, blockId, 'filed under a sub-topic by the reviewer', tx, 'resolved', isUnmappedTask);

      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'content_block.edited',
          entityType: 'content_block',
          entityId: blockId,
          before: { title: block.title, subtopicId: block.subtopicId, textLength: (block.normalizedText ?? block.rawText).length },
          after: { fields: Object.keys(definedOnly(dto)), subtopicId: row.subtopicId, textLength: text.length, reviewScope: json.reviewScope ?? null },
        },
        tx,
      );
      return row;
    });
    return this.toDto(updated, params, openTasksOf(await this.repo.tasksOfBlock(auth.tenantId, blockId)));
  }

  /** The question after a reviewer's patch, with where each of its answer, difficulty and time came from updated. */
  private editedQuestion(current: ExtractedQuestion, patch: NonNullable<BlockPatchDto['question']>): ExtractedQuestion {
    const { confirmAnswer, acceptSuggested, diagramAcknowledged, ...fields } = patch;
    // Only the keys the reviewer actually sent. A patch DTO is a class instance, so every declared field exists on
    // it — the ones not sent hold `undefined`, and spreading those over the extracted question would erase its
    // stem, its options and its answer while looking like a harmless one-field edit.
    let next: ExtractedQuestion = { ...current, ...(definedOnly(fields) as Partial<ExtractedQuestion>) };

    if (fields.options !== undefined || fields.numericAnswer !== undefined) next.answerSource = 'reviewer';
    if (confirmAnswer === true) {
      const hasAnswer = next.options.some((o) => o.isCorrect) || next.numericAnswer !== null;
      if (!hasAnswer) {
        throw AppException.unprocessable('there is no answer to confirm', 'UNPROCESSABLE', [{ field: 'question.confirmAnswer', message: 'mark the correct option, or give the numeric answer, first' }]);
      }
      next.answerSource = 'reviewer';
    }
    if (fields.difficultyLabel !== undefined) next.difficultySource = 'reviewer';
    if (fields.expectedTimeSeconds !== undefined) next.expectedTimeSource = 'reviewer';
    if (acceptSuggested === true && current.suggested) {
      if (next.difficultyLabel === null && current.suggested.difficultyLabel !== undefined) {
        next = { ...next, difficultyLabel: current.suggested.difficultyLabel, difficultySource: 'reviewer' };
      }
      if (next.expectedTimeSeconds === null && current.suggested.expectedTimeSeconds !== undefined) {
        next = { ...next, expectedTimeSeconds: current.suggested.expectedTimeSeconds, expectedTimeSource: 'reviewer' };
      }
    }
    if (diagramAcknowledged !== undefined) next.diagramAcknowledged = diagramAcknowledged;
    next.editedByReviewer = true;
    return reassess(next);
  }

  /**
   * Reclassify: the machine called it one thing and it is another.
   *
   * This is the way an `ambiguous` block becomes usable, and the database refuses to approve one
   * that is still ambiguous, so the order is enforced rather than merely intended.
   */
  async reclassify(auth: AuthContext, blockId: string, dto: ReclassifyBlockDto): Promise<ReviewedBlockDto> {
    const params = await this.params(auth.tenantId);
    const updated = await this.db.transaction(async (tx) => {
      const block = await this.requireBlock(auth, blockId, tx);
      if (block.kind === dto.kind) {
        throw AppException.conflict(`this block is already classified as ${dto.kind}`, 'INVALID_STATE');
      }
      const json = (block.contentJson ?? {}) as Record<string, unknown>;
      json.reclassified = { from: block.kind, to: dto.kind, by: auth.userId, at: new Date().toISOString(), note: dto.note ?? null };
      json.reviewScope = 'content';

      const row = await this.repo.updateBlock(
        auth.tenantId,
        blockId,
        {
          kind: dto.kind,
          format: dto.format ?? block.format,
          classifiedBy: 'human',
          classificationConfidence: 1,
          reviewedBy: auth.userId,
          reviewedAt: sql`now()`,
          status: 'needs_review',
          contentJson: json,
        },
        tx,
      );
      if (!row) throw AppException.notFound('Content block not found');
      await this.resolveTasks(auth, blockId, `reclassified as ${dto.kind}`, tx);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'content_block.reclassified',
          entityType: 'content_block',
          entityId: blockId,
          before: { kind: block.kind, classifiedBy: block.classifiedBy },
          after: { kind: dto.kind, note: dto.note ?? null },
        },
        tx,
      );
      return row;
    });
    return this.toDto(updated, params, openTasksOf(await this.repo.tasksOfBlock(auth.tenantId, blockId)));
  }

  /**
   * Merge several blocks into the first: a question split across a page break, a heading severed
   * from its paragraph.
   *
   * The sources are kept and pointed at the survivor through `merged_into_id`, so the join is
   * reversible and the source pages stay traceable. Nothing is deleted.
   */
  async merge(auth: AuthContext, dto: MergeBlocksDto): Promise<ReviewedBlockDto> {
    const params = await this.params(auth.tenantId);
    const updated = await this.db.transaction(async (tx) => {
      const blocks = [];
      for (const id of dto.blockIds) blocks.push(await this.requireBlock(auth, id, tx));

      const [first, ...rest] = blocks;
      if (!first || rest.length === 0) {
        throw AppException.validation([{ field: 'blockIds', message: 'a merge needs at least two blocks' }]);
      }
      if (new Set(blocks.map((b) => b.jobId)).size > 1) {
        throw AppException.validation([{ field: 'blockIds', message: 'blocks from different ingestion jobs cannot be merged' }]);
      }
      for (const block of blocks) {
        if (block.status === 'published') throw AppException.conflict('a published block cannot be merged', 'INVALID_STATE');
        if (block.mergedIntoId) throw AppException.conflict(`block ${block.id} has already been merged`, 'INVALID_STATE');
      }

      const ordered = [...blocks].sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || a.sortOrder - b.sortOrder);
      const text = ordered.map((b) => (b.normalizedText ?? b.rawText).trim()).join('\n\n');
      const json = (first.contentJson ?? {}) as Record<string, unknown>;
      json.merged = {
        from: ordered.map((b) => ({ id: b.id, page: b.sourcePage, order: b.sortOrder })),
        by: auth.userId,
        at: new Date().toISOString(),
      };
      json.reviewScope = 'content';

      const survivor = await this.repo.updateBlock(
        auth.tenantId,
        first.id,
        { normalizedText: text, contentHash: hashText(text), reviewedBy: auth.userId, reviewedAt: sql`now()`, status: 'needs_review', contentJson: json },
        tx,
      );
      if (!survivor) throw AppException.notFound('Content block not found');

      for (const block of rest) {
        await this.repo.updateBlock(
          auth.tenantId,
          block.id,
          { mergedIntoId: first.id, status: 'superseded', reviewedBy: auth.userId, reviewedAt: sql`now()` },
          tx,
        );
        await this.resolveTasks(auth, block.id, `merged into block ${first.id}`, tx);
      }

      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'content_block.merged',
          entityType: 'content_block',
          entityId: first.id,
          after: { merged: rest.map((b) => b.id), textLength: text.length },
        },
        tx,
      );
      return survivor;
    });
    return this.toDto(updated, params, openTasksOf(await this.repo.tasksOfBlock(auth.tenantId, updated.id)));
  }

  /**
   * Split one block into several: two questions the segmenter ran together, theory with a
   * worked example inside it.
   *
   * The original is kept as `superseded` and every piece records `split_from_id`, so a reviewer
   * can see where a block came from. The pieces inherit the source page, which is what keeps
   * provenance intact.
   */
  async split(auth: AuthContext, blockId: string, dto: SplitBlockDto): Promise<ReviewedBlockDto[]> {
    const params = await this.params(auth.tenantId);
    const created = await this.db.transaction(async (tx) => {
      const block = await this.requireBlock(auth, blockId, tx);
      if (block.status === 'published') throw AppException.conflict('a published block cannot be split', 'INVALID_STATE');
      if (block.mergedIntoId) throw AppException.conflict('a merged block cannot be split', 'INVALID_STATE');

      const pieces = [];
      for (const [index, piece] of dto.pieces.entries()) {
        const json = {
          ...((block.contentJson ?? {}) as Record<string, unknown>),
          split: { from: block.id, index, by: auth.userId, at: new Date().toISOString() },
          // The pieces are new content: the machine's question proposal described the whole and
          // does not describe any of them.
          question: null,
          reviewScope: 'content',
        };
        pieces.push(
          await this.repo.insertBlock(
            {
              tenantId: auth.tenantId,
              jobId: block.jobId,
              assetId: block.assetId,
              pageId: block.pageId,
              sourcePage: block.sourcePage,
              kind: piece.kind ?? block.kind,
              format: piece.format ?? block.format,
              title: piece.title ?? null,
              rawText: piece.text,
              normalizedText: piece.text,
              contentHash: hashText(piece.text),
              classificationConfidence: 1,
              classifiedBy: 'human',
              subtopicId: piece.subtopicId ?? block.subtopicId,
              taggingConfidence: piece.subtopicId ? 1 : block.taggingConfidence,
              sortOrder: block.sortOrder * 100 + index,
              splitFromId: block.id,
              status: 'needs_review',
              reviewedBy: auth.userId,
              reviewedAt: sql`now()`,
              contentJson: json,
            },
            tx,
          ),
        );
      }

      await this.repo.updateBlock(auth.tenantId, blockId, { status: 'superseded', reviewedBy: auth.userId, reviewedAt: sql`now()` }, tx);
      await this.resolveTasks(auth, blockId, `split into ${pieces.length} blocks`, tx);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'content_block.split',
          entityType: 'content_block',
          entityId: blockId,
          after: { pieces: pieces.map((p) => p.id) },
        },
        tx,
      );
      return pieces;
    });
    return created.map((block) => this.toDto(block, params, []));
  }

  /**
   * Confirm: "I have looked at this, and it is right to publish."
   *
   * This is what a flagged block needs and what the document approval does for the flagged blocks when the
   * administrator asks it to confirm them together. It is the same act as a reviewer pressing Approve on each — the
   * block is marked reviewed (its *content*, not merely its sub-topic), the tasks a person's look settles are
   * resolved, and the act is audited with who did it — but it does **not** reach past what a look can settle: a
   * missing answer, difficulty or expected time, a duplicate warning, an unmapped block or an unverified model
   * answer stay as they are, and `publish` still refuses them.
   */
  async confirm(auth: AuthContext, blockId: string, note: string): Promise<ReviewedBlockDto> {
    const params = await this.params(auth.tenantId);
    const updated = await this.db.transaction(async (tx) => {
      const block = await this.requireBlock(auth, blockId, tx);
      if (block.status === 'published') throw AppException.conflict('this block is published; unpublish it first', 'INVALID_STATE');
      if (block.kind === 'ambiguous') {
        throw AppException.unprocessable('an ambiguous block must be reclassified before it can be confirmed', 'NOT_PUBLISHABLE', [
          { field: 'kind', message: 'reclassify it as theory, question or solution first' },
        ]);
      }
      const row = await this.repo.updateBlock(
        auth.tenantId,
        blockId,
        {
          status: 'approved',
          reviewedBy: auth.userId,
          reviewedAt: sql`now()`,
          contentJson: { ...((block.contentJson ?? {}) as Record<string, unknown>), reviewScope: 'content', confirmation: { by: auth.userId, at: new Date().toISOString(), note } },
        },
        tx,
      );
      if (!row) throw AppException.notFound('Content block not found');
      await this.resolveTasks(auth, blockId, note, tx, 'approved', clearedByConfirmation);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'content_block.confirmed',
          entityType: 'content_block',
          entityId: blockId,
          before: { status: block.status, reviewedBy: block.reviewedBy },
          after: { status: 'approved', note },
        },
        tx,
      );
      return row;
    });
    return this.toDto(updated, params, openTasksOf(await this.repo.tasksOfBlock(auth.tenantId, blockId)));
  }

  /**
   * Fills a question's missing difficulty and expected time with values the administrator chose or accepted.
   *
   * Used by the preview's bulk controls ("set 120 s for every single-correct question that has none", "accept the
   * suggestions"). Each value is recorded as set by a person, because one did choose it; but the block is **not**
   * marked reviewed, because choosing a number is not reading the question, and the review gates must keep asking.
   * Fields already set are never overwritten. Returns whether anything changed.
   */
  async applyQuestionDefaults(
    auth: AuthContext,
    blockId: string,
    defaults: { difficultyLabel?: number; expectedTimeSeconds?: number; acceptSuggested?: boolean },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const block = await this.requireBlock(auth, blockId, tx);
      if (block.status === 'published' || block.kind !== 'question') return false;
      const json = { ...((block.contentJson ?? {}) as Record<string, unknown>) };
      const current = (json.question ?? null) as ExtractedQuestion | null;
      if (!current) return false;

      let next = current;
      const difficulty = next.difficultyLabel ?? sourceDifficultyToLabel(next.sourceDifficulty);
      if (difficulty === null) {
        const value = defaults.difficultyLabel ?? (defaults.acceptSuggested ? current.suggested?.difficultyLabel : undefined);
        if (value !== undefined) next = { ...next, difficultyLabel: value, difficultySource: 'reviewer' };
      }
      if (next.expectedTimeSeconds === null) {
        const value = defaults.expectedTimeSeconds ?? (defaults.acceptSuggested ? current.suggested?.expectedTimeSeconds : undefined);
        if (value !== undefined) next = { ...next, expectedTimeSeconds: value, expectedTimeSource: 'reviewer' };
      }
      if (next === current) return false;

      json.question = reassess(next);
      json.bulkDefaults = { by: auth.userId, at: new Date().toISOString() };
      await this.repo.updateBlock(auth.tenantId, blockId, { contentJson: json }, tx);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'content_block.defaults_applied',
          entityType: 'content_block',
          entityId: blockId,
          after: { difficultyLabel: next.difficultyLabel, expectedTimeSeconds: next.expectedTimeSeconds },
        },
        tx,
      );
      return true;
    });
  }

  // ---------------------------------------------------------------- publication

  /**
   * Publishes one block, and refuses with the failing gates when it cannot.
   *
   * A **theory** block becomes published theory. A **question** block becomes a real question through
   * `QuestionsAdminService.create` and `publish`, which is what applies Phase 3's validation, its `difficulty_b` from
   * the active engine configuration, its versioning and its audit trail. A matched solution becomes the official
   * solution through the same service. A **learning draft** becomes the sub-topic's revision notes, never theory.
   *
   * `options.index = false` skips re-embedding the sub-topic's theory, for a caller publishing many blocks that will
   * re-embed once at the end (`reindexSubtopics`).
   */
  async publish(auth: AuthContext, blockId: string, options: { index?: boolean } = {}): Promise<PublishBlockResultDto> {
    const params = await this.params(auth.tenantId);
    const block = await this.requireBlock(auth, blockId, this.db);
    // Answered before any gate work, because a second click on Publish is the common case and it
    // should cost nothing. The atomic claim further down is what handles two *simultaneous* calls.
    if (block.status === 'published') {
      throw AppException.conflict('this block has already been published', 'INVALID_STATE');
    }
    const tasks = openTasksOf(await this.repo.tasksOfBlock(auth.tenantId, blockId));
    const json = (block.contentJson ?? {}) as Record<string, unknown>;

    if (draftOf(json)) return this.publishDraft(auth, block, params, tasks);
    if (block.kind === 'question') return this.publishQuestion(auth, block, params, tasks);
    return this.publishTheory(auth, block, params, tasks, options.index !== false);
  }

  private async publishQuestion(auth: AuthContext, block: ContentBlockRow, params: IngestionParams, tasks: ReviewTaskRow[]): Promise<PublishBlockResultDto> {
    const json = (block.contentJson ?? {}) as { question?: ExtractedQuestion | null; solution?: MatchedSolution | null };
    const proposal = json.question ?? null;
    if (!proposal) {
      throw AppException.unprocessable('this question block has no extracted question to publish', 'NOT_PUBLISHABLE', [
        { field: 'question', message: 'nothing was read from the block; edit it first' },
      ]);
    }
    const gates = this.gatesFor(block, params, tasks, contentReviewed(block));
    if (!gates.ok) throw this.blocked(gates.failures);

    const claimed = await this.repo.claimForPublication(auth.tenantId, block.id, auth.userId);
    if (!claimed) throw AppException.conflict('this block has already been published, or is being published right now', 'INVALID_STATE');

    // A claim that outlived a crashed publication may name a question that attempt got as far as creating.
    const resumed = await this.adoptInterrupted(auth, claimed);
    if (resumed) return resumed;

    const difficultyLabel = proposal.difficultyLabel ?? sourceDifficultyToLabel(proposal.sourceDifficulty);
    let questionId: string | undefined;
    try {
      const question = await this.questions.create(auth, {
        subtopicId: block.subtopicId!,
        type: proposal.type,
        stem: proposal.stem,
        difficultyLabel: difficultyLabel!,
        // Non-null by the time we get here: the `expected_time` gate above refuses without it.
        expectedTimeSeconds: proposal.expectedTimeSeconds as number,
        ...(proposal.options.length > 0 ? { options: proposal.options.map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })) } : {}),
        ...(proposal.numericAnswer ? { numericAnswer: proposal.numericAnswer } : {}),
      });
      questionId = question.id;
      // Recorded before anything else is done to it, so a crash from here on can be finished or cleaned up.
      await this.repo.notePublicationProgress(auth.tenantId, block.id, { questionId });
      // The solution first and the publication last: until the very end this is a draft no student can reach.
      if (json.solution?.text) await this.questions.setOfficialSolution(auth, question.id, { body: json.solution.text });
      const published = await this.questions.publish(auth, question.id);
      await this.repo.finishPublication(auth.tenantId, block.id, { publishedQuestionId: published.id });
      await this.audit.record({
        tenantId: auth.tenantId,
        action: 'content_block.published',
        entityType: 'content_block',
        entityId: block.id,
        after: { questionId: published.id, difficultyLabel, hasOfficialSolution: Boolean(json.solution?.text), answerSource: proposal.answerSource ?? null },
      });
      return { blockId: block.id, kind: 'question', published: true, questionId: published.id, gateFailures: [], embeddings: null };
    } catch (error) {
      await this.abandon(auth, block.id, questionId);
      throw error;
    }
  }

  private async publishTheory(
    auth: AuthContext,
    block: ContentBlockRow,
    params: IngestionParams,
    tasks: ReviewTaskRow[],
    index: boolean,
  ): Promise<PublishBlockResultDto> {
    const gates = this.gatesFor(block, params, tasks, contentReviewed(block));
    if (!gates.ok) throw this.blocked(gates.failures);

    // Two concurrent publications cannot both win the claim, so the second is a refusal rather than a no-op that
    // reports success.
    const claimed = await this.repo.claimForPublication(auth.tenantId, block.id, auth.userId);
    if (!claimed) throw AppException.conflict('this block has already been published, or is being published right now', 'INVALID_STATE');
    try {
      await this.repo.finishPublication(auth.tenantId, block.id, {});
    } catch (error) {
      await this.abandon(auth, block.id, undefined);
      throw error;
    }
    // Published theory is what semantic retrieval searches, so it is embedded through the Phase 6
    // abstraction rather than a second one. Embedding needs pgvector and a provider that can embed;
    // when either is missing the block is still published and still found by keyword, so the
    // outcome is reported instead of failing the publication.
    const indexed = index ? await this.indexTheory(auth, block.subtopicId) : { attempted: false, embedded: null, note: 'embedding is done once for the whole document' };
    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'content_block.published',
      entityType: 'content_block',
      entityId: block.id,
      after: { kind: block.kind, subtopicId: block.subtopicId, embeddings: indexed },
    });
    return { blockId: block.id, kind: block.kind, published: true, questionId: null, gateFailures: [], embeddings: indexed };
  }

  /**
   * An approved learning draft becomes the sub-topic's revision notes — the table the learner-facing feature reads —
   * and never a theory block, so notes a model wrote can never become the source the tutor and the explanations are
   * grounded in.
   *
   * It is activated only when it is true to say these notes summarise the sub-topic: every theory block the
   * sub-topic has published must be one the notes were written from, and every block the notes cite must be
   * published. Otherwise the draft is approved but not activated (and says why), and the learner-facing feature
   * writes notes from everything on demand, as it always did. The cache key is the same one that feature uses, so a
   * learner who opens the notes gets this text instead of triggering a model call.
   */
  private async publishDraft(auth: AuthContext, block: ContentBlockRow, params: IngestionParams, tasks: ReviewTaskRow[]): Promise<PublishBlockResultDto> {
    const draft = draftOf(block.contentJson)!;
    const gates = this.gatesFor(block, params, tasks, contentReviewed(block));
    if (!gates.ok) throw this.blocked(gates.failures);

    const claimed = await this.repo.claimForPublication(auth.tenantId, block.id, auth.userId);
    if (!claimed) throw AppException.conflict('this draft has already been approved, or is being approved right now', 'INVALID_STATE');
    try {
      const published = await this.learning.theoryInScope(auth.tenantId, 'subtopic', block.subtopicId!, 1501);
      const publishedIds = new Set(published.map((b) => b.blockId));
      const covered = new Set(draft.coveredBlockIds);
      let activation: Record<string, unknown>;
      let note: string | null = null;

      if (published.length === 0 || !published.every((b) => covered.has(b.blockId))) {
        note = 'not activated: this sub-topic has published theory the notes were not written from, so learners get notes written from all of it on demand';
        activation = { skipped: note, at: new Date().toISOString(), by: auth.userId };
      } else if (!draft.sourceBlockIds.every((id) => publishedIds.has(id))) {
        note = 'not activated: the notes cite material that was not published';
        activation = { skipped: note, at: new Date().toISOString(), by: auth.userId };
      } else {
        const hash = sourceHash(published);
        const active = await this.learning.activeNotes(auth.tenantId, 'subtopic', block.subtopicId!);
        if (active) await this.learning.supersedeNotes(auth.tenantId, active.id);
        const row = await this.learning.insertNotes({
          tenantId: auth.tenantId,
          scopeLevel: 'subtopic',
          scopeId: block.subtopicId!,
          sourceHash: hash,
          sourceBlockIds: draft.sourceBlockIds,
          promptVersion: draft.promptVersion,
          provider: draft.provider,
          model: draft.model,
          status: 'active',
          content: draft.notes as unknown as Record<string, unknown>,
          groundingScore: draft.groundingScore,
          diagnostics: { origin: 'ingestion_draft', jobId: block.jobId, blockId: block.id, editedByReviewer: draft.edited === true },
          generatedBy: auth.userId,
        });
        activation = { notesId: row.id, at: new Date().toISOString(), by: auth.userId };
      }

      // Consumed, not published as theory: `superseded` keeps it out of every student-facing theory query, and the
      // activation record is what the preview reads to show it as done.
      await this.repo.releaseClaim(auth.tenantId, block.id);
      await this.repo.updateBlock(auth.tenantId, block.id, {
        status: 'superseded',
        contentJson: { ...((block.contentJson ?? {}) as Record<string, unknown>), draft: { ...draft, activation } },
      });
      await this.audit.record({
        tenantId: auth.tenantId,
        action: 'content_block.published',
        entityType: 'content_block',
        entityId: block.id,
        after: { kind: 'revision_notes_draft', subtopicId: block.subtopicId, activated: note === null, note },
      });
      return { blockId: block.id, kind: block.kind, published: note === null, questionId: null, gateFailures: [], embeddings: null, ...(note ? { note } : {}) };
    } catch (error) {
      await this.abandon(auth, block.id, undefined);
      throw error;
    }
  }

  /**
   * Finishes or cleans up after a publication that died between creating its question and finishing the block.
   * Returns the finished result when it could complete the publication, or null when the caller should start over.
   */
  private async adoptInterrupted(auth: AuthContext, claimed: ContentBlockRow): Promise<PublishBlockResultDto | null> {
    const leftover = ((claimed.contentJson ?? {}) as { publishing?: { questionId?: string } }).publishing?.questionId;
    if (!leftover) return null;
    try {
      const question = await this.questions.get(auth, leftover);
      if (question.status === 'published') {
        await this.repo.finishPublication(auth.tenantId, claimed.id, { publishedQuestionId: question.id });
        return { blockId: claimed.id, kind: 'question', published: true, questionId: question.id, gateFailures: [], embeddings: null };
      }
      // A draft nobody could see. Removed rather than reused, because the block may have been edited since.
      await this.questions.remove(auth, leftover);
    } catch (error) {
      if (!(error instanceof AppException && error.code === 'NOT_FOUND')) throw error;
    }
    return null;
  }

  /** Undoes a failed publication: the draft question (never visible) is removed and the claim is dropped. */
  private async abandon(auth: AuthContext, blockId: string, questionId: string | undefined): Promise<void> {
    if (questionId) {
      try {
        await this.questions.remove(auth, questionId);
      } catch (error) {
        // Leave a note on the block: the next attempt removes the leftover before it starts.
        this.logger.warn(`could not remove the draft question ${questionId} left by a failed publication of block ${blockId}: ${error instanceof Error ? error.message : 'unknown'}`);
        await this.repo.notePublicationProgress(auth.tenantId, blockId, { questionId }).catch(() => undefined);
        return;
      }
    }
    await this.repo.releaseClaim(auth.tenantId, blockId).catch((error: unknown) => {
      this.logger.warn(`could not release the publication claim on block ${blockId}: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }

  /**
   * Embeds the sub-topic's published theory, and says what happened.
   *
   * Never throws: a failure here means semantic retrieval has not caught up, not that the content
   * should not have been published. The note is returned to the reviewer and written to the audit
   * row, so "this server cannot store vectors" is visible rather than assumed.
   */
  private async indexTheory(auth: AuthContext, subtopicId: string | null): Promise<EmbeddingOutcome> {
    if (!subtopicId) return { attempted: false, embedded: null, note: 'the block has no sub-topic to index' };
    try {
      const result = await this.explanations.reindexSubtopic(auth, subtopicId);
      return { attempted: true, embedded: result.embedded, note: null };
    } catch (error) {
      const note = error instanceof AppException ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`publishing block left theory unembedded for sub-topic ${subtopicId}: ${note}`);
      return { attempted: true, embedded: null, note };
    }
  }

  /** Re-embeds each sub-topic once, after a document's theory has been published. */
  async reindexSubtopics(auth: AuthContext, subtopicIds: readonly string[]): Promise<EmbeddingOutcome[]> {
    const outcomes: EmbeddingOutcome[] = [];
    for (const id of new Set(subtopicIds)) outcomes.push(await this.indexTheory(auth, id));
    return outcomes;
  }

  /**
   * Takes published content back out of circulation.
   *
   * For theory that is the block's status. A published question is retired through
   * `QuestionsAdminService`, which keeps it for the attempt history rather than deleting it.
   */
  async unpublish(auth: AuthContext, blockId: string, note?: string): Promise<PublishBlockResultDto> {
    const block = await this.requireBlock(auth, blockId, this.db);
    if (block.status !== 'published') throw AppException.conflict('this block is not published', 'INVALID_STATE');

    const json = (block.contentJson ?? {}) as { publishedQuestionId?: string };
    if (json.publishedQuestionId) await this.questions.retire(auth, json.publishedQuestionId);

    await this.repo.updateBlock(auth.tenantId, blockId, { status: 'needs_review', publishedAt: null, reviewedBy: auth.userId, reviewedAt: sql`now()` });
    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'content_block.unpublished',
      entityType: 'content_block',
      entityId: blockId,
      after: { note: note ?? null, retiredQuestionId: json.publishedQuestionId ?? null },
    });
    return { blockId, kind: block.kind, published: false, questionId: json.publishedQuestionId ?? null, gateFailures: [], embeddings: null };
  }

  // ---------------------------------------------------------------- internals

  /** Approve or reject, with the reversal window enforced on an approval being undone. */
  private async decide(auth: AuthContext, blockId: string, status: 'approved' | 'rejected', note: string | null): Promise<ReviewedBlockDto> {
    const params = await this.params(auth.tenantId);
    const updated = await this.db.transaction(async (tx) => {
      const block = await this.requireBlock(auth, blockId, tx);
      if (block.status === 'published') {
        throw AppException.conflict('this block is published; unpublish it first', 'INVALID_STATE');
      }
      if (block.kind === 'ambiguous' && status === 'approved') {
        throw AppException.unprocessable('an ambiguous block must be reclassified before it can be approved', 'NOT_PUBLISHABLE', [
          { field: 'kind', message: 'reclassify it as theory, question or solution first' },
        ]);
      }
      // Undoing an approval is only allowed inside the configured window.
      if (block.status === 'approved' && status === 'rejected' && block.reviewedAt) {
        const hours = (Date.now() - block.reviewedAt.getTime()) / 3_600_000;
        const window = params.ingestion.approval_reversal_window_hours;
        if (hours > window) {
          throw AppException.conflict(
            `this block was approved ${Math.floor(hours)} hours ago, past the ${window}-hour window in which an approval can be undone`,
            'INVALID_STATE',
          );
        }
      }

      const row = await this.repo.updateBlock(
        auth.tenantId,
        blockId,
        { status, reviewedBy: auth.userId, reviewedAt: sql`now()`, contentJson: { ...((block.contentJson ?? {}) as Record<string, unknown>), reviewScope: 'content' } },
        tx,
      );
      if (!row) throw AppException.notFound('Content block not found');
      await this.resolveTasks(auth, blockId, note ?? status, tx, status === 'approved' ? 'approved' : 'rejected');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: status === 'approved' ? 'content_block.approved' : 'content_block.rejected',
          entityType: 'content_block',
          entityId: blockId,
          before: { status: block.status, reviewedBy: block.reviewedBy },
          after: { status, note },
        },
        tx,
      );
      return row;
    });
    return this.toDto(updated, params, openTasksOf(await this.repo.tasksOfBlock(auth.tenantId, blockId)));
  }

  /** Closes the open tasks that named this block: a decision is what resolves them. */
  private async resolveTasks(
    auth: AuthContext,
    blockId: string,
    note: string,
    tx: Database | Parameters<IngestionRepository['updateReviewTask']>[3],
    status: 'resolved' | 'approved' | 'rejected' = 'resolved',
    which: (task: ReviewTaskRow) => boolean = () => true,
  ): Promise<void> {
    const tasks = await this.repo.tasksOfBlock(auth.tenantId, blockId, tx);
    for (const task of tasks) {
      if (task.status !== 'open' && task.status !== 'in_progress') continue;
      if (!which(task)) continue;
      await this.repo.updateReviewTask(
        auth.tenantId,
        task.id,
        { status, resolvedBy: auth.userId, resolvedAt: sql`now()`, resolutionNote: note.slice(0, 2000) },
        tx,
      );
    }
  }

  private async requireBlock(auth: AuthContext, blockId: string, tx: Database): Promise<ContentBlockRow> {
    const block = await this.repo.findBlock(auth.tenantId, blockId, tx, true);
    if (!block) throw AppException.notFound('Content block not found');
    return block;
  }

  private async requireSubtopic(auth: AuthContext, subtopicId: string): Promise<void> {
    const candidates = await this.repo.syllabusCandidates(auth.tenantId, { trackId: null, subjectId: null });
    if (!candidates.some((c) => c.subtopicId === subtopicId)) {
      throw AppException.unprocessable('that sub-topic does not exist in this organisation, or is not published', 'REFERENCE_NOT_FOUND', [
        { field: 'subtopicId', message: 'pick an existing published sub-topic (new ones come from approving a syllabus suggestion)' },
      ]);
    }
  }

  private blocked(failures: { gate: string; detail: string }[]): AppException {
    return AppException.unprocessable(
      'this content does not pass the checks required before it can be published',
      'NOT_PUBLISHABLE',
      failures.map((f) => ({ field: f.gate, message: f.detail })),
    );
  }

  /**
   * The gates for one block, with the facts they need read off the block itself. The single place gate inputs are
   * built, so what the preview shows, what the approval decides and what `publish` enforces cannot drift apart.
   */
  private gatesFor(block: ContentBlockRow, params: IngestionParams, tasks: ReviewTaskRow[], reviewed: boolean, openOverride?: number): GateResult {
    const json = (block.contentJson ?? {}) as Record<string, unknown> & { question?: ExtractedQuestion | null; solution?: MatchedSolution | null };
    const fromOcr = Boolean(json.ocr);
    const open = openOverride ?? tasks.length;
    const text = block.normalizedText ?? block.rawText;

    if (block.kind === 'question' && json.question) {
      const q = json.question;
      return checkQuestionGates(
        {
          tenantMatches: true,
          stem: q.stem,
          type: q.type,
          options: q.options,
          numericAnswer: q.numericAnswer,
          matrixAnswer: null,
          subtopicId: block.subtopicId,
          difficultyLabel: q.difficultyLabel ?? sourceDifficultyToLabel(q.sourceDifficulty),
          expectedTimeSeconds: q.expectedTimeSeconds ?? null,
          referencesDiagram: referencesDiagram(q.stem),
          hasDiagramAsset: false,
          diagramAcknowledged: q.diagramAcknowledged === true,
          answerUnverified: q.answerSource === 'ai_unverified',
          fromOcr,
          reviewed,
          lowestConfidence: Math.min(block.classificationConfidence ?? 0, block.taggingConfidence ?? 0, q.confidence),
          solutionPending: solutionPending(json.solution, reviewed),
          openCriticalTasks: open,
        },
        params,
      );
    }
    return checkBlockGates(
      {
        tenantMatches: true,
        kind: block.kind,
        text,
        subtopicId: block.subtopicId,
        fromOcr,
        reviewed,
        lowestConfidence: Math.min(block.classificationConfidence ?? 0, block.taggingConfidence ?? 0),
        openCriticalTasks: open,
      },
      params,
    );
  }

  /** The block's readiness: the verdict the preview shows and the document approval acts on. */
  private readiness(block: ContentBlockRow, params: IngestionParams, tasks: ReviewTaskRow[], blocks?: ReadonlyMap<string, ContentBlockRow>): { assessment: Assessment; gates: GateResult } {
    const json = (block.contentJson ?? {}) as Record<string, unknown> & { autoApproval?: { autoApprove?: boolean; reason?: string } | null; solutionMatch?: { questionBlockId?: string | null; confirmed?: boolean } | null };
    const reviewed = contentReviewed(block);
    const gatesNow = this.gatesFor(block, params, tasks, reviewed);
    // What a person's confirmation could clear: the review gates, and the tasks a confirmation resolves. What no
    // confirmation clears — a missing answer, difficulty or time, a duplicate warning, an unmapped block — stays.
    const gatesIfConfirmed = this.gatesFor(block, params, tasks, true, tasks.filter((t) => !clearedByConfirmation(t)).length);
    const match = json.solutionMatch ?? null;
    const attached = block.kind === 'solution' && match?.confirmed === true && typeof match.questionBlockId === 'string' && blocks?.get(match.questionBlockId)?.status !== 'rejected';
    const draft = draftOf(json);
    const assessment = assessReadiness({
      status: block.status,
      kind: block.kind,
      contentReviewed: reviewed,
      aiTouched: isAiTouched(json),
      autoApprovalEligible: Boolean(json.autoApproval?.autoApprove),
      autoApprovalReason: json.autoApproval?.reason ?? null,
      draftActivated: Boolean(draft?.activation),
      fragment: isFragment(block),
      solutionAttached: attached,
      gatesNow,
      gatesIfConfirmed,
    });
    return { assessment, gates: gatesNow };
  }

  private toDto(block: ContentBlockRow, params: IngestionParams, tasks: ReviewTaskRow[], blocks?: ReadonlyMap<string, ContentBlockRow>): ReviewedBlockDto {
    const json = (block.contentJson ?? {}) as Record<string, unknown> & {
      question?: ExtractedQuestion | null;
      ocr?: unknown;
      solution?: MatchedSolution | null;
    };
    const fromOcr = Boolean(json.ocr);
    const text = block.normalizedText ?? block.rawText;
    const { assessment, gates } = this.readiness(block, params, tasks, blocks);
    const provenance = readProvenance(json);
    const draft = draftOf(json);

    return {
      id: block.id,
      jobId: block.jobId,
      kind: block.kind,
      format: block.format,
      status: block.status,
      title: block.title,
      text,
      // What the PDF said, before any rewriting. The same as `text` unless a model's faithful tidy-up replaced it.
      originalText: block.rawText,
      sourcePage: block.sourcePage,
      sortOrder: block.sortOrder,
      subtopicId: block.subtopicId,
      classificationConfidence: block.classificationConfidence,
      taggingConfidence: block.taggingConfidence,
      fromOcr,
      reviewedBy: block.reviewedBy,
      reviewedAt: block.reviewedAt?.toISOString() ?? null,
      contentReviewed: contentReviewed(block),
      mergedIntoId: block.mergedIntoId,
      splitFromId: block.splitFromId,
      openReviewTasks: tasks.length,
      publishable: gates.ok,
      gateFailures: gates.failures,
      readiness: assessment.readiness,
      readinessReasons: assessment.reasons,
      provenance: { ...provenance, classifiedBy: block.classifiedBy ?? null },
      // Spread rather than passed through: the DTO's contract is "whatever the extractor read",
      // which is an open-ended object to the client, not this phase's internal interface.
      question: json.question ? { ...json.question } : null,
      solution: json.solution ? { ...json.solution } : null,
      draft: draft ? { ...draft } : null,
      machineNotes: {
        classification: json.classification ?? null,
        mapping: json.mapping ?? null,
        autoApproval: json.autoApproval ?? null,
        source: json.source ?? null,
      },
      autoApprovalEligible: Boolean((json.autoApproval as { autoApprove?: boolean } | null)?.autoApprove),
      ...mappingEvidence(json.mapping, block.taggingConfidence),
    };
  }

  /** The active configuration's ingestion settings, for callers (the document approval) that assess blocks themselves. */
  ingestionParams(tenantId: string): Promise<IngestionParams> {
    return this.params(tenantId);
  }

  private async params(tenantId: string): Promise<IngestionParams> {
    const active = await this.engineConfig.rawActiveParams(tenantId);
    const parsed = parseIngestionParams(active.params);
    if (!parsed.ok) {
      throw AppException.unprocessable(
        `Engine configuration v${active.version} has no usable ingestion settings, so content cannot be reviewed`,
        'ENGINE_CONFIG_INVALID',
        parsed.issues.map((i) => ({ field: i.field, message: i.message })),
      );
    }
    return parsed.value;
  }
}


/** The own properties of a patch that were actually supplied, so `undefined` never overwrites. */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Whether a person has looked at a block's *content*. `reviewed_by` is also set when a reviewer merely chooses a
 * sub-topic (so a re-run keeps that choice), which is recorded as `reviewScope: 'mapping_only'` and is not review.
 */
export function contentReviewed(block: Pick<ContentBlockRow, 'reviewedBy' | 'contentJson'>): boolean {
  if (block.reviewedBy === null) return false;
  return (block.contentJson as { reviewScope?: unknown } | null)?.reviewScope !== 'mapping_only';
}

const isOpen = (t: ReviewTaskRow): boolean => t.status === 'open' || t.status === 'in_progress';

/** The open tasks of each block, from the tasks of a whole job. */
export function openTasksByBlock(tasks: readonly ReviewTaskRow[]): Map<string, ReviewTaskRow[]> {
  const out = new Map<string, ReviewTaskRow[]>();
  for (const task of tasks) {
    if (!isOpen(task) || !task.contentBlockId) continue;
    out.set(task.contentBlockId, [...(out.get(task.contentBlockId) ?? []), task]);
  }
  return out;
}

export function openTasksOf(tasks: readonly ReviewTaskRow[]): ReviewTaskRow[] {
  return tasks.filter(isOpen);
}

/**
 * Whether confirming a block clears this task. Low-confidence and incompleteness flags (priority 3 and below the
 * line the pipeline draws for "a contradiction or something missing") are what a person's look settles. A duplicate
 * warning is a decision about another question, a contradiction between a solution and the key (priority 1) is a
 * fact to be fixed, and an unmapped block needs a sub-topic: none of those is cleared by saying "I looked".
 */
export function clearedByConfirmation(task: Pick<ReviewTaskRow, 'priority' | 'kind' | 'suggestion'>): boolean {
  if (task.kind === 'duplicate_candidate') return false;
  if (isUnmappedTask(task)) return false;
  return task.priority >= 3;
}

function isUnmappedTask(task: Pick<ReviewTaskRow, 'suggestion'>): boolean {
  return (task.suggestion as { unmapped?: unknown } | null)?.unmapped === true;
}

/** What the pipeline wrote about the solution it matched to a question block. */
interface MatchedSolution {
  text?: string;
  confidence?: number;
  confirmed?: boolean;
}

/**
 * Whether a matched solution still needs settling before the question can publish.
 *
 * A match the pipeline *confirmed* — numbering agreed, the stated answer agreed, and the confidence
 * cleared the configured floor — is not pending, so a question whose provenance is clean can
 * publish without a person confirming what the evidence already said. A match below the floor, or
 * one whose stated answer contradicted the answer key, is pending until a human has looked at the
 * block; that is the case this gate exists for. A question with no matched solution at all is not
 * pending either — it simply has no official solution.
 */
function solutionPending(solution: MatchedSolution | null | undefined, reviewed: boolean): boolean {
  if (!solution) return false;
  if (solution.confirmed === true) return false;
  return !reviewed;
}

/**
 * The mapping evidence a reviewer needs, flattened out of `content_json.mapping`: why the block is (or
 * is not) mapped, the hierarchy the PDF prints above it, and the suggestion it waits on.
 */
function mappingEvidence(
  raw: unknown,
  taggingConfidence: number | null,
): Pick<
  ReviewedBlockDto,
  | 'mappingReason'
  | 'mappingConfidence'
  | 'suggestedChapter'
  | 'suggestedTopic'
  | 'suggestedSubtopic'
  | 'suggestionId'
  | 'existingChapterId'
  | 'existingTopicId'
  | 'existingSubtopicId'
  | 'alternatives'
> {
  const mapping = (raw !== null && typeof raw === 'object' ? raw : {}) as {
    reason?: unknown;
    confidence?: unknown;
    alternatives?: unknown;
    hierarchy?: {
      chapter?: string | null;
      topic?: string | null;
      subtopic?: string | null;
      suggestionId?: string | null;
      existingChapterId?: string | null;
      existingTopicId?: string | null;
      existingSubtopicId?: string | null;
    } | null;
  };
  const h = mapping.hierarchy ?? null;
  const alternatives = Array.isArray(mapping.alternatives)
    ? (mapping.alternatives as unknown[]).filter(
        (a): a is { subtopicId: string; score: number } =>
          typeof (a as { subtopicId?: unknown }).subtopicId === 'string' && typeof (a as { score?: unknown }).score === 'number',
      )
    : [];
  return {
    mappingReason: typeof mapping.reason === 'string' ? mapping.reason : null,
    mappingConfidence: typeof mapping.confidence === 'number' ? mapping.confidence : taggingConfidence,
    suggestedChapter: h?.chapter ?? null,
    suggestedTopic: h?.topic ?? null,
    suggestedSubtopic: h?.subtopic ?? null,
    suggestionId: h?.suggestionId ?? null,
    existingChapterId: h?.existingChapterId ?? null,
    existingTopicId: h?.existingTopicId ?? null,
    existingSubtopicId: h?.existingSubtopicId ?? null,
    alternatives: alternatives.map((a) => ({ subtopicId: a.subtopicId, score: a.score })),
  };
}
