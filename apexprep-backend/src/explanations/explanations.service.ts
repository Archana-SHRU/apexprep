import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AiService } from '../ai/ai.service';
import { PROMPT_VERSION } from '../ai/prompts';
import type { AiExplanation, PromptChunk } from '../ai/ai-provider';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database } from '../database/database.module';
import { isUniqueViolation } from '../database/pg-error';
import type { ExplanationContent, ExplanationRow } from '../database/schema';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { PracticeRepository } from '../practice/practice.repository';
import { QuestionsRepository } from '../questions/questions.repository';
import type { TheoryChunk } from './chunking';
import type {
  AdminExplanationDto,
  AskQuestionDto,
  AskQuestionResponseDto,
  ExplanationDto,
  ReindexResultDto,
  ReportQuestionDto,
  ReportResultDto,
} from './dto/explanations.dto';
import { parseExplanationParams, type ExplanationParams } from './explanation-params';
import { ExplanationsRepository, type QuestionForExplanation } from './explanations.repository';
import { assessGrounding, groundingBand, type GroundingAssessment } from './grounding';
import type { ScoredCandidate } from './retrieval';
import { TheoryRetrievalService, type Retrieval } from './theory-retrieval.service';
import { validateExplanation, type ValidationResult } from './validation';
import { requiresHumanApproval, studentVisibility, type Visibility } from './visibility';

/**
 * The explanation system.
 *
 * Resolution order, exactly as the requirements set it:
 *
 *   1. an approved official solution, if the course has one;
 *   2. otherwise theory is retrieved (sub-topic first, widening to topic then chapter) and an
 *      explanation is generated that may use only those notes;
 *   3. the result is scored for grounding against the notes it was given;
 *   4. if that score is below the configured band, the notes are dropped and a
 *      general-knowledge explanation is generated instead, labelled and sent for review.
 *
 * Two rules override everything above. An explanation whose own conclusion disagrees with the
 * question's answer key is **never served** — it is stored `rejected` with a review task, so
 * the failure is auditable and the student sees nothing. And a track configured for mandatory
 * approval holds every generated explanation until a human has passed it.
 *
 * Nothing here decides an adaptive rule, and nothing here re-implements grading: correctness
 * comes from `src/practice/grading.ts`, the same code that marks students.
 */
@Injectable()
export class ExplanationsService {
  private readonly logger = new Logger(ExplanationsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: ExplanationsRepository,
    private readonly questions: QuestionsRepository,
    // The answer key is read through the practice repository, so the explanation path checks
    // itself against exactly the record students are graded from.
    private readonly practice: PracticeRepository,
    private readonly engineConfig: EngineConfigService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly retrieval: TheoryRetrievalService,
  ) {}

  // ---------------------------------------------------------------- student read

  async forStudent(auth: AuthContext, questionId: string): Promise<ExplanationDto> {
    const { params, activatedAt } = await this.activeConfig(auth.tenantId);
    const question = await this.requireQuestion(auth.tenantId, questionId, { publishedOnly: true });

    // Eligibility. Without this the endpoint is an answer oracle: a worked solution is the
    // answer, so a student who has not answered the question must not be able to read one.
    //
    // The check does not consult `require_attempt`. The key is still validated — and a stored
    // `false` is rejected outright, see explanation-params.ts — but making the gate itself
    // conditional means one falsy value anywhere between `engine_configs` and here opens the
    // oracle. There is no configuration, and no bug in reading one, that reaches this line with
    // the gate skipped.
    if (!(await this.repo.hasAttempted(auth.tenantId, auth.userId, questionId))) {
      throw AppException.forbidden('Answer this question first; the explanation is available once you have submitted an attempt');
    }

    const optionKey = await this.repo.lastWrongOption(auth.tenantId, auth.userId, questionId);
    const resolved = await this.resolve(auth, question, optionKey, params, activatedAt);
    const visibility = this.visibilityOf(resolved, question, params);
    if (!visibility.visible) throw this.blocked(visibility.blockedReason);
    return this.toStudentDto(resolved, visibility);
  }

  // ---------------------------------------------------------------- ask doubt

