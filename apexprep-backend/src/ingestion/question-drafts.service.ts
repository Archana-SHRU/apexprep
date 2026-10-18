import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { DRIZZLE, type Database } from '../database/database.module';
import { tracks, type ContentAssetRow, type ContentBlockRow, type IngestionJobRow } from '../database/schema';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { chunkBlocks, type TheoryChunk } from '../explanations/chunking';
import { parseExplanationParams } from '../explanations/explanation-params';
import { audienceFor } from '../learning-ai/audience';
import { buildGenerationPrompt, parseGeneratedQuestion, QGEN_PROMPT_VERSION } from '../learning-ai/questions/generation.prompt';
import { validateGeneratedQuestion } from '../learning-ai/questions/generation.validation';
import { LearningAiRepository } from '../learning-ai/learning-ai.repository';
import { packBatches } from '../learning-ai/source';
import { groupKeyOf } from './learning-drafts.service';
import { reassess, type ExtractedQuestion } from './question-extraction';
import type { IngestionParams } from './ingestion-params';
import { IngestionRepository } from './ingestion.repository';
import { EXTRACTED, readProvenance, setProvenance, withAi } from './provenance';
import { isFragment } from './readiness';
import { hashText } from './segmentation';

/** Not enough theory to base a question on: a question would be built on a sentence or on the model's memory. */
const MIN_SOURCE_CHARS = 600;
/** The levels drafted for each group of theory, and how many questions at each. */
const LEVELS = [1, 2, 3, 4] as const;
const QUESTIONS_PER_LEVEL = 1;
/** Bounds on cost for one document: groups drafted, and tries per question (a rejected draft is retried once). */
const MAX_GROUPS_PER_JOB = 6;
const ATTEMPTS_PER_QUESTION = 2;
/** Source put in front of the model for one question. */
const WINDOW_TOKENS = 3000;
const OUTPUT_TOKENS = 4096;
const AVOID_IN_PROMPT = 12;

export interface QuestionDraftOutcome {
  drafted: number;
  rejected: number;
  note: string | null;
}

/**
 * Drafts of practice questions for a freshly ingested document: for each group of theory, a question at each of
 * levels 1-4, written from that theory and nothing else.
 *
 * It reuses the question-generation machinery the learner-facing feature has — the same prompt, parser and, above
 * all, the same validator (shape, the model's worked solution graded against its own key by the real grader, answer
 * leakage, grounding in the cited notes, duplicates) — and then does what that feature does not: it does not put the
 * result in the bank. Each question becomes a block in the document's preview, labelled `ai_generated`, that a person
 * reads, edits and approves together with everything else.
 *
 * What a model says about its own question is not treated as fact:
 *   * the **answer** is `ai_unverified`: the `answer_verified` gate refuses to publish it until a person has checked it;
 *   * the **level** and **expected time** are `suggested` values, counted only when the person accepts them;
 *   * the worked solution is kept, and published with the question once approved.
 *
 * With no model configured it does nothing and says so. It never writes placeholder questions.
 */
@Injectable()
export class QuestionDraftsService {
  private readonly logger = new Logger(QuestionDraftsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: IngestionRepository,
    private readonly learningRepo: LearningAiRepository,
    private readonly ai: AiService,
    private readonly engineConfig: EngineConfigService,
    private readonly audit: AuditService,
  ) {}

