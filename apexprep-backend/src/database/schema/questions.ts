import { boolean, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * Mirror of migration 0004 (question bank).
 *
 * ANSWER COLUMNS: questions.correctNumeric, numericTolerance, toleranceMode, matrixAnswer,
 * questionOptions.isCorrect and everything in officialSolutions. Student-facing code must
 * select from STUDENT_QUESTION_COLUMNS / STUDENT_OPTION_COLUMNS in
 * src/questions/student-question.view.ts, never `select()` on these tables.
 *
 * Exact decimals (answer value, tolerance) stay strings so no precision is lost;
 * difficulty_b is numeric(8,2) and safe as a JS number.
 */

export const QUESTION_TYPES = [
  'single_correct',
  'multi_correct',
  'integer',
  'numeric',
  'matrix_match',
  'assertion_reason',
  'long_form',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_STATUSES = ['draft', 'in_review', 'published', 'retired', 'rejected'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const TOLERANCE_MODES = ['absolute', 'relative'] as const;
export type ToleranceMode = (typeof TOLERANCE_MODES)[number];

export const OPTION_SIDES = ['single', 'left', 'right'] as const;
export type OptionSide = (typeof OPTION_SIDES)[number];

/** {"A": ["q"], "B": ["p", "s"]}: left key → right keys. */
export type MatrixAnswer = Record<string, string[]>;

export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  primarySubtopicId: uuid('primary_subtopic_id').notNull(),
  type: text('type', { enum: QUESTION_TYPES }).notNull(),
  stem: text('stem').notNull(),
  stemJson: jsonb('stem_json').$type<Record<string, unknown>>(),
  correctNumeric: numeric('correct_numeric'),
  numericTolerance: numeric('numeric_tolerance'),
  toleranceMode: text('tolerance_mode', { enum: TOLERANCE_MODES }),
  matrixAnswer: jsonb('matrix_answer').$type<MatrixAnswer>(),
  difficultyLabel: smallint('difficulty_label').notNull(),
  difficultyB: numeric('difficulty_b', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  calibrationN: integer('calibration_n').notNull().default(0),
  expectedTimeSeconds: integer('expected_time_seconds').notNull(),
  hints: text('hints').array().notNull().default([]),
  sourceAssetId: uuid('source_asset_id'),
  sourcePage: integer('source_page'),
  sourceBlockId: uuid('source_block_id'),
  duplicateGroupId: uuid('duplicate_group_id'),
  status: text('status', { enum: QUESTION_STATUSES }).notNull().default('draft'),
  version: integer('version').notNull().default(1),
  publishedAt: tstz('published_at'),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export const questionOptions = pgTable('question_options', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  questionId: uuid('question_id').notNull(),
  optionKey: text('option_key').notNull(),
  side: text('side', { enum: OPTION_SIDES }).notNull().default('single'),
  body: text('body').notNull(),
  bodyJson: jsonb('body_json').$type<Record<string, unknown>>(),
  isCorrect: boolean('is_correct').notNull().default(false),
  sortOrder: smallint('sort_order').notNull().default(0),
  ...timestamps,
});

export const questionSecondarySubtopics = pgTable(
  'question_secondary_subtopics',
  {
    tenantId: uuid('tenant_id').notNull(),
    questionId: uuid('question_id').notNull(),
    subtopicId: uuid('subtopic_id').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.questionId, t.subtopicId] })],
);

export const officialSolutions = pgTable('official_solutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  questionId: uuid('question_id').notNull(),
  body: text('body').notNull(),
  bodyJson: jsonb('body_json').$type<Record<string, unknown>>(),
  finalAnswerText: text('final_answer_text'),
  sourceAssetId: uuid('source_asset_id'),
  sourcePage: integer('source_page'),
  sourceBlockId: uuid('source_block_id'),
  status: text('status', { enum: ['draft', 'approved', 'rejected'] }).notNull().default('draft'),
  approvedBy: uuid('approved_by'),
  approvedAt: tstz('approved_at'),
  createdBy: uuid('created_by'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export type QuestionRow = typeof questions.$inferSelect;
export type QuestionOptionRow = typeof questionOptions.$inferSelect;
export type OfficialSolutionRow = typeof officialSolutions.$inferSelect;