  /**
   * Free-form conversational doubt clarification about a specific question.
   * Mandates that the student has submitted an attempt first to prevent answer leakage.
   */
  async ask(auth: AuthContext, questionId: string, dto: AskQuestionDto): Promise<AskQuestionResponseDto> {
    const question = await this.requireQuestion(auth.tenantId, questionId, { publishedOnly: true });

    if (!(await this.repo.hasAttempted(auth.tenantId, auth.userId, questionId))) {
      throw AppException.forbidden('Answer this question first; asking questions about it is available once you have submitted an attempt');
    }

    const official = await this.questions.approvedSolution(auth.tenantId, questionId);
    const existing = await this.repo.findActive(auth.tenantId, questionId, question.version, null);
    const existingContent = existing ? (existing.content as ExplanationContent) : null;

    if (this.ai.configured) {
      try {
        const { params } = await this.activeConfig(auth.tenantId);
        const retrieval = await this.retrieve(auth.tenantId, question, params);
        const promptNotes = retrieval.selected.map((c) => c.chunk.text).join('\n\n');
        const solutionContext = official?.body ?? existingContent?.summary ?? '';
        const prompt =
          `You are an expert AI tutor helping a student understand a problem they have already solved.\n` +
          `Question stem: ${question.stem}\n` +
          `Solution reference: ${solutionContext}\n` +
          `Course notes:\n${promptNotes}\n` +
          `Student's query (intent: ${dto.intent ?? 'free'}): "${dto.message}"\n` +
          `Provide a clear, pedagogical response answering the student's doubt. Reply in valid JSON with: {"answer": string, "steps": string[], "keyConcept": string | null}.`;

        const result = await this.ai.generateJson<{ answer: string; steps?: string[]; keyConcept?: string | null }>(
          {
            task: 'tutor',
            prompt,
            temperature: 0.3,
            maxOutputTokens: 1024,
          },
          (text) => {
            try {
              const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
              const parsed = JSON.parse(cleaned);
              if (parsed && typeof parsed.answer === 'string') {
                return { ok: true, value: parsed };
              }
              return { ok: false, reason: 'missing answer field' };
            } catch {
              return { ok: false, reason: 'invalid json' };
            }
          },
        );

        const officialSteps =
          official?.bodyJson && Array.isArray((official.bodyJson as Record<string, unknown>).steps)
            ? ((official.bodyJson as Record<string, unknown>).steps as string[])
            : [];
        return {
          questionId,
          answer: result.value.answer,
          steps: result.value.steps ?? (officialSteps.length > 0 ? officialSteps : existingContent?.steps ?? []),
          grounded: true,
          source: 'notes_only',
          keyConcept: result.value.keyConcept ?? existingContent?.keyConcept ?? null,
          answeredAt: new Date().toISOString(),
        };
      } catch (err) {
        this.logger.warn(`AI Ask Question generation failed; falling back to grounded solution guidance: ${err}`);
      }
    }

    if (official) {
      const officialSteps =
        official.bodyJson && Array.isArray((official.bodyJson as Record<string, unknown>).steps)
          ? ((official.bodyJson as Record<string, unknown>).steps as string[])
          : [];
      return {
        questionId,
        answer: `Direct guidance on "${dto.message}": ${official.body}`,
        steps: officialSteps,
        grounded: true,
        source: 'official_solution',
        keyConcept: existingContent?.keyConcept ?? null,
        answeredAt: new Date().toISOString(),
      };
    }

    if (existingContent && existing) {
      return {
        questionId,
        answer: `Direct guidance on "${dto.message}": ${existingContent.summary}`,
        steps: existingContent.steps ?? [],
        grounded: true,
        source: existing.sourceTier as any,
        keyConcept: existingContent.keyConcept ?? null,
        answeredAt: new Date().toISOString(),
      };
    }

    return {
      questionId,
      answer: `Regarding your query "${dto.message}": Review the core formulation and steps above for this question.`,
      steps: [],
      grounded: false,
      source: 'canned',
      keyConcept: null,
      answeredAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------- admin read and review

  async forAdmin(auth: AuthContext, questionId: string, optionKey: string | null): Promise<AdminExplanationDto> {
    const { params, activatedAt } = await this.activeConfig(auth.tenantId);
    const question = await this.requireQuestion(auth.tenantId, questionId, { publishedOnly: false });
    if (optionKey !== null) await this.requireOptionKey(auth.tenantId, questionId, optionKey);

    const resolved = await this.resolve(auth, question, optionKey, params, activatedAt);
    const visibility = this.visibilityOf(resolved, question, params);
    return this.toAdminDto(resolved, visibility);
  }

  /**
   * A reviewer's verdict. Approving is what releases an explanation on a track that requires
   * human approval; rejecting takes it out of circulation without deleting it.
   */
  async review(auth: AuthContext, explanationId: string, decision: 'approve' | 'reject', note?: string): Promise<AdminExplanationDto> {
    const params = await this.params(auth.tenantId);
    const existing = await this.repo.findById(auth.tenantId, explanationId);
    if (!existing) throw AppException.notFound('Explanation not found');

    const updated = await this.repo.update(auth.tenantId, explanationId, {
      status: decision === 'approve' ? 'active' : 'rejected',
      reviewedBy: auth.userId,
      reviewedAt: sql`now()`,
    });
    if (!updated) throw AppException.notFound('Explanation not found');

    await this.audit.record({
      tenantId: auth.tenantId,
      action: decision === 'approve' ? 'explanation.approved' : 'explanation.rejected',
      entityType: 'explanation',
      entityId: explanationId,
      before: { status: existing.status, reviewedAt: existing.reviewedAt },
      after: { status: updated.status, note: note ?? null },
    });

    const question = await this.requireQuestion(auth.tenantId, updated.questionId, { publishedOnly: false });
    const resolved: Resolved = { row: updated, question };
    return this.toAdminDto(resolved, this.visibilityOf(resolved, question, params));
  }

  // ---------------------------------------------------------------- indexing

  /**
   * Embeds a sub-topic's published theory so semantic retrieval has something to search.
   *
   * Separate from generating explanations on purpose: embedding is an admin action over
   * content, it costs provider calls per block, and `block_embeddings.content_hash` means a
   * block whose text has not changed is skipped. Nothing here reads or writes an explanation.
   */
  async reindexSubtopic(auth: AuthContext, subtopicId: string): Promise<ReindexResultDto> {
    if (!(await this.repo.semanticAvailable())) {
      throw AppException.unavailable(
        'Semantic retrieval is not available on this server: the pgvector extension is not installed, so embeddings cannot be stored',
        'AI_PROVIDER_UNAVAILABLE',
      );
    }
    const provider = this.ai.embeddingProvider();
    if (!provider?.embeddingModel) {
      throw AppException.unavailable(
        'No configured AI provider can produce embeddings',
        this.ai.configured ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_NOT_CONFIGURED',
      );
    }

    const blocks = await this.repo.publishedTheoryBlocks(auth.tenantId, subtopicId);
    let embedded = 0;
    let unchanged = 0;
    for (const block of blocks) {
      const result = await this.ai.embed([block.text]);
      const vector = result.vectors[0];
      if (!vector) continue;
      const outcome = await this.repo.saveEmbedding({
        tenantId: auth.tenantId,
        blockId: block.blockId,
        model: result.model,
        dims: vector.length,
        contentHash: block.contentHash,
        vector,
      });
      if (outcome === 'unchanged') unchanged += 1;
      else embedded += 1;
    }

    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'explanation.theory_reindexed',
      entityType: 'subtopic',
      entityId: subtopicId,
      after: { blocks: blocks.length, embedded, unchanged, model: provider.embeddingModel },
    });
    return { subtopicId, blocks: blocks.length, embedded, unchanged, model: provider.embeddingModel };
  }

