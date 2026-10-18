import type { QuestionType } from '../database/schema';
import { validateQuestionShape } from '../questions/question-shape';
import { MARKERS } from './segmentation';

/**
 * Turning a question block's text into the fields a draft question needs.
 *
 * It does not decide whether the question is *valid* — `validateQuestionShape` from Phase 3 does
 * that, the same function the admin authoring API uses. There is one shape validator and one
 * grading model in this codebase, and the requirements are explicit that ingestion must not add a
 * second. What this module does is read the printed conventions: the stem, the option labels, the
 * answer line, and the difficulty the source may have stated.
 *
 * Anything it cannot read with confidence comes back as a `gap`, and a block with gaps becomes a
 * review task rather than a published question. Pure: no database, no configuration.
 */

export interface ExtractedOption {
  key: string;
  text: string;
  isCorrect: boolean;
}

/**
 * Where a question's answer key came from. The distinction is what lets a person see which answers rest on the
 * document and which rest on a model.
 *
 *   * `source` — printed in the question's own text ("Answer: B").
 *   * `solution` — stated by the solution block matched to it ("Answer: B"), applied only for a confirmed match.
 *   * `ai_unverified` — a model marked it, and the document does not state it. Not publishable until a person
 *     has looked: a model's confidence is not evidence that its answer is right.
 *   * `reviewer` — a person set or corrected it.
 */
export type AnswerSource = 'source' | 'solution' | 'ai_unverified' | 'reviewer';

/** A figure the reviewer should see: an estimate or a model's guess, kept apart from the values that count. */
export interface SuggestedValues {
  /** Who proposed it. Neither is evidence; both are shown to the reviewer to accept, change or ignore. */
  by: 'ai' | 'estimate';
  difficultyLabel?: number;
  expectedTimeSeconds?: number;
  note?: string;
}

export interface ExtractedQuestion {
  type: QuestionType;
  stem: string;
  options: ExtractedOption[];
  /** For integer and numeric types, as a decimal string so no precision is lost. */
  numericAnswer: { value: string; tolerance?: string; mode?: 'absolute' | 'relative' } | null;
  /** The question number the source printed, for solution matching. */
  sourceNumber: string | null;
  /** A difficulty word or level the source printed, kept verbatim as source metadata. */
  sourceDifficulty: string | null;
  /**
   * The L1-L5 label this question will be created with: mapped from `sourceDifficulty` when the
   * source was explicit, otherwise null until a reviewer sets it. Never invented — a question
   * with no difficulty fails the publication gate rather than being guessed a level.
   */
  difficultyLabel: number | null;
  /**
   * Seconds the question is expected to take, which `questions.expected_time_seconds` requires.
   * Null until a reviewer sets it: nothing in a printed question states it.
   */
  expectedTimeSeconds: number | null;
  /** 0-1: how much of the question was read cleanly. */
  confidence: number;
  /** What could not be read. A non-empty list means this cannot be published unreviewed. */
  gaps: string[];
  /** Where the answer key came from; null when the question has none yet. Absent on questions read before this existed. */
  answerSource?: AnswerSource | null;
  /** Where the confirmed difficulty came from: the document, or a person. Null while it is unset. */
  difficultySource?: 'source' | 'reviewer' | null;
  /** Where the confirmed expected time came from. There is no source for it in a printed question: only a person. */
  expectedTimeSource?: 'reviewer' | null;
  /** What a model or an estimate proposes for the two values above. Never counted until a person accepts it. */
  suggested?: SuggestedValues | null;
  /** A reviewer has said the question may publish without the figure it refers to. */
  diagramAcknowledged?: boolean;
  /** A person has changed this question since it was read. */
  editedByReviewer?: boolean;
  /** Whether Phase 3's own validator accepts the shape as it stands. */
  shapeValid: boolean;
  shapeErrors: string[];
}

