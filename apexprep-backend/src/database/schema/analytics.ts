import { boolean, date, integer, numeric, pgTable, smallint, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * Anonymous benchmark snapshots computed per sub-topic over a rolling window.
 * Strictly anonymous: no user IDs, names, or individual ranks are stored.
 * Data is only published when the qualifying cohort meets the minimum size (e.g. >= 30).
 */
export const benchmarkSnapshots = pgTable('benchmark_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  subtopicId: uuid('subtopic_id').notNull(),
  difficultyLabel: smallint('difficulty_label'), // NULL = all levels
  snapshotDate: date('snapshot_date').notNull(),
  windowDays: smallint('window_days').notNull(),
  windowStart: tstz('window_start').notNull(),
  windowEnd: tstz('window_end').notNull(),
  qualifyingStudents: integer('qualifying_students').notNull(),
  minQualifyingStudents: integer('min_qualifying_students').notNull(),
  topK: smallint('top_k').notNull(),
  isPublished: boolean('is_published').notNull(),
  topAccuracy: numeric('top_accuracy', { precision: 5, scale: 4, mode: 'number' }),
  topMedianTimeMs: integer('top_median_time_ms'),
  engineConfigId: uuid('engine_config_id').notNull(),
  computedAt: tstz('computed_at').notNull().defaultNow(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export type BenchmarkSnapshotRow = typeof benchmarkSnapshots.$inferSelect;
export type NewBenchmarkSnapshot = typeof benchmarkSnapshots.$inferInsert;
