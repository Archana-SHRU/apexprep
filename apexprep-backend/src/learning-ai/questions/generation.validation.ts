import type { QuestionType } from '../../database/schema';
import { contentTerms } from '../../explanations/grounding';
import { gradeResponse, type AnswerKey, type StudentResponse } from '../../practice/grading';
import { validateQuestionShape, type QuestionShapeResult } from '../../questions/question-shape';
import { findAnswerLeaks, normalizeText } from '../leakage';
import type { RawGeneratedQuestion } from './generation.prompt';

/**
 * The gate a generated question passes before it may join the question bank. Pure.
 *
 * Every check is deterministic and runs against something the model does not control:
 *
 *   * **shape** — the question bank's own per-type rules (`validateQuestionShape`), so a generated
 *     question is exactly as well-formed as one an author saved;
 *   * **self-consistency** — the model's worked solution is graded against the key it wrote, by the
 *     grader that marks students. A question whose own solution disagrees with its key is wrong
 *     somewhere, and is discarded;
 *   * **answer leakage** — the stem and every hint are checked against the key;
 *   * **grounding** — it must cite notes that were really given, and its content must be supported by
 *     them (the explanation system's term measure and band);
 *   * **novelty** — it must not duplicate, or nearly duplicate, a question already in the sub-topic.
 */

export type GenerationCheck =
  | 'type_match'
  | 'shape'
  | 'stem'
  | 'options_distinct'
  | 'expected_time'
  | 'solution_complete'
  | 'self_consistency'
  | 'answer_leak'
  | 'citations'
  | 'grounding'
  | 'duplicate';

export interface GenerationFailure {
  check: GenerationCheck;
  detail: string;
}

export interface GenerationSource {
  blockId: string;
  title: string | null;
  text: string;
}

export interface GenerationValidationInput {
  draft: RawGeneratedQuestion;
  requestedType: QuestionType;
  sources: readonly GenerationSource[];
  /** Stems already in the sub-topic, including ones generated earlier in the same request. */
  existingStems: readonly string[];
  /** The grounding band a generated question must reach (the explanation system's mostly-notes floor). */
  minGrounding: number;
}

export interface GenerationValidation {
  ok: boolean;
  failures: GenerationFailure[];
  shape: QuestionShapeResult | null;
  answerKey: AnswerKey | null;
  fingerprint: string;
  groundingScore: number;
  usedBlockIds: string[];
  duplicateOf: { stem: string; similarity: number } | null;
}

export const EXPECTED_TIME = { min: 15, max: 900 } as const;
/** Two stems at or above this word-bigram Jaccard similarity are the same question. */
export const NEAR_DUPLICATE_SIMILARITY = 0.6;

