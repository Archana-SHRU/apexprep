import { boolean, date, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { ROLES } from '../../common/auth/permissions';
import { timestamps, tstz } from './columns';

/** Mirror of migration 0001 (users). password_hash must never leave the auth module. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  email: text('email').notNull(),
  emailVerifiedAt: tstz('email_verified_at'),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ROLES }).notNull().default('STUDENT'),
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  displayName: text('display_name').notNull(),
  primaryTrackId: uuid('primary_track_id'),
  goalText: text('goal_text'),
  targetRank: integer('target_rank'),
  dailyQuestionGoal: integer('daily_question_goal'),
  targetExamDate: date('target_exam_date', { mode: 'string' }),
  onboardedAt: tstz('onboarded_at'),
  focusTrackingOptOut: boolean('focus_tracking_opt_out').notNull().default(false),
  tokenVersion: integer('token_version').notNull().default(0),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  lastLoginAt: tstz('last_login_at'),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export type UserRow = typeof users.$inferSelect;
