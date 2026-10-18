import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { coldStartTheta, levelForTheta, parentTopicTheta, targetDifficulty, type EngineParams } from '../../adaptive';
import { AiService } from '../../ai/ai.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { isOlympiadTrack } from '../../common/learning/track-identity';
import { DRIZZLE, type Database } from '../../database/database.module';
import { EngineConfigService } from '../../engine-config/engine-config.service';
import type { TheoryChunk } from '../../explanations/chunking';
import { parseExplanationParams, type ExplanationParams } from '../../explanations/explanation-params';
import { ExplanationsRepository } from '../../explanations/explanations.repository';
import { PracticeRepository } from '../../practice/practice.repository';
import { QuestionsRepository } from '../../questions/questions.repository';
import { audienceFor } from '../audience';
import type { GeneratableType, GenerateQuestionsDto, GeneratedQuestionsResultDto } from '../dto/learning-ai.dto';
import { LearningAiRepository, type SubtopicContext } from '../learning-ai.repository';
import { chunkSources, sourceHash, type SourceBlock } from '../source';
import { buildGenerationPrompt, parseGeneratedQuestion, QGEN_PROMPT_VERSION, type RawGeneratedQuestion } from './generation.prompt';
import { validateGeneratedQuestion, type GenerationValidation } from './generation.validation';

/** Fresh questions a learner may request per rolling day: a cost ceiling, not a learning rule. */
export const DAILY_GENERATION_LIMIT = 30;
/** Notes put in front of the model per question: enough to build on, bounded so a prompt stays small. */
const SOURCE_WINDOW_TOKENS = 3000;
/** How many existing stems the model is shown to avoid; all of them are still checked afterwards. */
const AVOID_IN_PROMPT = 12;
const OUTPUT_TOKENS = 4096;

/**
 * AI question generation that works **with** the adaptive engine.
 *
 * The engine keeps every decision it already owns. This service asks it what it would aim for — the
 * learner's θ in the sub-topic (or the engine's own cold-start estimate), the target difficulty from
 * `target_success`, and the level band that target falls in — and generates a question for exactly that
 * level. The question is stored as an ordinary question at that level with the engine's own
 * `initial_b_by_level` difficulty, so it joins the sub-topic's pool and is **selected by the engine**
 * like any other: nothing here serves a question, updates θ, or bypasses selection.
 *
 * Nothing unvalidated reaches the bank. A generation that fails any check is recorded as rejected, with
 * why, and never becomes a question. On an Olympiad track a valid question still waits for a human
 * (`in_review`), the same rule generated explanations follow there.
 */
@Injectable()
export class QuestionGenerationService {
  private readonly logger = new Logger(QuestionGenerationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: LearningAiRepository,
    private readonly ai: AiService,
    private readonly engineConfig: EngineConfigService,
    private readonly practice: PracticeRepository,
    private readonly questions: QuestionsRepository,
    private readonly explanations: ExplanationsRepository,
    private readonly audit: AuditService,
  ) {}

  async generate(auth: AuthContext, dto: GenerateQuestionsDto): Promise<GeneratedQuestionsResultDto> {
    const ctx = await this.repo.subtopicContext(auth.tenantId, dto.subtopicId);
    if (!ctx) throw AppException.notFound('Sub-topic not found');
    const count = dto.count ?? 1;
    const type: GeneratableType = dto.type ?? 'single_correct';

    const used = await this.repo.countGeneratedSince(auth.tenantId, auth.userId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (used + count > DAILY_GENERATION_LIMIT) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        `You can ask for up to ${DAILY_GENERATION_LIMIT} fresh questions a day. Your existing practice questions are still available.`,
      );
    }

    const sources = await this.sourcesFor(auth.tenantId, ctx);
    if (sources.length === 0) {
      throw AppException.unprocessable(
        'There are no published notes for this topic yet, so fresh questions cannot be written from them.',
        'NO_SOURCE_CONTENT',
      );
    }
    if (!this.ai.configured) {
      throw AppException.unavailable('Question generation needs an AI provider, and none is configured on this server', 'AI_NOT_CONFIGURED');
    }

    const config = await this.engineConfig.requireActive(auth.tenantId);
    const explanationParams = await this.explanationParams(auth.tenantId);
    const target = await this.adaptiveTarget(auth, ctx.subtopicId, config.params);
    const difficultyB = await this.engineConfig.initialDifficultyB(auth.tenantId, target.level);
    const olympiad = isOlympiadTrack(ctx.track, explanationParams.explanation.approval.mandatory_track_slug_patterns);

