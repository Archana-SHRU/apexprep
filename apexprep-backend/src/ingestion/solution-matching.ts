/**
 * Attaching solution blocks to the questions they solve.
 *
 * The rule the requirements set: **a solution is never attached to the wrong question silently.**
 * So every match carries a confidence and the evidence behind it, a match below the configured
 * floor becomes a review task instead of a link, and two solutions competing for one question is
 * itself a reason to ask a human.
 *
 * The evidence, in the order it is trusted:
 *
 *   1. **Printed numbering.** "Solution 7" against "Q7." is what the author intended, and it
 *      survives a solutions section printed fifty pages after the questions.
 *   2. **The stated answer agreeing.** A solution ending "Ans: C" matched to a question whose
 *      option C is correct is strong corroboration — and one that *disagrees* is strong evidence
 *      the match is wrong, which lowers the score rather than being ignored.
 *   3. **Proximity in reading order.** Textbooks put the solution under the question.
 *   4. **Term overlap.** The last resort, and never enough on its own.
 *
 * Pure: no database, no configuration, no clock. The caller supplies the floor.
 */

import { terms } from './mapping';

export interface QuestionCandidate {
  blockId: string;
  /** The draft question this block became, when it already has one. */
  questionId?: string | null;
  sourceNumber: string | null;
  sourcePage: number;
  sortOrder: number;
  stem: string;
  /** The option keys the question marks correct, for the corroboration check. */
  correctOptionKeys: readonly string[];
  /** The numeric answer, as a decimal string, for the same check. */
  correctNumeric?: string | null;
}

export interface SolutionCandidate {
  blockId: string;
  sourceNumber: string | null;
  sourcePage: number;
  sortOrder: number;
  text: string;
}

export interface SolutionMatch {
  solutionBlockId: string;
  questionBlockId: string | null;
  confidence: number;
  reason: string;
  /** True when the solution's own stated answer contradicts the question's key. */
  answerConflict: boolean;
  /** Other questions that matched nearly as well, for the reviewer. */
  alternatives: { questionBlockId: string; score: number }[];
}

/** How far apart in reading order two blocks can be before proximity stops meaning anything. */
const PROXIMITY_WINDOW = 6;

export function matchSolutions(
  solutions: readonly SolutionCandidate[],
  questions: readonly QuestionCandidate[],
): SolutionMatch[] {
  return solutions.map((solution) => matchOne(solution, questions));
}

function matchOne(solution: SolutionCandidate, questions: readonly QuestionCandidate[]): SolutionMatch {
  if (questions.length === 0) {
    return {
      solutionBlockId: solution.blockId,
      questionBlockId: null,
      confidence: 0,
      reason: 'no question block was extracted from this document to match against',
      answerConflict: false,
      alternatives: [],
    };
  }

  const statedAnswer = statedAnswerOf(solution.text);
  const scored = questions
    .map((question) => ({ question, ...score(solution, question, statedAnswer) }))
    .sort((a, b) => b.total - a.total || a.question.sortOrder - b.question.sortOrder);

  const best = scored[0]!;
  const runnerUp = scored[1];

  // A tie is not a match. Two questions the evidence cannot separate must go to a human, however
  // high the score, because picking one of them at random is exactly the silent mis-attachment
  // the requirements forbid.
  const tied = runnerUp !== undefined && best.total > 0 && runnerUp.total >= best.total * 0.9;
  const confidence = best.total === 0 ? 0 : tied ? round3(Math.min(best.total, 0.4)) : round3(best.total);

  return {
    solutionBlockId: solution.blockId,
    questionBlockId: best.total === 0 ? null : best.question.blockId,
    confidence,
    reason:
      best.total === 0
        ? 'no numbering, proximity or wording linked this solution to any question'
        : `${best.reasons.join('; ')}${tied ? `; but "${runnerUp.question.stem.slice(0, 40)}…" scores almost the same, so a human should confirm` : ''}`,
    answerConflict: best.conflict,
    alternatives: scored.slice(1, 4).filter((s) => s.total > 0).map((s) => ({ questionBlockId: s.question.blockId, score: round3(s.total) })),
  };
}

