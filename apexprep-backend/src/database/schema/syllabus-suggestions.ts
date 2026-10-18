import { jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * Mirror of migration 0016: syllabus hierarchy proposed by ingestion, awaiting a person's decision.
 * A suggestion is not a syllabus node — nodes are created only when an admin approves one.
 */

export const SUGGESTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const syllabusSuggestions = pgTable('syllabus_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  trackId: uuid('track_id').notNull(),
  subjectId: uuid('subject_id').notNull(),
  chapterName: text('chapter_name'),
  topicName: text('topic_name'),
  subtopicName: text('subtopic_name'),
  chapterKey: text('chapter_key').notNull(),
  topicKey: text('topic_key').notNull(),
  subtopicKey: text('subtopic_key').notNull(),
  existingChapterId: uuid('existing_chapter_id'),
  existingTopicId: uuid('existing_topic_id'),
  existingSubtopicId: uuid('existing_subtopic_id'),
  confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  mappingReason: text('mapping_reason').notNull(),
  status: text('status', { enum: SUGGESTION_STATUSES }).notNull().default('pending'),
  createdChapterId: uuid('created_chapter_id'),
  createdTopicId: uuid('created_topic_id'),
  createdSubtopicId: uuid('created_subtopic_id'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: tstz('reviewed_at'),
  rejectionReason: text('rejection_reason'),
  ...timestamps,
});

export const syllabusSuggestionBlocks = pgTable('syllabus_suggestion_blocks', {
  tenantId: uuid('tenant_id').notNull(),
  suggestionId: uuid('suggestion_id').notNull(),
  contentBlockId: uuid('content_block_id').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export type SyllabusSuggestionRow = typeof syllabusSuggestions.$inferSelect;
