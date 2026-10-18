import { gradeResponse, type AnswerKey, type StudentResponse } from '../practice/grading';

/**
 * Grading a finished mock-test paper. Pure: the caller loads the facts, this applies the marking scheme.
 *
 * The scheme is the one the product has always used and is deliberately unchanged:
 *   * a fully correct response earns the item's `positiveMarks`;
 *   * a wrong, gradable response costs its `negativeMarks`;
 *   * a blank response, a response that cannot be graded (long-form, malformed) or an item with no
 *     answer key counts as unattempted and is worth 0;
 *   * the paper's **total** is floored at 0 — `rawScore` carries the figure before the floor so the
 *     floor is visible rather than silent. Per-item scores are never floored.
 */

export interface GradableItem {
  testItemId: string;
  questionId: string;
  positiveMarks: number;
  negativeMarks: number;
  /** The saved response, exactly as stored. Anything that is not a plain object counts as blank. */
  response: unknown;
}

export interface GradedItem {
  testItemId: string;
  isCorrect: boolean;
  score: number;
  outcome: 'correct' | 'incorrect' | 'unattempted' | 'partial' | 'ungraded';
}

export interface GradedPaper {
  items: GradedItem[];
  rawScore: number;
  /** `rawScore` floored at 0. */
  totalScore: number;
  maxScore: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  /** Percentage of attempted questions answered correctly, two decimals. */
  accuracy: number;
}

export function isBlankResponse(response: unknown): boolean {
  if (response === null || response === undefined || typeof response !== 'object' || Array.isArray(response)) return true;
  const r = response as Record<string, unknown>;
  if ('optionKeys' in r) return !Array.isArray(r.optionKeys) || r.optionKeys.length === 0;
  if ('value' in r) return typeof r.value !== 'string' || r.value.trim() === '';
  if ('matrix' in r) return r.matrix === null || typeof r.matrix !== 'object' || Object.keys(r.matrix as object).length === 0;
  if ('text' in r) return typeof r.text !== 'string' || r.text.trim() === '';
  return true;
}

export function gradePaper(items: readonly GradableItem[], keys: ReadonlyMap<string, AnswerKey>): GradedPaper {
  const graded: GradedItem[] = [];
  let rawScore = 0;
  let maxScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unattemptedCount = 0;

  for (const item of items) {
    maxScore += item.positiveMarks;
    const key = keys.get(item.questionId);

    if (!key || isBlankResponse(item.response)) {
      unattemptedCount += 1;
      graded.push({ testItemId: item.testItemId, isCorrect: false, score: 0, outcome: 'unattempted' });
      continue;
    }

    const result = gradeResponse(key, item.response as StudentResponse);
    if (result.ok && result.outcome === 'correct') {
      correctCount += 1;
      rawScore += item.positiveMarks;
      graded.push({ testItemId: item.testItemId, isCorrect: true, score: item.positiveMarks, outcome: 'correct' });
    } else if (result.ok && result.outcome === 'incorrect') {
      incorrectCount += 1;
      rawScore -= item.negativeMarks;
      graded.push({ testItemId: item.testItemId, isCorrect: false, score: -item.negativeMarks, outcome: 'incorrect' });
    } else {
      // Ungraded (long-form) or malformed: not scored either way, and not counted as an attempt.
      unattemptedCount += 1;
      graded.push({ testItemId: item.testItemId, isCorrect: false, score: 0, outcome: result.ok ? result.outcome : 'unattempted' });
    }
  }

  const attempted = correctCount + incorrectCount;
  return {
    items: graded,
    rawScore,
    totalScore: Math.max(0, rawScore),
    maxScore,
    correctCount,
    incorrectCount,
    unattemptedCount,
    accuracy: attempted > 0 ? Number(((correctCount / attempted) * 100).toFixed(2)) : 0,
  };
}
