import { jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * Mirror of migration 0004 (review_tasks): the admin review queue. Ingestion output,
 * student reports on questions, duplicate candidates and content-gap alerts all land here.
 */

export const REVIEW_TASK_KINDS = [
  'block_classification',
  'theory_review',
  'question_review',
  'solution_match',
  'duplicate_candidate',
  'student_report',
  'explanation_review',
  'content_gap',
] as const;
export const REVIEW_TASK_STATUSES = ['open', 'in_progress', 'approved', 'rejected', 'resolved', 'cancelled'] as const;

export type ReviewTaskKind = (typeof REVIEW_TASK_KINDS)[number];
export type ReviewTaskStatus = (typeof REVIEW_TASK_STATUSES)[number];

export const reviewTasks = pgTable('review_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: REVIEW_TASK_KINDS }).notNull(),
  status: text('status', { enum: REVIEW_TASK_STATUSES }).notNull().default('open'),
  priority: smallint('priority').notNull().default(3),
  jobId: uuid('job_id'),
  contentBlockId: uuid('content_block_id'),
  questionId: uuid('question_id'),
  explanationId: uuid('explanation_id'),
  subtopicId: uuid('subtopic_id'),
  duplicateOfQuestionId: uuid('duplicate_of_question_id'),
  reason: text('reason'),
  suggestion: jsonb('suggestion').$type<Record<string, unknown>>(),
  reporterUserId: uuid('reporter_user_id'),
  reporterComment: text('reporter_comment'),
  assignedTo: uuid('assigned_to'),
  resolutionNote: text('resolution_note'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: tstz('resolved_at'),
  ...timestamps,
});

export type ReviewTaskRow = typeof reviewTasks.$inferSelect;
