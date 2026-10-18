import { integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/** Mirror of migration 0002 (subjects → chapters → topics → subtopics). `tracks` lives in tracks.ts. */

export const NODE_STATUSES = ['draft', 'published', 'archived'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const subjects = pgTable('subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  trackId: uuid('track_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  colorHex: text('color_hex'),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status', { enum: NODE_STATUSES }).notNull().default('draft'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export const chapters = pgTable('chapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  subjectId: uuid('subject_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  weightagePct: numeric('weightage_pct', { precision: 5, scale: 2, mode: 'number' }),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status', { enum: NODE_STATUSES }).notNull().default('draft'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export const topics = pgTable('topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  chapterId: uuid('chapter_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status', { enum: NODE_STATUSES }).notNull().default('draft'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export const subtopics = pgTable('subtopics', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  topicId: uuid('topic_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status', { enum: NODE_STATUSES }).notNull().default('draft'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export type SubjectRow = typeof subjects.$inferSelect;
export type ChapterRow = typeof chapters.$inferSelect;
export type TopicRow = typeof topics.$inferSelect;
export type SubtopicRow = typeof subtopics.$inferSelect;
