import type { ErrorDetail } from '../common/errors/app-exception';
import type { MatrixAnswer, OptionSide, QuestionType, ToleranceMode } from '../database/schema';

/**
 * Per-type answer rules for the question bank, as pure functions (no Nest, no database).
 *
 * These mirror the CHECK constraints and the AP002 publish validator in migration 0004, so
 * a question is well formed the moment it is saved and publishing cannot fail on shape.
 * The database stays the backstop: if these ever disagree, the database wins and the API
 * answers 422 NOT_PUBLISHABLE.
 */

export const OPTION_KEY = /^[A-Za-z0-9]{1,4}$/;
/** Exact decimals stay strings all the way to the column: no float rounding of answer keys. */
export const DECIMAL = /^-?\d{1,15}(\.\d{1,10})?$/;
export const INTEGER = /^-?\d{1,15}$/;

export const SHAPE_LIMITS = {
  optionsMin: 2,
  optionsMax: 12,
  matrixSideMin: 2,
  matrixSideMax: 10,
  optionBodyMax: 5000,
} as const;

export const OPTION_TYPES: readonly QuestionType[] = ['single_correct', 'multi_correct', 'assertion_reason'];
export const NUMERIC_TYPES: readonly QuestionType[] = ['integer', 'numeric'];

export interface OptionInput {
  key: string;
  text: string;
  isCorrect?: boolean;
  side?: OptionSide;
}

export interface NumericAnswerInput {
  value: string;
  tolerance?: string;
  mode?: ToleranceMode;
}

export interface QuestionShapeInput {
  type: QuestionType;
  options?: OptionInput[] | null;
  numericAnswer?: NumericAnswerInput | null;
  matrixAnswer?: MatrixAnswer | null;
}

export interface ShapedOption {
  optionKey: string;
  side: OptionSide;
  body: string;
  isCorrect: boolean;
  sortOrder: number;
}

/** Exactly the answer-bearing columns the question bank writes. */
export interface QuestionShapeResult {
  options: ShapedOption[];
  correctNumeric: string | null;
  numericTolerance: string | null;
  toleranceMode: ToleranceMode | null;
  matrixAnswer: MatrixAnswer | null;
}

export type ShapeOutcome = { ok: true; value: QuestionShapeResult } | { ok: false; errors: ErrorDetail[] };

function checkOptionBodies(options: OptionInput[], errors: ErrorDetail[]): void {
  options.forEach((o, i) => {
    if (!OPTION_KEY.test(o.key)) errors.push({ field: `options[${i}].key`, message: 'key must be 1-4 letters or digits, e.g. A' });
    const text = o.text?.trim() ?? '';
    if (text.length === 0 || text.length > SHAPE_LIMITS.optionBodyMax) {
      errors.push({ field: `options[${i}].text`, message: `text must be 1-${SHAPE_LIMITS.optionBodyMax} characters` });
    }
  });
}

function duplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes];
}