/** Difficulty words textbooks print. Mapped to L1-L5 only where the source is explicit. */
const DIFFICULTY_WORDS: Record<string, number> = {
  easy: 1,
  elementary: 1,
  basic: 1,
  moderate: 3,
  medium: 3,
  average: 3,
  hard: 4,
  difficult: 4,
  advanced: 4,
  challenging: 5,
  olympiad: 5,
  expert: 5,
};
// The separator is required. Without it "…with no stated difficulty at all" reads "at" as the
// stated difficulty, which is an invented value — the one thing this module must never produce.
// "Level 3" is allowed without one, because that form is unambiguous.
const DIFFICULTY_LINE = /\b(?:difficulty|level)\s*[:=]\s*(?:L\s*([1-5])\b|([A-Za-z]+))|\blevel\s+L?\s*([1-5])\b/i;
const NUMERIC_ANSWER = /\b(?:answer|ans)\s*[:=]\s*(-?\d{1,15}(?:\.\d{1,10})?)/i;
const TOLERANCE = /\b(?:tolerance|within|±|\+\/-)\s*(\d{1,15}(?:\.\d{1,10})?)/i;

export function extractQuestion(text: string): ExtractedQuestion {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const gaps: string[] = [];

  const sourceNumber = firstNumber(lines[0] ?? '');
  // The numbered stem itself looks like option 1 — "1." satisfies both patterns — so the option
  // block starts at the first option line that is *not* the stem. Without this the stem becomes an
  // option and the question is left with no stem at all.
  const optionIndex = lines.findIndex((l, i) => MARKERS.OPTION_LINE.test(l) && !(i === 0 && MARKERS.QUESTION_NUMBER.test(l)));
  const answerLine = lines.find((l) => MARKERS.ANSWER_INLINE.test(l) || NUMERIC_ANSWER.test(l)) ?? null;

  const stemLines = lines.slice(0, optionIndex === -1 ? lines.length : optionIndex).filter((l) => l !== answerLine);
  const stem = stripNumber(stemLines.join(' ')).trim();
  if (stem.length < 10) gaps.push('the stem is too short to be a question');

  const options = optionIndex === -1 ? [] : readOptions(lines.slice(optionIndex));
  const correctKeys = answerKeys(answerLine, options);
  const numeric = readNumericAnswer(answerLine);

  // The answer key has to be applied *before* the type is chosen: the difference between
  // single_correct and multi_correct is how many options are marked correct, so typing the
  // question from options that are all still `isCorrect: false` can only ever say single_correct.
  const withCorrect = options.map((o) => ({ ...o, isCorrect: correctKeys.includes(o.key.toUpperCase()) }));
  const type = chooseType(withCorrect, numeric, text);

  if (type === 'single_correct' || type === 'multi_correct' || type === 'assertion_reason') {
    if (options.length < 2) gaps.push('fewer than two options were found');
    if (correctKeys.length === 0) gaps.push('no answer line identified the correct option');
  }
  if ((type === 'integer' || type === 'numeric') && numeric === null) gaps.push('no numeric answer was found');

  // Phase 3's validator is the authority on shape. It is consulted here so a block that cannot
  // become a valid question is known to be unpublishable *before* anyone reviews it.
  const shape = validateQuestionShape({
    type,
    options: withCorrect.length > 0 ? (withCorrect) : undefined,
    numericAnswer: numeric ?? undefined,
  });

  const confidence = scoreConfidence({ stem, options: withCorrect, correctKeys, numeric, gaps, type });
  return {
    type,
    stem,
    options: withCorrect,
    numericAnswer: numeric,
    sourceNumber,
    sourceDifficulty: readSourceDifficulty(text),
    difficultyLabel: sourceDifficultyToLabel(readSourceDifficulty(text)),
    expectedTimeSeconds: null,
    confidence,
    gaps,
    answerSource: correctKeys.length > 0 || numeric ? 'source' : null,
    difficultySource: sourceDifficultyToLabel(readSourceDifficulty(text)) === null ? null : 'source',
    expectedTimeSource: null,
    suggested: null,
    shapeValid: shape.ok,
    shapeErrors: shape.ok ? [] : shape.errors.map((e) => `${e.field ?? 'question'}: ${e.message}`),
  };
}

/**
 * Re-reads what is wrong with a question *as it stands now*, after a person edited it or a solution supplied its
 * answer. The gaps the extractor wrote describe the text as first read; leaving them in place after the cause is
 * fixed would keep telling the reviewer about a problem that no longer exists.
 */