  // ---------------------------------------------------------------- reporting

  /**
   * A student reports a question or its explanation.
   *
   * One open report per student per question is enforced by the database
   * (`review_tasks_open_report_uq`), so a second attempt is a conflict rather than a way to
   * inflate the count. Once the configured number of **distinct** students have reported, the
   * question's explanations are unpublished — status `flagged`, never deleted — and one
   * explanation-review task is opened for each.
   */
  async report(auth: AuthContext, questionId: string, dto: ReportQuestionDto): Promise<ReportResultDto> {
    const params = await this.params(auth.tenantId);
    const question = await this.requireQuestion(auth.tenantId, questionId, { publishedOnly: true });
    const active = await this.repo.findActive(auth.tenantId, questionId, question.version, null);

    const task = await this.db
      .transaction(async (tx) =>
        this.repo.insertReviewTask(
          {
            tenantId: auth.tenantId,
            kind: 'student_report',
            status: 'open',
            priority: dto.reason === 'wrong_answer' || dto.reason === 'wrong_solution' ? 1 : 3,
            questionId,
            explanationId: active?.id ?? null,
            reason: dto.reason,
            reporterUserId: auth.userId,
            reporterComment: dto.comment ?? null,
          },
          tx,
        ),
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw AppException.conflict('You have already reported this question; a reviewer is looking at it', 'CONFLICT');
        }
        throw error;
      });

    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'question.reported',
      entityType: 'question',
      entityId: questionId,
      after: { reason: dto.reason, reviewTaskId: task.id, explanationId: active?.id ?? null },
    });

    const reportCount = await this.repo.distinctReporters(auth.tenantId, questionId);
    let unpublished = false;
    if (reportCount >= params.explanation.reports.unpublish_threshold) {
      unpublished = await this.unpublishAfterReports(auth, questionId, reportCount);
    }

    return { reportId: task.id, reason: dto.reason, reportCount, explanationUnpublished: unpublished };
  }

  /** Flags every active explanation of a question and makes sure each has a review task. */
  private async unpublishAfterReports(auth: AuthContext, questionId: string, reportCount: number): Promise<boolean> {
    const flagged = await this.db.transaction(async (tx) => this.repo.setStatusForQuestion(auth.tenantId, questionId, 'flagged', tx));
    for (const row of flagged) {
      await this.repo.openExplanationReview({
        tenantId: auth.tenantId,
        questionId,
        explanationId: row.id,
        reason: `unpublished automatically after ${reportCount} student reports`,
        priority: 1,
        suggestion: { trigger: 'student_reports', reportCount, sourceTier: row.sourceTier, optionKey: row.optionKey },
      });
      await this.audit.record({
        tenantId: auth.tenantId,
        action: 'explanation.unpublished',
        entityType: 'explanation',
        entityId: row.id,
        before: { status: 'active' },
        after: { status: 'flagged', reportCount },
      });
    }
    return flagged.length > 0;
  }

  // ---------------------------------------------------------------- resolution

  /**
   * Serves the cached explanation when it is still valid, and generates one when it is not.
   *
   * The cache key is the (question, version, option) triple — with one correction first: an
   * approved official solution has no per-distractor variants (the database forbids them,
   * CHECK `explanations_option_key_tier`), so it is always stored and read under a null option
   * key. Resolving it under the student's own wrong option would miss the cache on every
   * request by a student who got the question wrong, and — once a row had been unpublished —
   * that miss would write a *new* active explanation and quietly undo the unpublish.
   */
  private async resolve(
    auth: AuthContext,
    question: QuestionForExplanation,
    requestedOptionKey: string | null,
    params: ExplanationParams,
    configActivatedAt: Date | null,
  ): Promise<Resolved> {
    const official = await this.questions.approvedSolution(auth.tenantId, question.id);
    const optionKey = official ? null : requestedOptionKey;

    const cached = await this.repo.findActive(auth.tenantId, question.id, question.version, optionKey);
    if (cached) {
      const staleness = await this.staleness(auth.tenantId, cached, configActivatedAt);
      if (staleness === null) return { row: cached, question, cacheHit: true };
      await this.db.transaction(async (tx) => this.repo.update(auth.tenantId, cached.id, { status: 'superseded' }, tx));
      await this.audit.record({
        tenantId: auth.tenantId,
        action: 'explanation.superseded',
        entityType: 'explanation',
        entityId: cached.id,
        after: { reason: staleness },
      });
      return { row: await this.generate(auth, question, optionKey, params, official), question, cacheHit: false };
    }

    const blocked = await this.repo.findBlocked(auth.tenantId, question.id, question.version, optionKey);
    if (blocked) {
      // An explanation students reported is terminal until a human clears it. Regenerating it
      // because the prompt or the theory has since changed would silently republish what three
      // students said was wrong, with no one having looked — and a review task is already open.
      if (blocked.status === 'flagged') return { row: blocked, question, cacheHit: true };
      // A generation that failed *automated* validation is remembered too, so a broken question
      // is not sent to the provider again on every request — but it is re-tried once its inputs
      // change, since that is what would fix it.
      if ((await this.staleness(auth.tenantId, blocked, configActivatedAt)) === null) return { row: blocked, question, cacheHit: true };
    }

    return { row: await this.generate(auth, question, optionKey, params, official), question, cacheHit: false };
  }

  /**
   * Why a cached explanation can no longer be used, or null when it is still good.
   *
   * Every input that could change the answer is checked, and each is derived from data already
   * on the row — no cache-key column to keep in step:
   *   * the question — `question_version` is on the row, and the lookup is keyed by it;
   *   * the notes — any grounding block edited since the explanation was generated;
   *   * the configuration — a newer `engine_config` version activated since;
   *   * the prompt — a different `PROMPT_VERSION` than this build uses.
   */
  private async staleness(tenantId: string, row: ExplanationRow, configActivatedAt: Date | null): Promise<string | null> {
    if (row.sourceTier !== 'official_solution' && row.promptVersion !== PROMPT_VERSION) {
      return `prompt changed (${row.promptVersion ?? 'none'} → ${PROMPT_VERSION})`;
    }
    const blocksChangedAt = await this.repo.blocksLastChangedAt(tenantId, row.groundingBlockIds);
    if (blocksChangedAt && blocksChangedAt > row.generatedAt) return 'the theory it was grounded in has been edited';
    if (configActivatedAt && configActivatedAt > row.generatedAt) return 'a new engine configuration was activated';
    return null;
  }

  private async generate(
    auth: AuthContext,
    question: QuestionForExplanation,
    optionKey: string | null,
    params: ExplanationParams,
    /** Already looked up by `resolve`, which needed it to pick the cache key. */
    official: Awaited<ReturnType<QuestionsRepository['approvedSolution']>>,
  ): Promise<ExplanationRow> {
    // 1. the official solution wins outright, and needs no provider.
    if (official) return this.storeOfficial(auth, question, official.id, official.body, official.bodyJson);

    if (!this.ai.configured) {
      throw AppException.unavailable(
        'This question has no official solution yet, and no AI provider is configured to write an explanation',
        'AI_NOT_CONFIGURED',
      );
    }

    const answerKey = await this.practice.questionForGrading(auth.tenantId, question.id);
    if (!answerKey) throw AppException.notFound('Question not found');

    // 2. retrieve, 3. generate grounded and score it.
    const retrieval = await this.retrieve(auth.tenantId, question, params);
    const questionText = await this.questionText(auth.tenantId, question);

    let grounded: { explanation: AiExplanation; provider: string; model: string; grounding: GroundingAssessment } | null = null;
    if (!retrieval.exhausted) {
      const result = await this.ai.generateExplanation({
        mode: 'grounded',
        questionType: question.type,
        stem: question.stem,
        options: await this.optionTexts(auth.tenantId, question.id),
        distractorKey: optionKey,
        subtopicName: question.subtopicName,
        chunks: retrieval.selected.map(toPromptChunk),
        locale: 'en',
      });
      const grounding = assessGrounding({ explanation: result.explanation, chunks: retrieval.selected, questionText });
      grounded = { explanation: result.explanation, provider: result.provider, model: result.model, grounding };

      if (groundingBand(grounding.score, params) !== 'insufficient') {
        return this.store(auth, question, optionKey, {
          tier: 'rag_grounded',
          explanation: result.explanation,
          provider: result.provider,
          model: result.model,
          grounding,
          retrieval,
          answerKey,
          params,
        });
      }
      this.logger.log(`grounding ${grounding.score} below band for question ${question.id}; falling back to general knowledge`);
    }

    // 4. general knowledge: generated again without the notes, so nothing from the notes can
    // be implied by content that was not supported by them.
    const general = await this.ai.generateExplanation({
      mode: 'general',
      questionType: question.type,
      stem: question.stem,
      options: await this.optionTexts(auth.tenantId, question.id),
      distractorKey: optionKey,
      subtopicName: question.subtopicName,
      chunks: [],
      locale: 'en',
    });
    return this.store(auth, question, optionKey, {
      tier: 'general_ai',
      explanation: general.explanation,
      provider: general.provider,
      model: general.model,
      grounding: grounded?.grounding ?? null,
      retrieval,
      answerKey,
      params,
    });
  }

  // ---------------------------------------------------------------- retrieval

  /**
   * Theory for this question, hard-filtered to the narrowest scope that has enough and widened
   * along `rag.widen_order` when it does not. Both halves of the hybrid search run per scope;
   * the vector half is skipped, and recorded as skipped, when pgvector or an embedding
   * provider is unavailable.
   */
  private retrieve(tenantId: string, question: QuestionForExplanation, params: ExplanationParams): Promise<Retrieval> {
    return this.retrieval.retrieve(
      tenantId,
      { subtopicId: question.subtopicId, topicId: question.topicId, chapterId: question.chapterId },
      question.stem,
      params,
    );
  }

  // ---------------------------------------------------------------- writing

  private async storeOfficial(
    auth: AuthContext,
    question: QuestionForExplanation,
    officialSolutionId: string,
    body: string,
    bodyJson: Record<string, unknown> | null,
  ): Promise<ExplanationRow> {
    const steps = Array.isArray(bodyJson?.steps) ? (bodyJson.steps as unknown[]).filter((s): s is string => typeof s === 'string') : [];
    const content: ExplanationContent = {
      summary: firstSentence(body),
      steps: steps.length > 0 ? steps : paragraphsOf(body),
      keyConcept: typeof bodyJson?.keyConcept === 'string' ? bodyJson.keyConcept : null,
      commonMistake: typeof bodyJson?.commonMistake === 'string' ? bodyJson.commonMistake : null,
      finalAnswer: null,
      diagnostics: { resolution: 'official_solution', officialSolutionId },
    };
    return this.insertOrReuse(auth, question, null, {
      tenantId: auth.tenantId,
      questionId: question.id,
      questionVersion: question.version,
      sourceTier: 'official_solution',
      officialSolutionId,
      content,
      status: 'active',
    });
  }

  private async store(auth: AuthContext, question: QuestionForExplanation, optionKey: string | null, input: StoreInput): Promise<ExplanationRow> {
    const validation = validateExplanation({
      explanation: input.explanation,
      answerKey: input.answerKey,
      retrievedBlockIds: input.retrieval.selected.flatMap((c) => c.chunk.blockIds),
      grounded: input.tier === 'rag_grounded',
      expected: { tenantId: auth.tenantId, questionId: question.id, questionVersion: question.version },
      actual: { tenantId: auth.tenantId, questionId: question.id, questionVersion: question.version },
    });

    const groundingBlockIds = input.tier === 'rag_grounded' ? (input.grounding?.supportingBlockIds ?? []) : [];
    const diagnostics = {
      resolution: input.tier,
      grounding: input.grounding,
      retrieval: {
        scope: input.retrieval.scope,
        trail: input.retrieval.trail,
        semanticUsed: input.retrieval.semanticUsed,
        semanticSkippedBecause: input.retrieval.semanticSkippedBecause,
        chunks: input.retrieval.selected.map((c) => ({ blockId: c.chunk.blockId, chunkIndex: c.chunk.chunkIndex, score: round3(c.score) })),
      },
      validation: { ok: validation.ok, failures: validation.failures },
      modelFinalAnswer: input.explanation.finalAnswer,
      citedBlockIds: input.explanation.citedBlockIds,
    };

    const content: ExplanationContent = {
      summary: input.explanation.summary,
      steps: input.explanation.steps,
      keyConcept: input.explanation.keyConcept,
      commonMistake: input.explanation.commonMistake,
      finalAnswer: input.explanation.finalAnswer,
      diagnostics,
    };

    // A grounded row must carry at least one supporting block (CHECK explanations_rag_grounded).
    // An explanation the notes did not support anywhere is not a grounded explanation.
    const tier = input.tier === 'rag_grounded' && groundingBlockIds.length === 0 ? 'general_ai' : input.tier;

    const row = await this.insertOrReuse(auth, question, optionKey, {
      tenantId: auth.tenantId,
      questionId: question.id,
      questionVersion: question.version,
      sourceTier: tier,
      provider: input.provider,
      model: input.model,
      promptVersion: PROMPT_VERSION,
      groundingScore: tier === 'rag_grounded' ? (input.grounding?.score ?? 0) : (input.grounding?.score ?? null),
      groundingBlockIds: tier === 'rag_grounded' ? groundingBlockIds : [],
      retrievalScope: tier === 'rag_grounded' ? input.retrieval.scope : null,
      content,
      optionKey,
      status: validation.ok ? 'active' : 'rejected',
    });

    await this.afterWrite(auth, question, row, validation, input.params);
    return row;
  }

  /**
   * Inserts the explanation, and on a unique-index collision returns the row the concurrent
   * request wrote instead. Generation happens outside any transaction (it is a network call),
   * so two students can arrive at once; the database decides which row is the active one.
   */
  private async insertOrReuse(
    auth: AuthContext,
    question: QuestionForExplanation,
    optionKey: string | null,
    values: Parameters<ExplanationsRepository['insert']>[0],
  ): Promise<ExplanationRow> {
    try {
      return await this.repo.insert(values);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.repo.findActive(auth.tenantId, question.id, question.version, optionKey);
      if (existing) return existing;
      throw error;
    }
  }

  /** Review tasks and audit rows the write implies. */
  private async afterWrite(
    auth: AuthContext,
    question: QuestionForExplanation,
    row: ExplanationRow,
    validation: ValidationResult,
    params: ExplanationParams,
  ): Promise<void> {
    if (!validation.ok) {
      await this.repo.openExplanationReview({
        tenantId: auth.tenantId,
        questionId: question.id,
        explanationId: row.id,
        reason: validation.answerMismatch
          ? 'blocked: the generated explanation argues for an answer the question marks wrong'
          : `blocked: ${validation.failures.map((f) => f.check).join(', ')}`,
        priority: 1,
        suggestion: { failures: validation.failures, modelFinalAnswer: row.content.finalAnswer },
      });
      await this.audit.record({
        tenantId: auth.tenantId,
        action: validation.answerMismatch ? 'explanation.answer_mismatch_blocked' : 'explanation.validation_failed',
        entityType: 'explanation',
        entityId: row.id,
        after: { failures: validation.failures.map((f) => f.check), status: row.status },
      });
      return;
    }

    if (row.sourceTier === 'general_ai' && params.explanation.approval.review_general_knowledge) {
      await this.repo.openExplanationReview({
        tenantId: auth.tenantId,
        questionId: question.id,
        explanationId: row.id,
        reason: 'general-knowledge explanation: not grounded in the course notes',
        priority: 2,
        suggestion: { sourceTier: row.sourceTier, groundingScore: row.groundingScore, optionKey: row.optionKey },
      });
    }
    // The same function the student-visibility check uses, deliberately: a second copy of the rule
    // here is a copy that can drift, and the two disagreeing means an explanation is either held
    // with no review task raised, or reviewed when it did not need to be.
    if (requiresHumanApproval(question.track, row.sourceTier, params)) {
      await this.repo.openExplanationReview({
        tenantId: auth.tenantId,
        questionId: question.id,
        explanationId: row.id,
        reason: 'this track requires a human to approve generated explanations before students see them',
        priority: 2,
        suggestion: { trackSlug: question.track.slug, trackKind: question.track.kind, sourceTier: row.sourceTier },
      });
    }

    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'explanation.generated',
      entityType: 'explanation',
      entityId: row.id,
      after: {
        sourceTier: row.sourceTier,
        provider: row.provider,
        model: row.model,
        groundingScore: row.groundingScore,
        retrievalScope: row.retrievalScope,
        optionKey: row.optionKey,
      },
    });
  }

  // ---------------------------------------------------------------- shared

  /**
   * The explanation settings, and when the configuration carrying them was activated.
   *
   * Both come from the one row. `staleness` needs the activation time to decide whether a cached
   * explanation predates the current configuration, and asking for it separately was a second query
   * against the row this method had just read — on every explanation request.
   */
  private async activeConfig(tenantId: string): Promise<{ params: ExplanationParams; activatedAt: Date | null }> {
    const active = await this.engineConfig.rawActiveParams(tenantId);
    const parsed = parseExplanationParams(active.params);
    if (!parsed.ok) {
      throw AppException.unprocessable(
        `Engine configuration v${active.version} has no usable explanation settings, so explanations cannot be produced`,
        'ENGINE_CONFIG_INVALID',
        parsed.issues.map((i) => ({ field: i.field, message: i.message })),
      );
    }
    return { params: parsed.value, activatedAt: active.activatedAt };
  }

  private async params(tenantId: string): Promise<ExplanationParams> {
    return (await this.activeConfig(tenantId)).params;
  }

  private async requireQuestion(
    tenantId: string,
    questionId: string,
    opts: { publishedOnly: boolean },
  ): Promise<QuestionForExplanation> {
    const question = await this.repo.questionForExplanation(tenantId, questionId);
    if (!question) throw AppException.notFound('Question not found');
    // A draft or retired question is not found *for a student*: the same answer another
    // organisation's question gives, so neither reveals what exists.
    if (opts.publishedOnly && question.status !== 'published') throw AppException.notFound('Question not found');
    return question;
  }

  private async requireOptionKey(tenantId: string, questionId: string, optionKey: string): Promise<void> {
    const keys = await this.repo.optionKeys(tenantId, questionId);
    if (!keys.includes(optionKey)) {
      throw AppException.validation([{ field: 'optionKey', message: `not an option of this question (${keys.join(', ') || 'none'})` }]);
    }
  }

  private visibilityOf(resolved: Resolved, question: QuestionForExplanation, params: ExplanationParams): Visibility {
    return studentVisibility(
      {
        tier: resolved.row.sourceTier,
        status: resolved.row.status,
        groundingScore: resolved.row.groundingScore,
        reviewedAt: resolved.row.reviewedAt,
        track: question.track,
      },
      params,
    );
  }

  private blocked(reason: string): AppException {
    const messages: Record<string, string> = {
      failed_validation: 'An explanation for this question did not pass its safety checks, so it is with a reviewer',
      unpublished_after_reports: 'This explanation was withdrawn after students reported it, and is with a reviewer',
      superseded: 'This explanation is out of date and is being rewritten',
      pending_human_approval: 'Explanations on this track are checked by a teacher before they are published',
    };
    return new AppException(
      HttpStatus.CONFLICT,
      'EXPLANATION_UNAVAILABLE',
      messages[reason] ?? 'No explanation is available for this question yet',
      [{ field: 'reason', message: reason }],
    );
  }

  private async questionText(tenantId: string, question: QuestionForExplanation): Promise<string> {
    const options = await this.optionTexts(tenantId, question.id);
    return [question.stem, ...options.map((o) => o.text)].join('\n');
  }

  private async optionTexts(tenantId: string, questionId: string): Promise<{ key: string; text: string }[]> {
    const view = await this.questions.studentQuestion(tenantId, questionId, false);
    return (view?.options ?? []).filter((o) => o.side === 'single').map((o) => ({ key: o.key, text: o.text }));
  }

  // ---------------------------------------------------------------- projections

  private toStudentDto(resolved: Resolved, visibility: Extract<Visibility, { visible: true }>): ExplanationDto {
    const { row } = resolved;
    return {
      id: row.id,
      questionId: row.questionId,
      questionVersion: row.questionVersion,
      source: visibility.source,
      notice: visibility.notice,
      summary: row.content.summary,
      steps: row.content.steps,
      keyConcept: row.content.keyConcept,
      commonMistake: row.content.commonMistake,
      optionKey: row.optionKey,
      underReview: visibility.requiresReview,
      generatedAt: row.generatedAt.toISOString(),
    };
  }

  private toAdminDto(resolved: Resolved, visibility: Visibility): AdminExplanationDto {
    const { row } = resolved;
    return {
      id: row.id,
      questionId: row.questionId,
      questionVersion: row.questionVersion,
      sourceTier: row.sourceTier,
      status: row.status,
      optionKey: row.optionKey,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      groundingScore: row.groundingScore,
      groundingBlockIds: row.groundingBlockIds,
      retrievalScope: row.retrievalScope,
      studentVisible: visibility.visible,
      blockedReason: visibility.visible ? null : visibility.blockedReason,
      diagnostics: row.content.diagnostics ?? {},
      summary: row.content.summary,
      steps: row.content.steps,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      generatedAt: row.generatedAt.toISOString(),
    };
  }
}

// ---------------------------------------------------------------- local types

interface Resolved {
  row: ExplanationRow;
  question: QuestionForExplanation;
  cacheHit?: boolean;
}

interface StoreInput {
  tier: 'rag_grounded' | 'general_ai';
  explanation: AiExplanation;
  provider: string;
  model: string;
  grounding: GroundingAssessment | null;
  retrieval: Retrieval;
  answerKey: Parameters<typeof validateExplanation>[0]['answerKey'];
  params: ExplanationParams;
}

function toPromptChunk(candidate: ScoredCandidate): PromptChunk {
  return {
    blockId: candidate.chunk.blockId,
    chunkIndex: candidate.chunk.chunkIndex,
    title: candidate.chunk.title,
    text: candidate.chunk.text,
  };
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^[\s\S]*?[.!?](\s|$)/.exec(trimmed);
  const candidate = (match?.[0] ?? trimmed).trim();
  return candidate.length > 0 ? candidate.slice(0, 4000) : trimmed.slice(0, 4000);
}

function paragraphsOf(text: string): string[] {
  const parts = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.slice(0, 30) : [text.trim().slice(0, 4000)];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type { TheoryChunk };