export function validateQuestionShape(input: QuestionShapeInput): ShapeOutcome {
  const errors: ErrorDetail[] = [];
  const options = input.options ?? [];
  const numeric = input.numericAnswer ?? null;
  const matrix = input.matrixAnswer ?? null;
  const result: QuestionShapeResult = { options: [], correctNumeric: null, numericTolerance: null, toleranceMode: null, matrixAnswer: null };

  const wantsOptions = OPTION_TYPES.includes(input.type) || input.type === 'matrix_match';
  if (!wantsOptions && options.length > 0) errors.push({ field: 'options', message: `${input.type} questions must not have options` });
  if (!NUMERIC_TYPES.includes(input.type) && numeric) errors.push({ field: 'numericAnswer', message: `${input.type} questions must not have a numeric answer` });
  if (input.type !== 'matrix_match' && matrix) errors.push({ field: 'matrixAnswer', message: `${input.type} questions must not have a matrix answer` });

  if (OPTION_TYPES.includes(input.type)) {
    checkOptionBodies(options, errors);
    if (options.length < SHAPE_LIMITS.optionsMin || options.length > SHAPE_LIMITS.optionsMax) {
      errors.push({ field: 'options', message: `${input.type} needs ${SHAPE_LIMITS.optionsMin}-${SHAPE_LIMITS.optionsMax} options` });
    }
    if (options.some((o) => o.side && o.side !== 'single')) {
      errors.push({ field: 'options', message: 'left/right sides are only used by matrix_match questions' });
    }
    const dupes = duplicateKeys(options.map((o) => o.key));
    if (dupes.length) errors.push({ field: 'options', message: `duplicate option keys: ${dupes.join(', ')}` });

    const correct = options.filter((o) => o.isCorrect === true).length;
    if (input.type === 'multi_correct' ? correct < 1 : correct !== 1) {
      errors.push({
        field: 'options',
        message: input.type === 'multi_correct' ? 'mark at least one option correct' : 'mark exactly one option correct',
      });
    }
    result.options = options.map((o, i) => ({ optionKey: o.key, side: 'single', body: o.text.trim(), isCorrect: o.isCorrect === true, sortOrder: i }));
  }

  if (NUMERIC_TYPES.includes(input.type)) {
    if (!numeric) {
      errors.push({ field: 'numericAnswer', message: `${input.type} questions need a numeric answer` });
    } else if (input.type === 'integer') {
      if (!INTEGER.test(numeric.value ?? '')) errors.push({ field: 'numericAnswer.value', message: 'an integer answer must be a whole number' });
      if (numeric.tolerance !== undefined && numeric.tolerance !== '0') {
        errors.push({ field: 'numericAnswer.tolerance', message: 'integer answers are exact, so the tolerance must be 0' });
      }
      if (numeric.mode !== undefined && numeric.mode !== 'absolute') {
        errors.push({ field: 'numericAnswer.mode', message: 'integer answers use the absolute tolerance mode' });
      }
      result.correctNumeric = numeric.value;
      result.numericTolerance = '0';
      result.toleranceMode = 'absolute';
    } else {
      if (!DECIMAL.test(numeric.value ?? '')) errors.push({ field: 'numericAnswer.value', message: 'value must be a decimal number' });
      if (numeric.tolerance === undefined || !DECIMAL.test(numeric.tolerance) || numeric.tolerance.startsWith('-')) {
        errors.push({ field: 'numericAnswer.tolerance', message: 'tolerance must be a non-negative decimal (0 for an exact answer)' });
      }
      if (numeric.mode !== 'absolute' && numeric.mode !== 'relative') {
        errors.push({ field: 'numericAnswer.mode', message: "mode must be 'absolute' or 'relative'" });
      }
      result.correctNumeric = numeric.value;
      result.numericTolerance = numeric.tolerance ?? null;
      result.toleranceMode = numeric.mode ?? null;
    }
  }

  if (input.type === 'matrix_match') {
    checkOptionBodies(options, errors);
    const left = options.filter((o) => o.side === 'left');
    const right = options.filter((o) => o.side === 'right');
    if (left.length + right.length !== options.length) {
      errors.push({ field: 'options', message: "every matrix_match option needs side 'left' or 'right'" });
    }
    for (const [name, side] of [
      ['left', left],
      ['right', right],
    ] as const) {
      if (side.length < SHAPE_LIMITS.matrixSideMin || side.length > SHAPE_LIMITS.matrixSideMax) {
        errors.push({ field: 'options', message: `matrix_match needs ${SHAPE_LIMITS.matrixSideMin}-${SHAPE_LIMITS.matrixSideMax} ${name} items` });
      }
      const dupes = duplicateKeys(side.map((o) => o.key));
      if (dupes.length) errors.push({ field: 'options', message: `duplicate ${name} keys: ${dupes.join(', ')}` });
    }
    if (options.some((o) => o.isCorrect === true)) {
      errors.push({ field: 'options', message: 'matrix_match correctness lives in matrixAnswer, not on options' });
    }

    const leftKeys = new Set(left.map((o) => o.key));
    const rightKeys = new Set(right.map((o) => o.key));
    if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
      errors.push({ field: 'matrixAnswer', message: 'matrix_match questions need a matrixAnswer of left key → right keys' });
    } else {
      const answerKeys = Object.keys(matrix);
      for (const k of answerKeys) if (!leftKeys.has(k)) errors.push({ field: `matrixAnswer.${k}`, message: `${k} is not a left item` });
      for (const k of leftKeys) if (!answerKeys.includes(k)) errors.push({ field: 'matrixAnswer', message: `left item ${k} has no answer` });
      for (const [k, v] of Object.entries(matrix)) {
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
          errors.push({ field: `matrixAnswer.${k}`, message: 'each entry must be a non-empty array of right keys' });
          continue;
        }
        if (duplicateKeys(v).length) errors.push({ field: `matrixAnswer.${k}`, message: 'repeated right key' });
        for (const x of v) if (!rightKeys.has(x)) errors.push({ field: `matrixAnswer.${k}`, message: `${x} is not a right item` });
      }
      result.matrixAnswer = matrix;
    }
    result.options = options.map((o, i) => ({
      optionKey: o.key,
      side: o.side === 'right' ? 'right' : 'left',
      body: o.text.trim(),
      isCorrect: false,
      sortOrder: i,
    }));
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: result };
}
