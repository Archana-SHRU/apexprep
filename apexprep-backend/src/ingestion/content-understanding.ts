import type { AiService } from '../ai/ai.service';
import {
  buildContentUnderstandingPrompt,
  parseContentUnderstandingReply,
  type ExtractedContentUnderstanding,
} from '../ai/prompts';
import type { QuestionType } from '../database/schema';
import { validateQuestionShape } from '../questions/question-shape';
import { reassess, type AnswerSource, type ExtractedOption, type ExtractedQuestion } from './question-extraction';
import type { SegmentedBlock } from './segmentation';
import { statedAnswerOf } from './solution-matching';

/**
 * What a configured model may add to what the rules read — and, more to the point, what it may not.
 *
 * A model is asked to structure a block the rules could not read cleanly. Its output is **never trusted as
 * evidence**:
 *
 *   * **The answer key.** A model marking option B correct is only believed when the document itself states B
 *     (`groundAnswer`). Otherwise the question keeps the model's mark but is labelled `ai_unverified`, which the
 *     `answer_verified` gate refuses to publish until a person has looked. A model's confidence is a number it
 *     produced about its own output; it says nothing about whether the answer is right.
 *   * **Difficulty and solving time.** Neither is in a printed question. What a model (or an estimate) proposes is
 *     kept apart as `suggested`, shown to the reviewer, and counted only once a person accepts or sets it. The
 *     `expected_time` and `difficulty` gates stay exactly as strict as they were.
 *   * **Rewritten text.** A model's tidied text replaces the extracted text only if it says no more than the source
 *     (`isFaithfulRewrite`); the original is always kept in `raw_text`, whatever happens here.
 *
 * Everything the model touched is marked, so a reviewer can tell extracted content from assisted content.
 */

export interface UnderstandBlockParams {
  ai: AiService;
  block: SegmentedBlock;
  context: {
    subjectName?: string;
    topicName?: string;
  };
}

export interface AiUnderstanding {
  value: ExtractedContentUnderstanding;
  provider: string;
  model: string;
}

/**
 * Asks the configured provider to analyse an ambiguous block, or a question the rules read with gaps.
 * Null when no provider is configured or the reply could not be used: the caller then keeps the rules' reading.
 */
