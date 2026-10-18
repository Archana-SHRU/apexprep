import { integer, jsonb, numeric, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';
import type { QuestionType } from './questions';

/**
 * Mirror of migration 0015: the caches and records behind revision notes, generated questions,
 * the tutor and visual explanations. Every row is tenant-owned and reached through the tenant.
 */

export const NOTE_SCOPE_LEVELS = ['track', 'subject', 'chapter', 'topic', 'subtopic'] as const;
export type NoteScopeLevel = (typeof NOTE_SCOPE_LEVELS)[number];

export const revisionNotes = pgTable('revision_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  scopeLevel: text('scope_level', { enum: NOTE_SCOPE_LEVELS }).notNull(),
  scopeId: uuid('scope_id').notNull(),
  sourceHash: text('source_hash').notNull(),
  sourceBlockIds: uuid('source_block_ids').array().notNull().default([]),
  promptVersion: text('prompt_version').notNull(),
  provider: text('provider'),
  model: text('model'),
  status: text('status', { enum: ['active', 'superseded', 'rejected'] }).notNull().default('active'),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  groundingScore: numeric('grounding_score', { precision: 4, scale: 3, mode: 'number' }),
  diagnostics: jsonb('diagnostics').$type<Record<string, unknown>>().notNull().default({}),
  generatedBy: uuid('generated_by'),
  generatedAt: tstz('generated_at').notNull().defaultNow(),
  ...timestamps,
});
export type RevisionNotesRow = typeof revisionNotes.$inferSelect;

export const GENERATED_QUESTION_STATUSES = ['published', 'in_review', 'rejected'] as const;
export type GeneratedQuestionStatus = (typeof GENERATED_QUESTION_STATUSES)[number];

export const generatedQuestions = pgTable('generated_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  questionId: uuid('question_id'),
  subtopicId: uuid('subtopic_id').notNull(),
  requestedBy: uuid('requested_by'),
  status: text('status', { enum: GENERATED_QUESTION_STATUSES }).notNull(),
  questionType: text('question_type').$type<QuestionType>().notNull(),
  targetLevel: smallint('target_level').notNull(),
  targetB: numeric('target_b', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  provider: text('provider'),
  model: text('model'),
  promptVersion: text('prompt_version').notNull(),
  sourceBlockIds: uuid('source_block_ids').array().notNull().default([]),
  sourceHash: text('source_hash').notNull(),
  stemFingerprint: text('stem_fingerprint'),
  validation: jsonb('validation').$type<Record<string, unknown>>().notNull().default({}),
  solution: jsonb('solution').$type<Record<string, unknown>>(),
  ...timestamps,
});
export type GeneratedQuestionRow = typeof generatedQuestions.$inferSelect;

export const TUTOR_INTENTS = ['free', 'hint', 'why_wrong', 'simplify', 'explain_step', 'another_example', 'concept'] as const;
export type TutorIntent = (typeof TUTOR_INTENTS)[number];

export const tutorConversations = pgTable('tutor_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  subtopicId: uuid('subtopic_id').notNull(),
  questionId: uuid('question_id'),
  questionVersion: integer('question_version'),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  lastMessageAt: tstz('last_message_at').notNull().defaultNow(),
  ...timestamps,
});
export type TutorConversationRow = typeof tutorConversations.$inferSelect;

export const tutorMessages = pgTable('tutor_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  role: text('role', { enum: ['student', 'tutor'] }).notNull(),
  intent: text('intent', { enum: TUTOR_INTENTS }).notNull().default('free'),
  body: text('body').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: tstz('created_at').notNull().defaultNow(),
});
export type TutorMessageRow = typeof tutorMessages.$inferSelect;

export const VISUAL_TYPES = ['diagram', 'graph', 'step_by_step', 'animation', 'illustration', 'image', 'none'] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

export const visualExplanations = pgTable('visual_explanations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  questionId: uuid('question_id').notNull(),
  questionVersion: integer('question_version').notNull(),
  promptVersion: text('prompt_version').notNull(),
  sourceHash: text('source_hash').notNull(),
  status: text('status', { enum: ['active', 'superseded', 'rejected'] }).notNull().default('active'),
  visualType: text('visual_type', { enum: VISUAL_TYPES }).notNull(),
  decision: jsonb('decision').$type<Record<string, unknown>>().notNull().default({}),
  spec: jsonb('spec').$type<Record<string, unknown>>(),
  assetId: uuid('asset_id'),
  provider: text('provider'),
  model: text('model'),
  validation: jsonb('validation').$type<Record<string, unknown>>().notNull().default({}),
  requestedBy: uuid('requested_by'),
  generatedAt: tstz('generated_at').notNull().defaultNow(),
  ...timestamps,
});
export type VisualExplanationRow = typeof visualExplanations.$inferSelect;