function score(
  solution: SolutionCandidate,
  question: QuestionCandidate,
  statedAnswer: { optionKey: string | null; numeric: string | null },
): { total: number; reasons: string[]; conflict: boolean } {
  const reasons: string[] = [];
  let total = 0;
  let conflict = false;

  if (solution.sourceNumber !== null && question.sourceNumber !== null) {
    if (solution.sourceNumber === question.sourceNumber) {
      total += 0.6;
      reasons.push(`the source numbers agree (${question.sourceNumber})`);
    } else {
      // Both numbered, and differently: that is positive evidence *against* this pair.
      return { total: 0, reasons: [`the source numbers differ (${solution.sourceNumber} vs ${question.sourceNumber})`], conflict: false };
    }
  }

  if (statedAnswer.optionKey && question.correctOptionKeys.length > 0) {
    if (question.correctOptionKeys.map((k) => k.toUpperCase()).includes(statedAnswer.optionKey)) {
      total += 0.25;
      reasons.push(`the solution states option ${statedAnswer.optionKey}, which this question marks correct`);
    } else {
      conflict = true;
      total -= 0.35;
      reasons.push(`the solution states option ${statedAnswer.optionKey}, but this question marks ${question.correctOptionKeys.join('/')} correct`);
    }
  }
  if (statedAnswer.numeric && question.correctNumeric) {
    if (Number(statedAnswer.numeric) === Number(question.correctNumeric)) {
      total += 0.25;
      reasons.push(`the stated value ${statedAnswer.numeric} matches the question's answer`);
    } else {
      conflict = true;
      total -= 0.35;
      reasons.push(`the stated value ${statedAnswer.numeric} differs from the question's answer ${question.correctNumeric}`);
    }
  }

  const distance = solution.sortOrder - question.sortOrder;
  if (distance > 0 && distance <= PROXIMITY_WINDOW) {
    const closeness = (PROXIMITY_WINDOW - distance + 1) / PROXIMITY_WINDOW;
    total += 0.3 * closeness;
    reasons.push(`it follows the question ${distance} block${distance === 1 ? '' : 's'} later`);
  } else if (distance > 0 && solution.sourcePage - question.sourcePage <= 1) {
    total += 0.05;
    reasons.push('it appears after the question on the same or the next page');
  }

  const overlap = jaccard(terms(solution.text), terms(question.stem));
  if (overlap > 0.1) {
    total += 0.2 * Math.min(1, overlap * 2);
    reasons.push(`${Math.round(overlap * 100)}% of their content terms overlap`);
  }

  return { total: round3(Math.max(0, Math.min(1, total))), reasons, conflict };
}

/**
 * The answer a solution block states, if it states one.
 *
 * Read more widely than the marker segmentation uses, and deliberately so. Segmentation needs a
 * narrow rule — a line that closes a question — because a loose one would cut blocks in the wrong
 * places. Here the job is the opposite: find the answer however the author phrased it, because this
 * is the check that catches a solution attached to the wrong question, and a check that only
 * understands one phrasing catches nothing the rest of the time.
 *
 * Each pattern requires either punctuation or the words "is"/"are" before the letter, so ordinary
 * prose — "answer a question" — is not read as option A.
 */
const STATED_OPTION = [
  /\b(?:answers?|ans)\b\s*[:=-]\s*\(?([A-Da-d])\)?(?![A-Za-z0-9])/i,
  /\b(?:answers?|ans)\b\s+(?:is|are)\s+\(?([A-Da-d])\)?(?![A-Za-z0-9])/i,
  /\b(?:answers?|ans)\b\s*[:=-]?\s*\(([A-Da-d])\)/i,
];
const STATED_NUMERIC = [
  /\b(?:answers?|ans)\b\s*[:=-]\s*(-?\d{1,15}(?:\.\d{1,10})?)/i,
  /\b(?:answers?|ans)\b\s+(?:is|are)\s+(-?\d{1,15}(?:\.\d{1,10})?)/i,
];

export function statedAnswerOf(text: string): { optionKey: string | null; numeric: string | null } {
  const first = (patterns: readonly RegExp[]): string | null => {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) return match[1]!;
    }
    return null;
  };
  const option = first(STATED_OPTION);
  return { optionKey: option ? option.toUpperCase() : null, numeric: first(STATED_NUMERIC) };
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
