import { sql } from 'drizzle-orm';
import { questionOptions, questions, type OptionSide, type QuestionType } from '../database/schema';

/**
 * THE ONLY SHAPE A STUDENT EVER SEES OF A QUESTION.
 *
 * Built from an explicit column allow-list, never `select()`: adding a column to the
 * questions table cannot leak it here. The answer key (`is_correct`, `correct_numeric`,
 * `numeric_tolerance`, `tolerance_mode`, `matrix_answer`), engine internals
 * (`difficulty_b`, `calibration_n`) and official solutions are absent by construction.
 * `test/unit/student-question-view.spec.ts` asserts the allow-lists;
 * `test/e2e/question-leakage.e2e-spec.ts` asserts the serialized payload for all seven
 * question types.
 *
 * Hint texts are deliberately not included: hints are revealed through the practice API so
 * that hint usage is recorded on the attempt. Students get the count only.
 */
export const STUDENT_QUESTION_COLUMNS = {
  id: questions.id,
  version: questions.version,
  type: questions.type,
  subtopicId: questions.primarySubtopicId,
  stem: questions.stem,
  stemJson: questions.stemJson,
  difficultyLabel: questions.difficultyLabel,
  expectedTimeSeconds: questions.expectedTimeSeconds,
} as const;

export const STUDENT_OPTION_COLUMNS = {
  key: questionOptions.optionKey,
  side: questionOptions.side,
  text: questionOptions.body,
} as const;

/** Columns that must never appear in a student projection (checked by the unit test). */
export const FORBIDDEN_QUESTION_COLUMNS = ['correct_numeric', 'numeric_tolerance', 'tolerance_mode', 'matrix_answer', 'difficulty_b', 'calibration_n', 'hints'] as const;
export const FORBIDDEN_OPTION_COLUMNS = ['is_correct'] as const;

/** cardinality(hints): how many hints exist, never their text. */
export const HINT_COUNT = sql<number>`cardinality(${questions.hints})`;

export interface StudentQuestionRow {
  id: string;
  version: number;
  type: QuestionType;
  subtopicId: string;
  stem: string;
  stemJson: Record<string, unknown> | null;
  difficultyLabel: number;
  expectedTimeSeconds: number;
  hintCount: number;
}

export interface StudentOptionRow {
  key: string;
  side: OptionSide;
  text: string;
}

export interface StudentQuestionView {
  id: string;
  version: number;
  type: QuestionType;
  subtopicId: string;
  stem: string;
  stemJson: Record<string, unknown> | null;
  difficultyLabel: number;
  expectedTimeSeconds: number;
  hintCount: number;
  options: { key: string; text: string }[];
  matrix?: { left: { key: string; text: string }[]; right: { key: string; text: string }[] };
}

export function toStudentQuestionView(q: StudentQuestionRow, options: StudentOptionRow[]): StudentQuestionView {
  const pick = (o: StudentOptionRow) => ({ key: o.key, text: o.text });
  const view: StudentQuestionView = {
    id: q.id,
    version: q.version,
    type: q.type,
    subtopicId: q.subtopicId,
    stem: q.stem,
    stemJson: q.stemJson,
    difficultyLabel: q.difficultyLabel,
    expectedTimeSeconds: q.expectedTimeSeconds,
    hintCount: q.hintCount,
    options: options.filter((o) => o.side === 'single').map(pick),
  };
  if (q.type === 'matrix_match') {
    view.matrix = {
      left: options.filter((o) => o.side === 'left').map(pick),
      right: options.filter((o) => o.side === 'right').map(pick),
    };
  }
  return view;
}
