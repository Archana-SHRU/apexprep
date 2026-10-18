import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException, type ErrorDetail } from '../common/errors/app-exception';
import { decodeCursor, toPage, type Page } from '../common/pagination/cursor';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { questions, type OfficialSolutionRow, type QuestionOptionRow, type QuestionRow } from '../database/schema';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { SyllabusRepository } from '../syllabus/syllabus.repository';
import type {
  AdminQuestionDto,
  AdminQuestionSummaryDto,
  CreateQuestionDto,
  ListQuestionsQueryDto,
  OfficialSolutionDto,
  OfficialSolutionInputDto,
  QuestionTaxonomyDto,
  UpdateQuestionDto,
} from './dto/questions.dto';
import { validateQuestionShape, type QuestionShapeResult } from './question-shape';
import { QuestionsRepository, type QuestionListRow } from './questions.repository';

const STEM_PREVIEW = 200;

function toSolutionDto(r: OfficialSolutionRow): OfficialSolutionDto {
  return { id: r.id, body: r.body, bodyJson: r.bodyJson ?? null, finalAnswerText: r.finalAnswerText, status: r.status, createdAt: r.createdAt.toISOString() };
}

function toSummary(r: QuestionListRow): AdminQuestionSummaryDto {
  return {
    id: r.id,
    subtopicId: r.subtopicId,
    subjectName: r.subjectName ?? null,
    trackName: r.trackName ?? null,
    type: r.type,
    status: r.status,
    version: r.version,
    stemPreview: r.stem.length > STEM_PREVIEW ? `${r.stem.slice(0, STEM_PREVIEW)}…` : r.stem,
    difficultyLabel: r.difficultyLabel,
    difficultyB: r.difficultyB,
    expectedTimeSeconds: r.expectedTimeSeconds,
    hasOfficialSolution: r.hasOfficialSolution,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toAdminDto(
  q: QuestionRow,
  options: QuestionOptionRow[],
  secondarySubtopicIds: string[],
  solution: OfficialSolutionRow | undefined,
  taxonomy?: QuestionTaxonomyDto | null,
): AdminQuestionDto {
  return {
    id: q.id,
    subtopicId: q.primarySubtopicId,
    secondarySubtopicIds,
    type: q.type,
    status: q.status,
    version: q.version,
    stem: q.stem,
    stemJson: q.stemJson ?? null,
    options: options.map((o) => ({ id: o.id, key: o.optionKey, side: o.side, text: o.body, isCorrect: o.isCorrect, sortOrder: o.sortOrder })),
    numericAnswer:
      q.correctNumeric != null && q.numericTolerance != null && q.toleranceMode != null
        ? { value: q.correctNumeric, tolerance: q.numericTolerance, mode: q.toleranceMode }
        : null,
    matrixAnswer: q.matrixAnswer ?? null,
    difficultyLabel: q.difficultyLabel,
    difficultyB: q.difficultyB,
    calibrationN: q.calibrationN,
    expectedTimeSeconds: q.expectedTimeSeconds,
    hints: q.hints,
    officialSolution: solution ? toSolutionDto(solution) : null,
    sourceAssetId: q.sourceAssetId,
    sourcePage: q.sourcePage,
    publishedAt: q.publishedAt?.toISOString() ?? null,
    taxonomy: taxonomy ?? null,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

/**
 * The question bank as content admins use it (`questions:manage`).
 *
 * Answer shape is validated in TypeScript on every write (question-shape.ts), so a saved
 * question always satisfies the database's publish validator; AP002 remains the backstop
 * and surfaces as 422 NOT_PUBLISHABLE. Publishing, retiring and deleting are status
 * changes, never destructive: attempts reference questions by id and version.
 */
@Injectable()
export class QuestionsAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: QuestionsRepository,
    private readonly syllabus: SyllabusRepository,
    private readonly engineConfig: EngineConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Cursor-paginated by default. With `page` it serves numbered pages instead and adds `total`, `page` and
   * `pageSize`; the two modes cannot be mixed, because a cursor already says where the page starts.
   */
  async list(auth: AuthContext, query: ListQuestionsQueryDto): Promise<Page<AdminQuestionSummaryDto> & { total?: number; page?: number; pageSize?: number }> {
    if (query.page !== undefined && query.cursor) {
      throw AppException.validation([{ field: 'cursor', message: 'send either page or cursor, not both' }]);
    }
    const filters = {
      trackId: query.trackId,
      subjectId: query.subjectId,
      subtopicId: query.subtopicId,
      status: query.status,
      type: query.type,
      difficultyLabel: query.difficultyLabel,
      search: query.search,
    };

    if (query.page !== undefined) {
      const pageSize = query.pageSize ?? query.limit ?? 20;
      const [total, rows] = await Promise.all([
        this.repo.count(auth.tenantId, filters),
        this.repo.list(auth.tenantId, filters, pageSize, undefined, (query.page - 1) * pageSize),
      ]);
      return { items: rows.slice(0, pageSize).map(toSummary), nextCursor: null, total, page: query.page, pageSize };
    }

    const limit = query.limit ?? 20;
    const rows = await this.repo.list(auth.tenantId, filters, limit, query.cursor ? decodeCursor(query.cursor) : undefined);
    return toPage(rows, limit, toSummary);
  }

  async get(auth: AuthContext, id: string): Promise<AdminQuestionDto> {
    const question = await this.repo.findById(auth.tenantId, id);
    if (!question) throw AppException.notFound('Question not found');
    const [options, secondary, solution, taxonomy] = await Promise.all([
      this.repo.options(auth.tenantId, id),
      this.repo.secondarySubtopicIds(auth.tenantId, id),
      this.repo.approvedSolution(auth.tenantId, id),
      this.repo.taxonomy(auth.tenantId, question.primarySubtopicId),
    ]);
    return toAdminDto(question, options, secondary, solution, taxonomy);
  }

  async create(auth: AuthContext, dto: CreateQuestionDto): Promise<AdminQuestionDto> {
    const shape = this.shapeOrThrow({
      type: dto.type,
      options: dto.options,
      numericAnswer: dto.numericAnswer,
      matrixAnswer: dto.matrixAnswer,
    });
    const difficultyB = await this.engineConfig.initialDifficultyB(auth.tenantId, dto.difficultyLabel);

    const id = await this.db.transaction(async (tx) => {
      await this.requireSubtopics(auth, dto.subtopicId, dto.secondarySubtopicIds ?? [], tx);
      const question = await this.repo.insert(
        {
          tenantId: auth.tenantId,
          primarySubtopicId: dto.subtopicId,
          type: dto.type,
          stem: dto.stem,
          stemJson: dto.stemJson ?? null,
          correctNumeric: shape.correctNumeric,
          numericTolerance: shape.numericTolerance,
          toleranceMode: shape.toleranceMode,
          matrixAnswer: shape.matrixAnswer,
          difficultyLabel: dto.difficultyLabel,
          difficultyB,
          expectedTimeSeconds: dto.expectedTimeSeconds,
          hints: dto.hints ?? [],
          status: 'draft',
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        tx,
      );
      await this.repo.replaceOptions(auth.tenantId, question.id, shape.options, tx);
      if (dto.secondarySubtopicIds?.length) await this.repo.replaceSecondarySubtopics(auth.tenantId, question.id, dto.secondarySubtopicIds, tx);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'question.created',
          entityType: 'question',
          entityId: question.id,
          after: { type: question.type, subtopicId: question.primarySubtopicId, difficultyLabel: question.difficultyLabel, status: question.status },
        },
        tx,
      );
      return question.id;
    });
    return this.get(auth, id);
  }

  async update(auth: AuthContext, id: string, dto: UpdateQuestionDto): Promise<AdminQuestionDto> {
    await this.db.transaction(async (tx) => {
      const current = await this.repo.findById(auth.tenantId, id, tx, true);
      if (!current) throw AppException.notFound('Question not found');

      const answerTouched = dto.options !== undefined || dto.numericAnswer !== undefined || dto.matrixAnswer !== undefined;
      let shape: QuestionShapeResult | undefined;
      if (answerTouched) {
        const currentOptions = await this.repo.options(auth.tenantId, id, tx);
        shape = this.shapeOrThrow({
          type: current.type,
          options: dto.options ?? currentOptions.map((o) => ({ key: o.optionKey, text: o.body, isCorrect: o.isCorrect, side: o.side })),
          numericAnswer:
            dto.numericAnswer ??
            (current.correctNumeric != null
              ? { value: current.correctNumeric, tolerance: current.numericTolerance ?? undefined, mode: current.toleranceMode ?? undefined }
              : undefined),
          matrixAnswer: dto.matrixAnswer ?? current.matrixAnswer ?? undefined,
        });
      }

      const patch: PgUpdateSetSource<typeof questions> = { updatedBy: auth.userId };
      if (dto.subtopicId !== undefined) patch.primarySubtopicId = dto.subtopicId;
      if (dto.stem !== undefined) patch.stem = dto.stem;
      if (dto.stemJson !== undefined) patch.stemJson = dto.stemJson;
      if (dto.expectedTimeSeconds !== undefined) patch.expectedTimeSeconds = dto.expectedTimeSeconds;
      if (dto.hints !== undefined) patch.hints = dto.hints;
      if (dto.difficultyLabel !== undefined && dto.difficultyLabel !== current.difficultyLabel) {
        patch.difficultyLabel = dto.difficultyLabel;
        // A question the engine has already calibrated keeps its learned difficulty; an
        // uncalibrated one restarts from the new level's initial value (DECISIONS.md §B24).
        if (current.calibrationN === 0) patch.difficultyB = await this.engineConfig.initialDifficultyB(auth.tenantId, dto.difficultyLabel, tx);
      }
      if (shape) {
        patch.correctNumeric = shape.correctNumeric;
        patch.numericTolerance = shape.numericTolerance;
        patch.toleranceMode = shape.toleranceMode;
        patch.matrixAnswer = shape.matrixAnswer;
      }

      const primary = dto.subtopicId ?? current.primarySubtopicId;
      const secondary = dto.secondarySubtopicIds ?? [];
      if (dto.subtopicId !== undefined || dto.secondarySubtopicIds !== undefined) {
        await this.requireSubtopics(auth, primary, secondary, tx);
      }

      await this.repo.update(auth.tenantId, id, patch, tx);
      if (shape) await this.repo.replaceOptions(auth.tenantId, id, shape.options, tx);
      if (dto.secondarySubtopicIds !== undefined) await this.repo.replaceSecondarySubtopics(auth.tenantId, id, secondary, tx);

      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'question.updated',
          entityType: 'question',
          entityId: id,
          before: { version: current.version, difficultyLabel: current.difficultyLabel, subtopicId: current.primarySubtopicId },
          after: { fields: Object.keys(dto), answerChanged: Boolean(shape) },
        },
        tx,
      );
    });
    return this.get(auth, id);
  }

  publish(auth: AuthContext, id: string): Promise<AdminQuestionDto> {
    return this.changeStatus(auth, id, 'published', ['draft', 'in_review', 'retired']);
  }

  retire(auth: AuthContext, id: string): Promise<AdminQuestionDto> {
    return this.changeStatus(auth, id, 'retired', ['published']);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await this.repo.findById(auth.tenantId, id, tx, true);
      if (!current) throw AppException.notFound('Question not found');
      if (current.status === 'published') {
        throw AppException.conflict('Retire the question before deleting it, so students in a session are not left without it', 'INVALID_STATE');
      }
      await this.repo.update(auth.tenantId, id, { deletedAt: sql`now()`, updatedBy: auth.userId }, tx);
      await this.audit.record({ tenantId: auth.tenantId, action: 'question.deleted', entityType: 'question', entityId: id, before: { status: current.status } }, tx);
    });
  }

  /**
   * Replaces the approved official solution. The previous one is soft-deleted rather than
   * edited, so cached explanations that cite it stay traceable to the text they used.
   */
  async setOfficialSolution(auth: AuthContext, id: string, dto: OfficialSolutionInputDto): Promise<OfficialSolutionDto> {
    return this.db.transaction(async (tx) => {
      const question = await this.repo.findById(auth.tenantId, id, tx, true);
      if (!question) throw AppException.notFound('Question not found');
      const replaced = await this.repo.softDeleteSolutions(auth.tenantId, id, tx);
      const row = await this.repo.insertSolution(
        {
          tenantId: auth.tenantId,
          questionId: id,
          body: dto.body,
          bodyJson: dto.bodyJson ?? null,
          finalAnswerText: dto.finalAnswerText ?? null,
          status: 'approved',
          approvedBy: auth.userId,
          approvedAt: sql`now()`,
          createdBy: auth.userId,
        },
        tx,
      );
      await this.audit.record(
        { tenantId: auth.tenantId, action: 'official_solution.set', entityType: 'official_solution', entityId: row.id, after: { questionId: id, replaced } },
        tx,
      );
      return toSolutionDto(row);
    });
  }

  async removeOfficialSolution(auth: AuthContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const question = await this.repo.findById(auth.tenantId, id, tx, true);
      if (!question) throw AppException.notFound('Question not found');
      const removed = await this.repo.softDeleteSolutions(auth.tenantId, id, tx);
      if (removed === 0) throw AppException.notFound('This question has no official solution');
      await this.audit.record({ tenantId: auth.tenantId, action: 'official_solution.removed', entityType: 'question', entityId: id }, tx);
    });
  }

  // ---------------------------------------------------------------- internals

  private shapeOrThrow(input: Parameters<typeof validateQuestionShape>[0]): QuestionShapeResult {
    const outcome = validateQuestionShape(input);
    if (!outcome.ok) throw AppException.validation(outcome.errors);
    return outcome.value;
  }

  private async changeStatus(auth: AuthContext, id: string, next: 'published' | 'retired', from: string[]): Promise<AdminQuestionDto> {
    await this.db.transaction(async (tx) => {
      const current = await this.repo.findById(auth.tenantId, id, tx, true);
      if (!current) throw AppException.notFound('Question not found');
      if (current.status === next) throw AppException.conflict(`This question is already ${next}`, 'INVALID_STATE');
      if (!from.includes(current.status)) {
        throw AppException.conflict(`A ${current.status} question cannot be ${next} (allowed from: ${from.join(', ')})`, 'INVALID_STATE');
      }
      if (next === 'published') {
        const errors = await this.publishBlockers(auth.tenantId, current, tx);
        if (errors.length > 0) throw AppException.unprocessable('This question cannot be published yet', 'NOT_PUBLISHABLE', errors);
      }
      await this.repo.update(
        auth.tenantId,
        id,
        { status: next, updatedBy: auth.userId, ...(next === 'published' ? { publishedAt: sql`now()` } : {}) },
        tx,
      );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: next === 'published' ? 'question.published' : 'question.retired',
          entityType: 'question',
          entityId: id,
          before: { status: current.status },
          after: { status: next, version: current.version },
        },
        tx,
      );
    });
    return this.get(auth, id);
  }

  /** The same rules the database enforces (AP002), checked first so the admin gets field-level errors. */
  private async publishBlockers(tenantId: string, question: QuestionRow, tx: Executor): Promise<ErrorDetail[]> {
    const options = await this.repo.options(tenantId, question.id, tx);
    const outcome = validateQuestionShape({
      type: question.type,
      options: options.map((o) => ({ key: o.optionKey, text: o.body, isCorrect: o.isCorrect, side: o.side })),
      numericAnswer:
        question.correctNumeric != null
          ? { value: question.correctNumeric, tolerance: question.numericTolerance ?? undefined, mode: question.toleranceMode ?? undefined }
          : undefined,
      matrixAnswer: question.matrixAnswer ?? undefined,
    });
    return outcome.ok ? [] : outcome.errors;
  }

  /** Sub-topics must exist in this tenant; the secondary list may not repeat the primary (AP004). */
  private async requireSubtopics(auth: AuthContext, primaryId: string, secondaryIds: string[], tx: Executor): Promise<void> {
    if (!(await this.syllabus.lockLiveNode('subtopic', auth.tenantId, primaryId, tx, 'share'))) {
      throw AppException.unprocessable('Unknown sub-topic', 'REFERENCE_NOT_FOUND', [{ field: 'subtopicId', message: 'sub-topic not found' }]);
    }
    const seen = new Set<string>();
    for (const [i, subtopicId] of secondaryIds.entries()) {
      if (subtopicId === primaryId) {
        throw AppException.unprocessable('A secondary sub-topic cannot be the primary one', 'UNPROCESSABLE', [
          { field: `secondarySubtopicIds[${i}]`, message: 'this is already the primary sub-topic' },
        ]);
      }
      if (seen.has(subtopicId)) {
        throw AppException.unprocessable('Duplicate secondary sub-topic', 'UNPROCESSABLE', [{ field: `secondarySubtopicIds[${i}]`, message: 'listed twice' }]);
      }
      seen.add(subtopicId);
      if (!(await this.syllabus.lockLiveNode('subtopic', auth.tenantId, subtopicId, tx, 'share'))) {
        throw AppException.unprocessable('Unknown sub-topic', 'REFERENCE_NOT_FOUND', [{ field: `secondarySubtopicIds[${i}]`, message: 'sub-topic not found' }]);
      }
    }
  }
}