export function reassess(question: ExtractedQuestion): ExtractedQuestion {
  const gaps: string[] = [];
  if (question.stem.trim().length < 10) gaps.push('the stem is too short to be a question');
  const optionType = question.type === 'single_correct' || question.type === 'multi_correct' || question.type === 'assertion_reason';
  if (optionType) {
    if (question.options.length < 2) gaps.push('fewer than two options were found');
    if (!question.options.some((o) => o.isCorrect)) gaps.push('no answer line identified the correct option');
  }
  if ((question.type === 'integer' || question.type === 'numeric') && question.numericAnswer === null) gaps.push('no numeric answer was found');
  if (question.answerSource === 'ai_unverified') gaps.push('the answer was proposed by a model and the document does not state it: verify it');
  const shape = validateQuestionShape({
    type: question.type,
    options: question.options.length > 0 ? question.options : undefined,
    numericAnswer: question.numericAnswer ?? undefined,
  });
  return { ...question, gaps, shapeValid: shape.ok, shapeErrors: shape.ok ? [] : shape.errors.map((e) => `${e.field ?? 'question'}: ${e.message}`) };
}

/**
 * The question's type, from what was actually printed.
 *
 * Note what is *not* inferred: `matrix_match` and `long_form` need structure a plain text layer
 * rarely carries unambiguously, so a block that looks like either is typed as the closest
 * supported thing and its gaps send it to a human. Guessing `matrix_match` wrongly would produce
 * a question no student could answer.
 */
function chooseType(options: readonly ExtractedOption[], numeric: ExtractedQuestion['numericAnswer'], text: string): QuestionType {
  if (/\bassertion\b[\s\S]*\breason\b/i.test(text) && options.length >= 2) return 'assertion_reason';
  if (options.length >= 2) {
    const correct = options.filter((o) => o.isCorrect).length;
    return correct > 1 ? 'multi_correct' : 'single_correct';
  }
  if (numeric) return isInteger(numeric.value) ? 'integer' : 'numeric';
  if (/\b(?:prove|derive|show that|explain why|discuss)\b/i.test(text)) return 'long_form';
  return 'long_form';
}

function readOptions(lines: readonly string[]): ExtractedOption[] {
  const out: ExtractedOption[] = [];
  for (const line of lines) {
    const match = MARKERS.OPTION_LINE.exec(line);
    if (!match) {
      // A continuation of the previous option's text.
      if (out.length > 0 && !MARKERS.ANSWER_INLINE.test(line) && !MARKERS.SOLUTION_MARKER.test(line)) {
        out[out.length - 1]!.text = `${out[out.length - 1]!.text} ${line}`.trim();
      }
      continue;
    }
    const key = match[1]!.toUpperCase();
    if (out.some((o) => o.key === key)) continue; // a repeated label is not a new option
    out.push({ key, text: line.slice(match[0].length - 1).replace(/^[\s.)\]]+/, '').trim(), isCorrect: false });
  }
  return out.filter((o) => o.text.length > 0);
}

/** The option keys an answer line names. `Answer: A and C` and `Ans: (B)` both read. */
function answerKeys(answerLine: string | null, options: readonly ExtractedOption[]): string[] {
  if (!answerLine) return [];
  const after = answerLine.replace(/^.*?\b(?:answer|ans)\s*[:=]\s*/i, '');
  const keys = [...after.matchAll(/\(?\b([A-Da-d1-4])\b\)?/g)].map((m) => m[1]!.toUpperCase());
  const known = new Set(options.map((o) => o.key.toUpperCase()));
  return [...new Set(keys.filter((k) => known.has(k)))];
}

function readNumericAnswer(answerLine: string | null): ExtractedQuestion['numericAnswer'] {
  if (!answerLine) return null;
  const value = NUMERIC_ANSWER.exec(answerLine);
  if (!value) return null;
  const tolerance = TOLERANCE.exec(answerLine);
  const exact = isInteger(value[1]!);
  return {
    value: value[1]!,
    // An integer question is exact by definition (questions_integer_exact); a decimal answer with
    // no stated tolerance gets none here, and the shape validator will ask for one.
    tolerance: tolerance ? tolerance[1]! : exact ? '0' : undefined,
    mode: tolerance || exact ? 'absolute' : undefined,
  };
}