export function validateGeneratedQuestion(input: GenerationValidationInput): GenerationValidation {
  const { draft } = input;
  const failures: GenerationFailure[] = [];
  const fingerprint = stemFingerprint(draft.stem);

  if (draft.type !== input.requestedType) failures.push({ check: 'type_match', detail: `asked for ${input.requestedType}, got ${draft.type}` });

  const stem = draft.stem.trim();
  if (stem.length < 15) failures.push({ check: 'stem', detail: 'the stem is too short to be a question' });

  const shapeOutcome = validateQuestionShape({
    type: input.requestedType,
    options: draft.options.map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })),
    numericAnswer: draft.numericAnswer
      ? { value: draft.numericAnswer.value, tolerance: draft.numericAnswer.tolerance, mode: draft.numericAnswer.mode }
      : null,
  });
  const shape = shapeOutcome.ok ? shapeOutcome.value : null;
  if (!shapeOutcome.ok) failures.push({ check: 'shape', detail: shapeOutcome.errors.map((e) => `${e.field}: ${e.message}`).join('; ') });

  const optionTexts = draft.options.map((o) => normalizeText(o.text));
  if (new Set(optionTexts).size !== optionTexts.length) failures.push({ check: 'options_distinct', detail: 'two options have the same text' });
  if (draft.options.some((o) => /\b(all|none)\s+of\s+the\s+above\b/i.test(o.text))) {
    failures.push({ check: 'options_distinct', detail: '"all/none of the above" options are not allowed' });
  }

  if (draft.expectedTimeSeconds < EXPECTED_TIME.min || draft.expectedTimeSeconds > EXPECTED_TIME.max) {
    failures.push({ check: 'expected_time', detail: `expected time must be ${EXPECTED_TIME.min}-${EXPECTED_TIME.max} seconds` });
  }

  if (draft.solution.steps.length < 2 || draft.solution.summary.trim().length < 20) {
    failures.push({ check: 'solution_complete', detail: 'the worked solution needs a summary and at least two steps' });
  }

  let answerKey: AnswerKey | null = null;
  if (shape) {
    answerKey = {
      type: input.requestedType,
      correctOptionKeys: shape.options.filter((o) => o.isCorrect).map((o) => o.optionKey),
      optionKeys: { single: shape.options.filter((o) => o.side === 'single').map((o) => o.optionKey), left: [], right: [] },
      correctNumeric: shape.correctNumeric,
      numericTolerance: shape.numericTolerance,
      toleranceMode: shape.toleranceMode,
      matrixAnswer: null,
    };
    // The model's own conclusion, marked by the student grader.
    if (draft.solution.finalAnswer === null) {
      failures.push({ check: 'self_consistency', detail: 'the solution states no final answer' });
    } else {
      const graded = gradeResponse(answerKey, draft.solution.finalAnswer as unknown as StudentResponse);
      if (!graded.ok) failures.push({ check: 'self_consistency', detail: `the solution's final answer is not a valid answer (${graded.message})` });
      else if (graded.outcome !== 'correct') failures.push({ check: 'self_consistency', detail: 'the worked solution arrives at an answer the key marks wrong' });
    }

    const leakAnswer = {
      type: input.requestedType,
      correctOptionKeys: answerKey.correctOptionKeys,
      options: draft.options.map((o) => ({ key: o.key, text: o.text })),
      correctNumeric: shape.correctNumeric,
      // Checked against an empty stem: the stem itself is what is being checked.
      stem: '',
    };
    const stemLeaks = findAnswerLeaks(stem, leakAnswer).filter((l) => l.rule !== 'option_text');
    const hintLeaks = draft.hints.flatMap((h) => findAnswerLeaks(h, { ...leakAnswer, stem }));
    for (const leak of [...stemLeaks, ...hintLeaks]) failures.push({ check: 'answer_leak', detail: leak.detail });
  }

  const known = new Map(input.sources.map((s) => [s.blockId, s]));
  const usedBlockIds = [...new Set(draft.sourceBlockIds.filter((id) => known.has(id)))];
  if (usedBlockIds.length === 0) failures.push({ check: 'citations', detail: 'the question cites none of the notes it was given' });
  if (draft.sourceBlockIds.some((id) => !known.has(id))) failures.push({ check: 'citations', detail: 'the question cites notes it was not given' });

  // Grounding: the question and its solution, measured against every note it was given.
  const sourceTerms = new Set<string>();
  for (const s of input.sources) for (const t of contentTerms(`${s.title ?? ''} ${s.text}`)) sourceTerms.add(t);
  const claimTerms = [...contentTerms([stem, ...draft.options.map((o) => o.text), draft.solution.summary, ...draft.solution.steps].join('\n'))];
  const groundingScore = claimTerms.length === 0 ? 0 : Math.round((claimTerms.filter((t) => sourceTerms.has(t)).length / claimTerms.length) * 1000) / 1000;
  if (groundingScore < input.minGrounding) {
    failures.push({ check: 'grounding', detail: `grounding ${groundingScore} is below ${input.minGrounding}: the question is not built on the notes` });
  }

  const duplicateOf = findNearDuplicate(stem, input.existingStems);
  if (duplicateOf) failures.push({ check: 'duplicate', detail: `too similar to an existing question (${duplicateOf.similarity})` });

  return { ok: failures.length === 0, failures, shape, answerKey, fingerprint, groundingScore, usedBlockIds, duplicateOf };
}

/** The normalised stem: exact duplicates share it. */
export function stemFingerprint(stem: string): string {
  return normalizeText(stem).slice(0, 2000);
}

function wordBigrams(stem: string): Set<string> {
  const words = normalizeText(stem).split(' ').filter((w) => w.length > 0);
  const out = new Set<string>();
  if (words.length === 1) out.add(words[0]!);
  for (let i = 0; i + 1 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** Jaccard similarity of word bigrams: 1 for the same wording, falling as the wording diverges. */
export function stemSimilarity(a: string, b: string): number {
  const x = wordBigrams(a);
  const y = wordBigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared += 1;
  return Math.round((shared / (x.size + y.size - shared)) * 1000) / 1000;
}

export function findNearDuplicate(stem: string, existing: readonly string[]): { stem: string; similarity: number } | null {
  const fingerprint = stemFingerprint(stem);
  let best: { stem: string; similarity: number } | null = null;
  for (const other of existing) {
    const similarity = stemFingerprint(other) === fingerprint ? 1 : stemSimilarity(stem, other);
    if (similarity >= NEAR_DUPLICATE_SIMILARITY && (!best || similarity > best.similarity)) best = { stem: other, similarity };
  }
  return best;
}
