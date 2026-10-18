import { boolean, date, integer, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * What sort of learning context a track is (migration 0013).
 *
 * Exactly the four categories the product defines, and nothing invented: a school
 * class, a competitive exam, an Olympiad, or something else. A track may also be
 * **uncategorised** — `kind` is nullable, which is what every track created before
 * Phase 8 is, and they go on working untouched.
 */
export const TRACK_KINDS = ['school', 'competitive_exam', 'olympiad', 'other'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

/** Mirror of migrations 0002 and 0013 (tracks), the root of the syllabus tree. */
export const tracks = pgTable('tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  shortName: text('short_name'),
  description: text('description'),
  examYear: smallint('exam_year'),
  examDate: date('exam_date', { mode: 'string' }),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status', { enum: ['draft', 'published', 'archived'] }).notNull().default('draft'),
  // ---- learning-context metadata (0013). All nullable: a track need say none of it.
  kind: text('kind', { enum: TRACK_KINDS }),
  educationStage: text('education_stage'),
  gradeLabel: text('grade_label'),
  /** For ordering and filtering school tracks only. Never read as a difficulty. */
  gradeOrdinal: smallint('grade_ordinal'),
  examFamily: text('exam_family'),
  curriculum: text('curriculum'),
  locale: text('locale'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});
export type TrackRow = typeof tracks.$inferSelect;

export const LEARNER_TRACK_STATUSES = ['active', 'left'] as const;
export type LearnerTrackStatus = (typeof LEARNER_TRACK_STATUSES)[number];

/**
 * Mirror of migration 0013 (learner_tracks): which tracks a learner is in.
 *
 * `users.primary_track_id` still holds the primary one and still means what it
 * always did; this table is what lets there be others alongside it. A learner with
 * no row here behaves exactly as they did before Phase 8.
 */
export const learnerTracks = pgTable('learner_tracks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  trackId: uuid('track_id').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  status: text('status', { enum: LEARNER_TRACK_STATUSES }).notNull().default('active'),
  goalText: text('goal_text'),
  enrolledAt: tstz('enrolled_at').notNull(),
  leftAt: tstz('left_at'),
  ...timestamps,
});
export type LearnerTrackRow = typeof learnerTracks.$inferSelect;
