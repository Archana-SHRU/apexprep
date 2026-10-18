import { boolean, integer, jsonb, numeric, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * Mirror of migrations 0005, 0009 and 0010: practice sessions, what was served, immutable
 * attempts, the ability projection and focus-tracking events.
 *
 * `attempts` is append-only in the database (AP001 on UPDATE/DELETE). `ability_scores`
 * is a projection: every value in it can be recomputed by replaying attempts in
 * (created_at, id) order.
 */

export const SESSION_MODES = ['adaptive', 'placement', 'review'] as const;
export const SESSION_STATUSES = ['active', 'completed', 'abandoned', 'expired'] as const;
export const DEVICE_TYPES = ['desktop', 'tablet', 'mobile', 'unknown'] as const;
export const SELECTION_REASONS = ['cold_start', 'placement', 'adaptive', 'probe', 'content_gap_fallback'] as const;
export const ITEM_STATUSES = ['served', 'answered', 'skipped', 'abandoned'] as const;
export const ATTEMPT_OUTCOMES = ['correct', 'incorrect', 'partial', 'ungraded'] as const;
export const PLACEMENT_STATUSES = ['not_started', 'in_progress', 'completed', 'skipped'] as const;
export const SESSION_EVENT_TYPES = [
  'visibility_hidden',
  'visibility_visible',
  'app_background',
  'app_foreground',
  'first_interaction',
  'answer_changed',
  'idle_start',
  'idle_end',
  'break_start',
  'break_end',
  'explanation_opened',
  'explanation_closed',
] as const;

export type SessionMode = (typeof SESSION_MODES)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type DeviceType = (typeof DEVICE_TYPES)[number];
export type SelectionReasonValue = (typeof SELECTION_REASONS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  subtopicId: uuid('subtopic_id').notNull(),
  mode: text('mode', { enum: SESSION_MODES }).notNull().default('adaptive'),
  status: text('status', { enum: SESSION_STATUSES }).notNull().default('active'),
  engineConfigId: uuid('engine_config_id').notNull(),
  focusTrackingEnabled: boolean('focus_tracking_enabled').notNull(),
  deviceType: text('device_type', { enum: DEVICE_TYPES }).notNull().default('unknown'),
  targetQuestionCount: smallint('target_question_count'),
  servedCount: integer('served_count').notNull().default(0),
  answeredCount: integer('answered_count').notNull().default(0),
  startedAt: tstz('started_at').notNull().defaultNow(),
  lastActivityAt: tstz('last_activity_at').notNull().defaultNow(),
  endedAt: tstz('ended_at'),
  ...timestamps,
});

export const sessionItems = pgTable('session_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  userId: uuid('user_id').notNull(),
  subtopicId: uuid('subtopic_id').notNull(),
  questionId: uuid('question_id').notNull(),
  position: integer('position').notNull(),
  selectionReason: text('selection_reason', { enum: SELECTION_REASONS }).notNull(),
  difficultyBAtServe: numeric('difficulty_b_at_serve', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  thetaAtServe: numeric('theta_at_serve', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  targetB: numeric('target_b', { precision: 8, scale: 2, mode: 'number' }),
  status: text('status', { enum: ITEM_STATUSES }).notNull().default('served'),
  servedAt: tstz('served_at').notNull().defaultNow(),
  answeredAt: tstz('answered_at'),
  ...timestamps,
});

/** IMMUTABLE. Everything needed to replay the engine is stored on the row. */
export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  questionId: uuid('question_id').notNull(),
  questionVersion: integer('question_version').notNull(),
  subtopicId: uuid('subtopic_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  sessionItemId: uuid('session_item_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  response: jsonb('response').$type<Record<string, unknown>>().notNull(),
  outcome: text('outcome', { enum: ATTEMPT_OUTCOMES }).notNull(),
  score: numeric('score', { precision: 4, scale: 3, mode: 'number' }),
  ttfiMs: integer('ttfi_ms'),
  totalTimeMs: integer('total_time_ms').notNull(),
  answerChanges: smallint('answer_changes').notNull().default(0),
  hintCount: smallint('hint_count').notNull().default(0),
  difficultyBAtAttempt: numeric('difficulty_b_at_attempt', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  difficultyLabelAtAttempt: smallint('difficulty_label_at_attempt').notNull(),
  thetaBefore: numeric('theta_before', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  expectedScore: numeric('expected_score', { precision: 5, scale: 4, mode: 'number' }).notNull(),
  /** The two mutable question inputs the engine used, snapshotted (migration 0010). */
  calibrationNAtAttempt: integer('calibration_n_at_attempt'),
  expectedTimeSecondsAtAttempt: integer('expected_time_seconds_at_attempt'),
  engineConfigId: uuid('engine_config_id').notNull(),
  deviceType: text('device_type', { enum: DEVICE_TYPES }).notNull().default('unknown'),
  isProbe: boolean('is_probe').notNull().default(false),
  isPlacement: boolean('is_placement').notNull().default(false),
  probableGuess: boolean('probable_guess').notNull().default(false),
  flaggedForReview: boolean('flagged_for_review').notNull().default(false),
  clientSubmittedAt: tstz('client_submitted_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const abilityScores = pgTable('ability_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  subtopicId: uuid('subtopic_id').notNull(),
  theta: numeric('theta', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  level: smallint('level').notNull(),
  attemptsCount: integer('attempts_count').notNull().default(0),
  gradedCount: integer('graded_count').notNull().default(0),
  correctCount: integer('correct_count').notNull().default(0),
  consecutiveCorrect: smallint('consecutive_correct').notNull().default(0),
  consecutiveIncorrect: smallint('consecutive_incorrect').notNull().default(0),
  placementStatus: text('placement_status', { enum: PLACEMENT_STATUSES }).notNull().default('not_started'),
  placementAnswered: smallint('placement_answered').notNull().default(0),
  lastAttemptId: uuid('last_attempt_id'),
  lastAttemptAt: tstz('last_attempt_at'),
  lastDecayAppliedAt: tstz('last_decay_applied_at'),
  engineConfigId: uuid('engine_config_id').notNull(),
  rebuiltAt: tstz('rebuilt_at'),
  /** Migration 0009: attempts at or before this time are outside the ladder windows. */
  ladderResetAt: tstz('ladder_reset_at'),
  ...timestamps,
});

export const sessionEvents = pgTable('session_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  userId: uuid('user_id').notNull(),
  subtopicId: uuid('subtopic_id').notNull(),
  sessionItemId: uuid('session_item_id'),
  clientEventId: uuid('client_event_id').notNull(),
  eventType: text('event_type', { enum: SESSION_EVENT_TYPES }).notNull(),
  occurredAt: tstz('occurred_at').notNull(),
  durationMs: integer('duration_ms'),
  receivedAt: tstz('received_at').notNull().defaultNow(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type SessionItemRow = typeof sessionItems.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;
export type AbilityScoreRow = typeof abilityScores.$inferSelect;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
