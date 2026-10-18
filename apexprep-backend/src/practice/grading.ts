import type { MatrixAnswer, QuestionType, ToleranceMode } from '../database/schema';
import { parseDecimal, equalDecimals, withinTolerance } from './decimal';

/**
 * Server-side grading. The client sends only what the student chose or typed; correctness
 * is decided here, from the answer key, and nothing the client says about it is trusted.
 *
 * Partial credit is not awarded: S = 1 only for a fully correct response (DECISIONS.md
 * §B10). `attempts.score` is numeric, so switching partial credit on later is a scoring
 * change, not a schema change.
 *
 * Long-form answers cannot be graded automatically: they are stored with
 * `outcome = 'ungraded'` and move neither θ nor the question's difficulty.
 */

export type StudentResponse =
  | { optionKeys: string[] }
  | { value: string }
  | { matrix: Record<string, string[]> }
  | { text: string };

export interface AnswerKey {
  type: QuestionType;
  /** Option keys marked correct (option types only). */
  correctOptionKeys: string[];
  /** Every option key that exists, per side, for validating the response. */
  optionKeys: { single: string[]; left: string[]; right: string[] };
  correctNumeric: string | null;
  numericTolerance: string | null;
  toleranceMode: ToleranceMode | null;
  matrixAnswer: MatrixAnswer | null;
}

export type GradeResult =
  | { ok: true; score: number | null; outcome: 'correct' | 'incorrect' | 'partial' | 'ungraded'; stored: Record<string, unknown> }
  | { ok: false; field: string; message: string };

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

const graded = (correct: boolean, stored: Record<string, unknown>): GradeResult => ({
  ok: true,
  score: correct ? 1 : 0,
  outcome: correct ? 'correct' : 'incorrect',
  stored,
});

const invalid = (field: string, message: string): GradeResult => ({ ok: false, field, message });

const OPTION_TYPES: readonly QuestionType[] = ['single_correct', 'multi_correct', 'assertion_reason'];

export function gradeResponse(key: AnswerKey, response: StudentResponse): GradeResult {
  // ---- option types -------------------------------------------------------
  if (OPTION_TYPES.includes(key.type)) {
    if (!('optionKeys' in response)) return invalid('response.optionKeys', `a ${key.type} answer is a list of option keys`);
    // Checked as a shape, not merely as a present key: `{"optionKeys":{"length":3}}` satisfies
    // `'optionKeys' in response` and then throws inside `new Set(...)`. A malformed answer is the
    // student's mistake and deserves a 400 naming the field, not a 500 with a stack trace.
    const chosen = response.optionKeys;
    if (!Array.isArray(chosen) || chosen.some((k) => typeof k !== 'string')) {
      return invalid('response.optionKeys', 'optionKeys must be a list of option keys, e.g. ["A"]');
    }
    if (chosen.length === 0) return invalid('response.optionKeys', 'choose at least one option');
    if (new Set(chosen).size !== chosen.length) return invalid('response.optionKeys', 'an option was chosen twice');
    const unknown = chosen.filter((k) => !key.optionKeys.single.includes(k));
    if (unknown.length > 0) return invalid('response.optionKeys', `unknown option: ${unknown.join(', ')}`);
    if (key.type !== 'multi_correct' && chosen.length !== 1) return invalid('response.optionKeys', 'choose exactly one option');
    return graded(sameSet(chosen, key.correctOptionKeys), { option_keys: [...chosen].sort() });
  }

  // ---- numeric types ------------------------------------------------------
  if (key.type === 'integer' || key.type === 'numeric') {
    if (!('value' in response)) return invalid('response.value', `a ${key.type} answer is a number`);
    // A JSON number reaches here as a number, and `parseDecimal` expects a string to trim.
    if (typeof response.value !== 'string') return invalid('response.value', 'value must be sent as a string, e.g. "9.81"');
    const given = parseDecimal(response.value);
    if (!given) return invalid('response.value', 'value must be a decimal number');
    const correct = key.correctNumeric ? parseDecimal(key.correctNumeric) : null;
    const tolerance = key.numericTolerance ? parseDecimal(key.numericTolerance) : null;
    if (!correct || !tolerance || !key.toleranceMode) return invalid('response.value', 'this question has no usable answer key');
    const isCorrect =
      key.type === 'integer' ? equalDecimals(given, correct) : withinTolerance(given, correct, tolerance, key.toleranceMode);
    return graded(isCorrect, { value: response.value.trim() });
  }

  // ---- matrix match -------------------------------------------------------
  if (key.type === 'matrix_match') {
    if (!('matrix' in response)) return invalid('response.matrix', 'a matrix_match answer maps each left item to right items');
    const given = response.matrix;
    if (!given || typeof given !== 'object' || Array.isArray(given)) return invalid('response.matrix', 'matrix must be an object');
    for (const [left, rights] of Object.entries(given)) {
      if (!key.optionKeys.left.includes(left)) return invalid(`response.matrix.${left}`, 'unknown left item');
      if (!Array.isArray(rights) || rights.some((r) => typeof r !== 'string')) {
        return invalid(`response.matrix.${left}`, 'each entry must be a list of right keys');
      }
      const unknown = rights.filter((r) => !key.optionKeys.right.includes(r));
      if (unknown.length > 0) return invalid(`response.matrix.${left}`, `unknown right item: ${unknown.join(', ')}`);
      if (new Set(rights).size !== rights.length) return invalid(`response.matrix.${left}`, 'a right item was chosen twice');
    }
    const answer = key.matrixAnswer ?? {};
    const leftKeys = Object.keys(answer);
    const matches =
      sameSet(Object.keys(given), leftKeys) && leftKeys.every((k) => sameSet(given[k] ?? [], answer[k] ?? []));
    const stored = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, [...v].sort()]));
    return graded(matches, { matrix: stored });
  }

  // ---- long form ----------------------------------------------------------
  if (!('text' in response)) return invalid('response.text', 'a long_form answer is text');
  if (typeof response.text !== 'string') return invalid('response.text', 'text must be a string');
  const text = response.text.trim();
  if (text.length === 0) return invalid('response.text', 'write an answer before submitting');
  return { ok: true, score: null, outcome: 'ungraded', stored: { text } };
}

/** What the student is shown once the attempt is recorded — never before. */
export function revealedAnswer(key: AnswerKey): Record<string, unknown> {
  if (OPTION_TYPES.includes(key.type)) return { optionKeys: [...key.correctOptionKeys].sort() };
  if (key.type === 'integer' || key.type === 'numeric') {
    return { value: key.correctNumeric, tolerance: key.numericTolerance, mode: key.toleranceMode };
  }
  if (key.type === 'matrix_match') return { matrix: key.matrixAnswer ?? {} };
  return {};
}