export async function understandBlockWithAi(params: UnderstandBlockParams): Promise<AiUnderstanding | null> {
  const { ai, block, context } = params;
  if (!ai.configured) return null;

  try {
    const prompt = buildContentUnderstandingPrompt(block.text, context);
    const result = await ai.generateJson(
      {
        task: 'content_understanding',
        prompt,
        temperature: 0,
        maxOutputTokens: 2048,
      },
      (text) => parseContentUnderstandingReply(text),
    );
    return { value: result.value, provider: result.provider, model: result.model };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- grounding the answer

/** The option keys a block's own text says are correct: "Answer: B", "Ans. (A) and (C)", "Correct answer is D". */
export function statedOptionKeys(text: string): string[] {
  const keys = new Set<string>();
  const lines = text.split('\n');
  for (const line of lines) {
    const match = /\b(?:correct\s+)?(?:answers?|ans)\b\.?\s*(?:is|are)?\s*[:=\-]?\s*(.*)$/i.exec(line);
    if (!match) continue;
    const rest = match[1] ?? '';
    // Only a short tail that is *made of* option labels, joined by and / commas — not a sentence that happens
    // to contain the letter A ("answer a question").
    if (!/^\s*\(?[A-Da-d]\)?(?:\s*(?:,|and|&|or|\/)\s*\(?[A-Da-d]\)?)*\s*[.;]?\s*$/i.test(rest)) continue;
    for (const k of rest.matchAll(/\(?\b([A-Da-d])\b\)?/g)) keys.add(k[1]!.toUpperCase());
  }
  return [...keys].sort();
}

/**
 * Whether the document states the answer a model marked. `source` when it does, `ai_unverified` when a model
 * marked an answer the document does not state (or states differently), null when nothing is marked at all.
 */
export function groundAnswer(
  sourceText: string,
  question: { type: QuestionType; options: readonly ExtractedOption[]; numericAnswer: ExtractedQuestion['numericAnswer'] },
): AnswerSource | null {
  if (question.type === 'integer' || question.type === 'numeric') {
    if (!question.numericAnswer) return null;
    const stated = statedAnswerOf(sourceText).numeric;
    if (stated === null) return 'ai_unverified';
    return Number(stated) === Number(question.numericAnswer.value) ? 'source' : 'ai_unverified';
  }
  const marked = question.options.filter((o) => o.isCorrect).map((o) => o.key.toUpperCase()).sort();
  if (marked.length === 0) return null;
  const stated = statedOptionKeys(sourceText);
  return stated.length > 0 && stated.join() === marked.join() ? 'source' : 'ai_unverified';
}

// ---------------------------------------------------------------- rewritten text

const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0);

/**
 * Whether a model's tidied version of a block says no more than the block did: almost every word of it is a word
 * of the source, and it is not materially longer. Whitespace, line breaks and formula delimiters are free; added
 * sentences are not. This is what stops a "cleanup" from becoming a place where content is invented.
 */
export function isFaithfulRewrite(source: string, rewrite: string): boolean {
  const original = tokensOf(source);
  const rewritten = tokensOf(rewrite);
  if (rewritten.length === 0) return false;
  if (rewritten.length > Math.max(original.length * 1.25, original.length + 5)) return false;
  const known = new Set(original);
  const unknown = rewritten.filter((t) => !known.has(t)).length;
  return unknown / rewritten.length <= 0.1;
}

// ---------------------------------------------------------------- what a model may suggest

const DIFFICULTY_MAP: Record<'EASY' | 'MEDIUM' | 'HARD', number> = {
  EASY: 1,
  MEDIUM: 3,
  HARD: 4,
};

/**
 * A rough figure a reviewer can accept or replace, by type and the model's difficulty. It is an estimate, not a
 * measurement: it is shown beside the field as a suggestion and never written into it.
 */
export function estimatedTimeSeconds(type: QuestionType, difficulty: 'EASY' | 'MEDIUM' | 'HARD'): number {
  switch (type) {
    case 'single_correct':
    case 'assertion_reason':
      return difficulty === 'EASY' ? 90 : difficulty === 'MEDIUM' ? 120 : 180;
    case 'multi_correct':
      return difficulty === 'EASY' ? 150 : difficulty === 'MEDIUM' ? 180 : 240;
    case 'integer':
    case 'numeric':
      return difficulty === 'EASY' ? 120 : difficulty === 'MEDIUM' ? 150 : 210;
    default:
      return 180;
  }
}

// ---------------------------------------------------------------- applying the reply

export interface AppliedUnderstanding {
  block: SegmentedBlock;
  proposal: ExtractedQuestion | null;
  /** What happened to the block's text: kept as extracted, replaced by a faithful rewrite, or a rewrite refused. */
  textDecision: 'unchanged' | 'rewritten' | 'rewrite_refused';
}

/**
 * Merges a model's structured reading into a block and its question proposal, under the rules in the header.
 * The block's `text` is replaced only by a faithful rewrite; callers keep the original separately.
 */
export function applyAiUnderstanding(
  block: SegmentedBlock,
  understanding: ExtractedContentUnderstanding,
  currentProposal: ExtractedQuestion | null,
): AppliedUnderstanding {
  if (understanding.classification === 'question' && understanding.question) {
    const q = understanding.question;
    const options: ExtractedOption[] = q.options.map((o) => ({
      key: o.key.toUpperCase(),
      text: o.text,
      // A model that says the answer is not in the document is believed; one that marks an answer is checked below.
      isCorrect: q.answerExplicitlyPresent ? o.isCorrect : false,
    }));
    const numericAnswer = q.answerExplicitlyPresent ? q.numericAnswer : null;

    const answerSource = q.answerExplicitlyPresent ? groundAnswer(block.text, { type: q.type, options, numericAnswer }) : null;
    const shape = validateQuestionShape({
      type: q.type,
      options: options.length > 0 ? options : undefined,
      numericAnswer: numericAnswer ?? undefined,
    });

    const proposal = reassess({
      type: q.type,
      stem: q.stem,
      options,
      numericAnswer,
      sourceNumber: currentProposal?.sourceNumber ?? null,
      sourceDifficulty: currentProposal?.sourceDifficulty ?? null,
      // Only a difficulty the document printed counts. The model's own is a suggestion.
      difficultyLabel: currentProposal?.difficultyLabel ?? null,
      expectedTimeSeconds: currentProposal?.expectedTimeSeconds ?? null,
      confidence: understanding.confidence,
      gaps: [],
      shapeValid: shape.ok,
      shapeErrors: [],
      answerSource,
      difficultySource: currentProposal?.difficultySource ?? null,
      expectedTimeSource: currentProposal?.expectedTimeSource ?? null,
      suggested: {
        by: 'ai',
        difficultyLabel: DIFFICULTY_MAP[q.difficulty] ?? 3,
        expectedTimeSeconds: estimatedTimeSeconds(q.type, q.difficulty),
        note: 'proposed by a model from the question text; it is not a measurement',
      },
    });
    // `reassess` lists what is missing now; add the one thing it cannot see — that the document stated no answer.
    if (!q.answerExplicitlyPresent && !proposal.gaps.includes('no answer was stated in the source text')) {
      proposal.gaps.push('no answer was stated in the source text');
    }

    return {
      block: { ...block, kind: 'question', confidence: understanding.confidence, reason: 'structured AI question understanding' },
      proposal,
      textDecision: 'unchanged',
    };
  }

  if (understanding.classification === 'theory' && understanding.theory) {
    const t = understanding.theory;
    const faithful = t.normalizedText.trim().length > 0 && isFaithfulRewrite(block.text, t.normalizedText);
    return {
      block: {
        ...block,
        kind: 'theory',
        format: t.format,
        title: t.title ?? block.title,
        text: faithful ? t.normalizedText : block.text,
        confidence: understanding.confidence,
        reason: 'structured AI theory understanding',
      },
      proposal: null,
      textDecision: faithful ? (t.normalizedText.trim() === block.text.trim() ? 'unchanged' : 'rewritten') : 'rewrite_refused',
    };
  }

  // A block the rules could not place that the model says is a worked solution: let solution matching take it from here.
  if (understanding.classification === 'solution' && block.kind === 'ambiguous') {
    return {
      block: { ...block, kind: 'solution', confidence: understanding.confidence, reason: 'structured AI classification as a solution' },
      proposal: currentProposal,
      textDecision: 'unchanged',
    };
  }

  return { block, proposal: currentProposal, textDecision: 'unchanged' };
}