    const limits = { minTokens: explanationParams.explanation.chunk.min_tokens, maxTokens: explanationParams.explanation.chunk.max_tokens };
    const chunks = chunkSources(sources, limits);
    const existing = await this.repo.subtopicStems(auth.tenantId, ctx.subtopicId);
    const offset = await this.repo.countGeneratedForSubtopic(auth.tenantId, ctx.subtopicId);
    const hash = sourceHash(sources);
    const audience = audienceFor(ctx.track);

    const generated: GeneratedQuestionsResultDto['generated'] = [];
    let rejected = 0;
    const maxAttempts = count + 2;
    for (let attempt = 0; attempt < maxAttempts && generated.length < count; attempt += 1) {
      // Each attempt reads a different window of the notes, so repeated requests cover the sub-topic.
      const window = windowOf(chunks, offset + attempt, SOURCE_WINDOW_TOKENS);
      const windowSources = sources.filter((s) => window.some((c) => c.blockIds.includes(s.blockId)));
      let reply: { provider: string; model: string; value: RawGeneratedQuestion };
      try {
        reply = await this.ai.generateJson(
          {
            task: 'question_generation',
            temperature: 0.7,
            maxOutputTokens: OUTPUT_TOKENS,
            prompt: buildGenerationPrompt({
              audience,
              subtopicPath: `${ctx.subjectName} › ${ctx.chapterName} › ${ctx.topicName} › ${ctx.subtopicName}`,
              type,
              level: target.level,
              chunks: window,
              avoid: existing.slice(0, AVOID_IN_PROMPT),
            }),
          },
          parseGeneratedQuestion,
        );
      } catch (error) {
        // The provider is down: whatever was already generated stands, and practice carries on regardless.
        if (generated.length > 0) break;
        throw error;
      }

      const validation = validateGeneratedQuestion({
        draft: reply.value,
        requestedType: type,
        sources: windowSources,
        existingStems: existing,
        minGrounding: explanationParams.explanation.grounding.mostly_notes_min,
      });

      if (!validation.ok || !validation.shape) {
        rejected += 1;
        await this.recordRejection(auth, ctx, type, target, hash, reply, validation);
        continue;
      }

      const questionId = await this.storeQuestion(auth, ctx, type, target, difficultyB, hash, reply, validation, olympiad);
      existing.unshift(reply.value.stem);
      generated.push({ questionId, type, difficultyLabel: target.level, status: olympiad ? 'in_review' : 'published' });
    }