/** A difficulty the source printed, verbatim plus the L1-L5 it maps to. Never invented. */
export function readSourceDifficulty(text: string): string | null {
  const match = DIFFICULTY_LINE.exec(text);
  if (!match) return null;
  const level = match[1] ?? match[3];
  return level ? `L${level}` : match[2]!.trim();
}

/**
 * The L1-L5 label a printed difficulty corresponds to, or null when the source said nothing this
 * module can map. Returning null is what makes the pipeline fall back to the engine
 * configuration rather than inventing a level.
 */
export function sourceDifficultyToLabel(source: string | null): number | null {
  if (!source) return null;
  const level = /^L\s*([1-5])$/i.exec(source.trim());
  if (level) return Number(level[1]);
  return DIFFICULTY_WORDS[source.trim().toLowerCase()] ?? null;
}

function scoreConfidence(input: {
  stem: string;
  options: readonly ExtractedOption[];
  correctKeys: readonly string[];
  numeric: ExtractedQuestion['numericAnswer'];
  gaps: readonly string[];
  type: QuestionType;
}): number {
  if (input.gaps.length > 0) return round3(Math.max(0.1, 0.5 - 0.15 * input.gaps.length));
  let score = 0.6;
  if (input.stem.length >= 30) score += 0.1;
  if (input.options.length >= 4) score += 0.15;
  else if (input.options.length >= 2) score += 0.05;
  if (input.correctKeys.length > 0 || input.numeric) score += 0.15;
  // long_form is the residual type, so it never scores as well as one the markers confirmed.
  if (input.type === 'long_form') score -= 0.25;
  return round3(Math.min(1, Math.max(0, score)));
}

function firstNumber(line: string): string | null {
  const match = MARKERS.QUESTION_NUMBER.exec(line);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function stripNumber(text: string): string {
  return text.replace(MARKERS.QUESTION_NUMBER, '');
}

function isInteger(value: string): boolean {
  return /^-?\d+$/.test(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** How cleanly a proposal reads as it stands now, on the scale `confidence` uses. */
export function scoreProposal(question: ExtractedQuestion): number {
  return scoreConfidence({
    stem: question.stem,
    options: question.options,
    correctKeys: question.options.filter((o) => o.isCorrect).map((o) => o.key),
    numeric: question.numericAnswer,
    gaps: question.gaps,
    type: question.type,
  });
}

/**
 * Takes the answer from the solution matched to this question, when the question has none of its own.
 *
 * This is the textbook layout that otherwise strands a question: the problems on one page and "Answers: 1-B, 2-D…" or
 * a worked solution ending "Answer: C" fifty pages on. The answer is read from the document, so it is not a
 * guess — but it is only as good as the match that found it, so the proposal's confidence is held to the match's.
 *
 * Returns null — change nothing — when the question already has an answer (a printed one, or a reviewer's, which
 * must never be overwritten), when the solution states none that fits the question, or for a type whose answer a
 * solution's last line cannot settle (long-form).
 */
export function applySolutionAnswer(
  question: ExtractedQuestion,
  stated: { optionKey: string | null; numeric: string | null },
  matchConfidence: number,
): ExtractedQuestion | null {
  if (question.options.some((o) => o.isCorrect) || question.numericAnswer !== null) return null;

  let updated: ExtractedQuestion | null = null;
  if (question.type === 'single_correct' || question.type === 'assertion_reason') {
    const key = stated.optionKey?.toUpperCase();
    if (!key || !question.options.some((o) => o.key.toUpperCase() === key)) return null;
    updated = { ...question, options: question.options.map((o) => ({ ...o, isCorrect: o.key.toUpperCase() === key })) };
  } else if (question.type === 'integer' || question.type === 'numeric') {
    if (!stated.numeric) return null;
    const exact = isInteger(stated.numeric);
    updated = { ...question, numericAnswer: { value: stated.numeric, tolerance: exact ? '0' : undefined, mode: exact ? 'absolute' : undefined } };
  }
  if (!updated) return null;

  const reassessed = reassess({ ...updated, answerSource: 'solution' });
  return { ...reassessed, confidence: round3(Math.min(scoreProposal(reassessed), matchConfidence)) };
}