  async generate(job: IngestionJobRow, asset: ContentAssetRow, _params: IngestionParams): Promise<QuestionDraftOutcome> {
    if (!this.ai.configured) return { drafted: 0, rejected: 0, note: 'no AI provider is configured, so no questions were drafted' };

    const active = await this.engineConfig.rawActiveParams(job.tenantId);
    const explanation = parseExplanationParams(active.params);
    if (!explanation.ok) return { drafted: 0, rejected: 0, note: 'the active configuration has no usable grounding settings, so no questions were drafted' };
    const { chunk, grounding } = explanation.value.explanation;

    const blocks = await this.repo.blocksOfJob(job.tenantId, job.id);
    const sources = blocks.filter(
      (b) =>
        b.kind === 'theory' &&
        !isFragment(b) &&
        readProvenance(b.contentJson).origin !== 'ai_generated' &&
        (b.status === 'extracted' || b.status === 'needs_review' || b.status === 'approved'),
    );
    // A group that already has drafted questions (a re-run that kept them) is left as it is.
    const alreadyDrafted = new Set(
      blocks.filter((b) => b.kind === 'question' && readProvenance(b.contentJson).origin === 'ai_generated').map((b) => (b.contentJson as { generated?: { groupKey?: string } } | null)?.generated?.groupKey).filter((k): k is string => typeof k === 'string'),
    );

    const groups = new Map<string, ContentBlockRow[]>();
    for (const block of sources) {
      const key = groupKeyOf(block);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), block]);
    }

    const audience = await this.audienceOf(job.tenantId, asset.trackId);
    const skipped: string[] = [];
    let drafted = 0;
    let rejected = 0;
    let groupsDone = 0;

    for (const [groupKey, members] of groups) {
      if (alreadyDrafted.has(groupKey)) continue;
      const ordered = [...members].sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || a.sortOrder - b.sortOrder);
      const first = ordered[0]!;
      const path = pathOf(first);
      const text = ordered.map((b) => b.normalizedText ?? b.rawText).join('\n');
      if (text.length < MIN_SOURCE_CHARS) {
        skipped.push(`"${path}": too little theory to base questions on`);
        continue;
      }
      if (groupsDone >= MAX_GROUPS_PER_JOB) {
        skipped.push(`further group(s) were left without drafted questions (limit of ${MAX_GROUPS_PER_JOB} per document)`);
        break;
      }
      groupsDone += 1;

      const sourceBlocks = ordered.map((b, i) => ({ blockId: b.id, title: b.title, text: b.normalizedText ?? b.rawText, contentHash: b.contentHash, sortOrder: i }));
      const chunks = chunkBlocks(
        sourceBlocks.map((b) => ({ blockId: b.blockId, title: b.title, text: b.text, sortOrder: b.sortOrder })),
        { minTokens: chunk.min_tokens, maxTokens: Math.min(chunk.max_tokens, WINDOW_TOKENS) },
      );
      const windows = packBatches(chunks, WINDOW_TOKENS, 50) ?? [chunks];
      const existing = first.subtopicId ? await this.learningRepo.subtopicStems(job.tenantId, first.subtopicId) : [];
      const stems: string[] = [...existing];
      const last = ordered[ordered.length - 1]!;
      let slot = 0;

      for (const level of LEVELS) {
        for (let n = 0; n < QUESTIONS_PER_LEVEL; n += 1) {
          const window: TheoryChunk[] = windows[slot % windows.length]!;
          slot += 1;
          const windowIds = new Set(window.flatMap((c) => c.blockIds));
          const windowSources = sourceBlocks.filter((s) => windowIds.has(s.blockId)).map((s) => ({ blockId: s.blockId, title: s.title, text: s.text }));

          let made = false;
          for (let attempt = 0; attempt < ATTEMPTS_PER_QUESTION && !made; attempt += 1) {
            try {
              const reply = await this.ai.generateJson(
                {
                  task: 'question_generation',
                  temperature: 0.7,
                  maxOutputTokens: OUTPUT_TOKENS,
                  prompt: buildGenerationPrompt({ audience, subtopicPath: path, type: 'single_correct', level, chunks: window, avoid: stems.slice(0, AVOID_IN_PROMPT) }),
                },
                parseGeneratedQuestion,
              );
              const verdict = validateGeneratedQuestion({
                draft: reply.value,
                requestedType: 'single_correct',
                sources: windowSources,
                existingStems: stems,
                minGrounding: grounding.mostly_notes_min,
              });
              if (!verdict.ok || !verdict.shape) {
                rejected += 1;
                this.logger.warn(`job ${job.id}: a drafted L${level} question for "${path}" was rejected: ${verdict.failures.map((f) => f.check).join(', ')}`);
                continue;
              }

              const q = reply.value;
              const proposal = reassess({
                type: 'single_correct',
                stem: q.stem.trim(),
                options: q.options.map((o) => ({ key: o.key.toUpperCase(), text: o.text, isCorrect: o.isCorrect })),
                numericAnswer: null,
                sourceNumber: null,
                sourceDifficulty: null,
                difficultyLabel: null,
                expectedTimeSeconds: null,
                // The share of the question the cited notes support: a measure, not the model's say-so.
                confidence: Math.max(0.01, Math.min(0.99, verdict.groundingScore)),
                gaps: [],
                answerSource: 'ai_unverified',
                difficultySource: null,
                expectedTimeSource: null,
                suggested: { by: 'ai', difficultyLabel: level, expectedTimeSeconds: q.expectedTimeSeconds, note: `asked for level ${level}; the model's own estimate of the time. Neither is a measurement.` },
                shapeValid: true,
                shapeErrors: [],
              });
              const solutionText = [q.solution.summary, ...q.solution.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n');
              const rendered = [proposal.stem, ...proposal.options.map((o) => `(${o.key}) ${o.text}`)].join('\n');

              await this.repo.insertBlock({
                tenantId: job.tenantId,
                jobId: job.id,
                assetId: asset.id,
                sourcePage: last.sourcePage ?? 1,
                kind: 'question',
                format: 'paragraph',
                title: null,
                rawText: rendered,
                normalizedText: rendered,
                contentHash: hashText(`${groupKey}|${level}|${rendered}`),
                classificationConfidence: proposal.confidence,
                classifiedBy: 'model',
                subtopicId: first.subtopicId,
                taggingConfidence: ordered.reduce<number>((min, b) => Math.min(min, b.taggingConfidence ?? 0), 1),
                sortOrder: last.sortOrder,
                status: 'needs_review',
                contentJson: setProvenance(
                  {
                    question: proposal,
                    solution: { text: solutionText, confidence: 1, confirmed: true },
                    mapping: (first.contentJson as { mapping?: unknown } | null)?.mapping ?? null,
                    source: { assetId: asset.id, page: last.sourcePage },
                    generated: { groupKey, level, promptVersion: QGEN_PROMPT_VERSION, groundingScore: verdict.groundingScore, sourceBlockIds: verdict.usedBlockIds },
                  },
                  { ...withAi(EXTRACTED, { task: 'question_generation', provider: reply.provider, model: reply.model, at: new Date().toISOString() }), origin: 'ai_generated' },
                ),
              });
              stems.push(proposal.stem);
              drafted += 1;
              made = true;
            } catch (error) {
              skipped.push(`"${path}": ${error instanceof Error ? error.message : 'the model could not be reached'}`);
              this.logger.warn(`job ${job.id}: question draft for "${path}" failed: ${error instanceof Error ? error.message : 'unknown'}`);
              break;
            }
          }
        }
      }
    }

    if (drafted > 0 || rejected > 0) {
      await this.audit.record({
        tenantId: job.tenantId,
        action: 'ingestion_job.question_drafts_generated',
        entityType: 'ingestion_job',
        entityId: job.id,
        after: { drafted, rejected, promptVersion: QGEN_PROMPT_VERSION },
      });
    }
    const notes = [...skipped.slice(0, 4), ...(rejected > 0 ? [`${rejected} drafted question(s) failed validation and were discarded`] : [])];
    return { drafted, rejected, note: notes.length > 0 ? notes.join('; ') : null };
  }

  private async audienceOf(tenantId: string, trackId: string | null): Promise<string> {
    const generic = 'a student studying this material. Use clear, precise language.';
    if (!trackId) return generic;
    const [track] = await this.db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track || track.tenantId !== tenantId) return generic;
    return audienceFor({
      name: track.name,
      kind: track.kind ?? null,
      gradeLabel: track.gradeLabel ?? null,
      gradeOrdinal: track.gradeOrdinal ?? null,
      examFamily: track.examFamily ?? null,
    });
  }
}

/** A readable path for a group, from the headings the document gave its first block. */
function pathOf(block: Pick<ContentBlockRow, 'contentJson' | 'title'>): string {
  const h = (block.contentJson as { mapping?: { hierarchy?: { chapter?: string | null; topic?: string | null; subtopic?: string | null } | null } } | null)?.mapping?.hierarchy;
  const parts = [h?.chapter, h?.topic, h?.subtopic].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' › ') : (block.title ?? 'this material');
}
