import { boolean, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

export const TEST_KINDS = ['full_length', 'sectional'] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const TEST_STATUSES = ['draft', 'published', 'archived'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const TEST_SESSION_STATUSES = ['in_progress', 'completed', 'abandoned', 'timed_out'] as const;
export type TestSessionStatus = (typeof TEST_SESSION_STATUSES)[number];

export const TEST_ITEM_STATUSES = [
  'not_visited',
  'not_answered',
  'answered',
  'marked_for_review',
  'answered_and_marked',
] as const;
export type TestItemStatus = (typeof TEST_ITEM_STATUSES)[number];

export const mockTests = pgTable('mock_tests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  trackId: uuid('track_id'),
  title: text('title').notNull(),
  description: text('description'),
  kind: text('kind', { enum: TEST_KINDS }).notNull().default('full_length'),
  durationMinutes: integer('duration_minutes').notNull().default(180),
  totalMarks: integer('total_marks').notNull().default(300),
  defaultPositiveMarks: numeric('default_positive_marks', { precision: 5, scale: 2 }).notNull().default('4.00'),
  defaultNegativeMarks: numeric('default_negative_marks', { precision: 5, scale: 2 }).notNull().default('1.00'),
  status: text('status', { enum: TEST_STATUSES }).notNull().default('published'),
  instructions: text('instructions'),
  ...timestamps,
});

export const testSections = pgTable('test_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  testId: uuid('test_id').notNull(),
  name: text('name').notNull(),
  subjectId: uuid('subject_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  durationMinutes: integer('duration_minutes'),
  instructions: text('instructions'),
  ...timestamps,
});

export const testItems = pgTable('test_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  testId: uuid('test_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  questionId: uuid('question_id').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  positiveMarks: numeric('positive_marks', { precision: 5, scale: 2 }).notNull().default('4.00'),
  negativeMarks: numeric('negative_marks', { precision: 5, scale: 2 }).notNull().default('1.00'),
  ...timestamps,
});

export const testSessions = pgTable('test_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  testId: uuid('test_id').notNull(),
  status: text('status', { enum: TEST_SESSION_STATUSES }).notNull().default('in_progress'),
  startedAt: tstz('started_at').notNull().defaultNow(),
  endsAt: tstz('ends_at').notNull(),
  submittedAt: tstz('submitted_at'),
  totalScore: numeric('total_score', { precision: 8, scale: 2 }).default('0.00'),
  maxScore: integer('max_score').default(0),
  correctCount: integer('correct_count').default(0),
  incorrectCount: integer('incorrect_count').default(0),
  unattemptedCount: integer('unattempted_count').default(0),
  accuracy: numeric('accuracy', { precision: 5, scale: 2 }).default('0.00'),
  timeSpentSec: integer('time_spent_sec').default(0),
  /** The question the student has open right now, and since when (server clock). Null when none is. */
  activeItemId: uuid('active_item_id'),
  activeSince: tstz('active_since'),
  ...timestamps,
});

export const testItemResponses = pgTable('test_item_responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  testSessionId: uuid('test_session_id').notNull(),
  testItemId: uuid('test_item_id').notNull(),
  questionId: uuid('question_id').notNull(),
  response: jsonb('response').$type<Record<string, unknown>>(),
  status: text('status', { enum: TEST_ITEM_STATUSES }).notNull().default('not_visited'),
  isCorrect: boolean('is_correct'),
  score: numeric('score', { precision: 5, scale: 2 }),
  outcome: text('outcome'),
  timeSpentSec: integer('time_spent_sec').default(0),
  /** Server-measured time with this question open, in milliseconds; `timeSpentSec` is kept in step. */
  timeSpentMs: integer('time_spent_ms').notNull().default(0),
  ...timestamps,
});

export type MockTestRow = typeof mockTests.$inferSelect;
export type TestSectionRow = typeof testSections.$inferSelect;
export type TestItemRow = typeof testItems.$inferSelect;
export type TestSessionRow = typeof testSessions.$inferSelect;
export type TestItemResponseRow = typeof testItemResponses.$inferSelect;