    if (generated.length === 0) {
      throw AppException.unprocessable(
        'No new question passed the quality checks this time, so none were added. Your existing practice questions are unaffected.',
        'AI_OUTPUT_REJECTED',
      );
    }
    const added = generated.filter((g) => g.status === 'published').length;
    return {
      targetLevel: target.level,
      generated,
      rejected,
      message: olympiad
        ? `${generated.length} new question${generated.length === 1 ? ' was' : 's were'} written at L${target.level} and sent to a teacher for approval before they appear in practice.`
        : `${added} new question${added === 1 ? '' : 's'} at L${target.level} joined your practice set. The adaptive engine will serve ${added === 1 ? 'it' : 'them'} when ${added === 1 ? 'it matches' : 'they match'} your level.`,
    };
  }

  // ---------------------------------------------------------------- the engine's target

  /**
   * What the engine would aim for: the learner's θ here (or the cold-start estimate from their sibling
   * sub-topics, exactly as a first session would compute it), the target difficulty, and its level band.
   * Read-only — no ability row is created by asking.
   */
  private async adaptiveTarget(auth: AuthContext, subtopicId: string, params: EngineParams): Promise<{ theta: number; targetB: number; level: number }> {
    const ability = await this.practice.findAbility(auth.tenantId, auth.userId, subtopicId);
    const theta = ability ? ability.theta : coldStartTheta(params, parentTopicTheta(await this.practice.siblingThetas(auth.tenantId, auth.userId, subtopicId)));
    const targetB = targetDifficulty(theta, params);
    return { theta, targetB, level: levelForTheta(targetB, params) };
  }

  // ---------------------------------------------------------------- sources

  /** The sub-topic's published notes; the parent topic's when the sub-topic has none of its own. */
  private async sourcesFor(tenantId: string, ctx: SubtopicContext): Promise<SourceBlock[]> {
    const own = await this.repo.theoryInScope(tenantId, 'subtopic', ctx.subtopicId, 400);
    if (own.length > 0) return own;
    return this.repo.theoryInScope(tenantId, 'topic', ctx.topicId, 400);
  }

  // ---------------------------------------------------------------- writing

  private async storeQuestion(
    auth: AuthContext,
    ctx: SubtopicContext,
    type: GeneratableType,
    target: { targetB: number; level: number },
    difficultyB: number,
    hash: string,
    reply: { provider: string; model: string; value: RawGeneratedQuestion },
    validation: GenerationValidation,
    olympiad: boolean,
  ): Promise<string> {
    const shape = validation.shape!;
    const draft = reply.value;
    return this.db.transaction(async (tx) => {
      const question = await this.questions.insert(
        {
          tenantId: auth.tenantId,
          primarySubtopicId: ctx.subtopicId,
          type,
          stem: draft.stem.trim(),
          correctNumeric: shape.correctNumeric,
          numericTolerance: shape.numericTolerance,
          toleranceMode: shape.toleranceMode,
          matrixAnswer: null,
          difficultyLabel: target.level,
          difficultyB,
          expectedTimeSeconds: draft.expectedTimeSeconds,
          hints: draft.hints,
          sourceBlockId: validation.usedBlockIds[0] ?? null,
          status: olympiad ? 'in_review' : 'published',
          ...(olympiad ? {} : { publishedAt: sql`now()` }),
        },
        tx,
      );
      await this.questions.replaceOptions(auth.tenantId, question.id, shape.options, tx);
      const row = await this.repo.insertGenerated(
        {
          tenantId: auth.tenantId,
          questionId: question.id,
          subtopicId: ctx.subtopicId,
          requestedBy: auth.userId,
          status: olympiad ? 'in_review' : 'published',
          questionType: type,
          targetLevel: target.level,
          targetB: Math.round(target.targetB * 100) / 100,
          provider: reply.provider,
          model: reply.model,
          promptVersion: QGEN_PROMPT_VERSION,
          sourceBlockIds: validation.usedBlockIds,
          sourceHash: hash,
          stemFingerprint: validation.fingerprint,
          validation: { ok: true, groundingScore: validation.groundingScore },
          solution: draft.solution,
        },
        tx,
      );
      if (olympiad) {
        await this.explanations.insertReviewTask(
          {
            tenantId: auth.tenantId,
            kind: 'question_review',
            status: 'open',
            priority: 2,
            questionId: question.id,
            reason: 'AI-generated question on an Olympiad track: a teacher approves it before students see it',
            suggestion: { generatedQuestionId: row.id, targetLevel: target.level, provider: reply.provider },
          },
          tx,
        );
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: 'question.generated',
          entityType: 'question',
          entityId: question.id,
          after: {
            generatedQuestionId: row.id,
            subtopicId: ctx.subtopicId,
            type,
            targetLevel: target.level,
            status: question.status,
            provider: reply.provider,
            model: reply.model,
            groundingScore: validation.groundingScore,
          },
        },
        tx,
      );
      return question.id;
    });
  }

  private async recordRejection(
    auth: AuthContext,
    ctx: SubtopicContext,
    type: GeneratableType,
    target: { targetB: number; level: number },
    hash: string,
    reply: { provider: string; model: string; value: RawGeneratedQuestion },
    validation: GenerationValidation,
  ): Promise<void> {
    const row = await this.repo.insertGenerated({
      tenantId: auth.tenantId,
      questionId: null,
      subtopicId: ctx.subtopicId,
      requestedBy: auth.userId,
      status: 'rejected',
      questionType: type,
      targetLevel: target.level,
      targetB: Math.round(target.targetB * 100) / 100,
      provider: reply.provider,
      model: reply.model,
      promptVersion: QGEN_PROMPT_VERSION,
      sourceBlockIds: validation.usedBlockIds,
      sourceHash: hash,
      stemFingerprint: validation.fingerprint,
      validation: { ok: false, failures: validation.failures, groundingScore: validation.groundingScore, duplicateOf: validation.duplicateOf },
      // Kept for review: a rejected draft is evidence about the prompt, never served.
      solution: { draft: reply.value },
    });
    this.logger.log(`generated question rejected for sub-topic ${ctx.subtopicId}: ${validation.failures.map((f) => f.check).join(', ')}`);
    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'question.generation_rejected',
      entityType: 'generated_question',
      entityId: row.id,
      after: { subtopicId: ctx.subtopicId, failures: validation.failures.map((f) => f.check) },
    });
  }

  private async explanationParams(tenantId: string): Promise<ExplanationParams> {
    const active = await this.engineConfig.rawActiveParams(tenantId);
    const parsed = parseExplanationParams(active.params);
    if (!parsed.ok) throw AppException.unprocessable('The active configuration has no usable grounding settings', 'ENGINE_CONFIG_INVALID');
    return parsed.value;
  }
}

/** Consecutive chunks totalling at most `maxTokens`, starting at `start` (wrapping round). */
export function windowOf(chunks: readonly TheoryChunk[], start: number, maxTokens: number): TheoryChunk[] {
  if (chunks.length === 0) return [];
  const out: TheoryChunk[] = [];
  let tokens = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[(start + i) % chunks.length]!;
    if (out.length > 0 && tokens + chunk.tokenEstimate > maxTokens) break;
    out.push(chunk);
    tokens += chunk.tokenEstimate;
  }
  return out;
}
