import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Candidate } from '../adaptive';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import {
  abilityScores,
  attempts,
  questionOptions,
  questions,
  reviewTasks,
  sessionEvents,
  sessionItems,
  sessions,
  subtopics,
  topics,
  type AbilityScoreRow,
  type AttemptRow,
  type SessionItemRow,
  type SessionRow,
} from '../database/schema';
import type { ReplayAttempt } from './ability-replay';
import type { AnswerKey } from './grading';

/**
 * Raw `execute` returns timestamps as strings (Drizzle keeps the text form to preserve
 * precision), so every date that reaches the engine is coerced here at the boundary.
 */
function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * All practice data access, tenant-scoped. Reads that feed the engine come from the
 * immutable `attempts` rows wherever possible, so the projection in `ability_scores` can
 * always be rebuilt from them.
 */

export interface QuestionForGrading extends AnswerKey {
  id: string;
  version: number;
  difficultyB: number;
  difficultyLabel: number;
  calibrationN: number;
  expectedTimeSeconds: number;
}

/** One graded attempt as the level ladder sees it. */
export interface LadderRow {
  score: number | null;
  totalTimeMs: number;
  isProbe: boolean;
  expectedTimeSeconds: number;
}

@Injectable()
export class PracticeRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // ---------------------------------------------------------------- sessions

  async findActiveSession(tenantId: string, userId: string, subtopicId: string, tx: Executor = this.db): Promise<SessionRow | undefined> {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.tenantId, tenantId), eq(sessions.userId, userId), eq(sessions.subtopicId, subtopicId), eq(sessions.status, 'active')),
      )
      .limit(1);
    return row;
  }

  async findSession(tenantId: string, userId: string, id: string, tx: Executor = this.db, lock = false): Promise<SessionRow | undefined> {
    const query = tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.userId, userId), eq(sessions.id, id)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  async insertSession(values: PgInsertValue<typeof sessions>, tx: Executor): Promise<SessionRow> {
    const [row] = await tx.insert(sessions).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async updateSession(tenantId: string, id: string, patch: PgUpdateSetSource<typeof sessions>, tx: Executor): Promise<SessionRow | undefined> {
    const [row] = await tx
      .update(sessions)
      .set(patch)
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, id)))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------- items

  /** The question currently on the student's screen, if any. */
  async findOutstandingItem(tenantId: string, sessionId: string, tx: Executor = this.db): Promise<SessionItemRow | undefined> {
    const [row] = await tx
      .select()
      .from(sessionItems)
      .where(and(eq(sessionItems.tenantId, tenantId), eq(sessionItems.sessionId, sessionId), eq(sessionItems.status, 'served')))
      .orderBy(desc(sessionItems.position))
      .limit(1);
    return row;
  }

  async findItem(tenantId: string, id: string, tx: Executor, lock = false): Promise<SessionItemRow | undefined> {
    const query = tx
      .select()
      .from(sessionItems)
      .where(and(eq(sessionItems.tenantId, tenantId), eq(sessionItems.id, id)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  /** Milliseconds since this question was served, on the database clock; null when the item does not exist. */
  async msSinceServed(tenantId: string, id: string, tx: Executor): Promise<number | null> {
    const res = await tx.execute<{ ms: string | number }>(sql`
      SELECT floor(extract(epoch FROM (clock_timestamp() - served_at)) * 1000)::bigint AS ms
        FROM session_items WHERE tenant_id = ${tenantId} AND id = ${id}`);
    const row = res.rows[0];
    return row ? Math.max(0, Number(row.ms)) : null;
  }

  async insertItem(values: PgInsertValue<typeof sessionItems>, tx: Executor): Promise<SessionItemRow> {
    const [row] = await tx.insert(sessionItems).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async updateItem(tenantId: string, id: string, patch: PgUpdateSetSource<typeof sessionItems>, tx: Executor): Promise<void> {
    await tx.update(sessionItems).set(patch).where(and(eq(sessionItems.tenantId, tenantId), eq(sessionItems.id, id)));
  }

  // ---------------------------------------------------------------- ability

  async findAbility(tenantId: string, userId: string, subtopicId: string, tx: Executor = this.db, lock = false): Promise<AbilityScoreRow | undefined> {
    const query = tx
      .select()
      .from(abilityScores)
      .where(and(eq(abilityScores.tenantId, tenantId), eq(abilityScores.userId, userId), eq(abilityScores.subtopicId, subtopicId)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  async insertAbility(values: PgInsertValue<typeof abilityScores>, tx: Executor): Promise<AbilityScoreRow> {
    const [row] = await tx.insert(abilityScores).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async updateAbility(tenantId: string, id: string, patch: PgUpdateSetSource<typeof abilityScores>, tx: Executor): Promise<AbilityScoreRow | undefined> {
    const [row] = await tx
      .update(abilityScores)
      .set(patch)
      .where(and(eq(abilityScores.tenantId, tenantId), eq(abilityScores.id, id)))
      .returning();
    return row;
  }

  /** θ of the student's other sub-topics under the same topic, for parent-topic seeding. */
  async siblingThetas(tenantId: string, userId: string, subtopicId: string, tx: Executor = this.db): Promise<number[]> {
    const rows = await tx
      .select({ theta: abilityScores.theta })
      .from(abilityScores)
      .innerJoin(subtopics, and(eq(subtopics.tenantId, abilityScores.tenantId), eq(subtopics.id, abilityScores.subtopicId)))
      .where(
        and(
          eq(abilityScores.tenantId, tenantId),
          eq(abilityScores.userId, userId),
          sql`${subtopics.topicId} = (SELECT topic_id FROM subtopics WHERE tenant_id = ${tenantId} AND id = ${subtopicId})`,
          sql`${abilityScores.subtopicId} <> ${subtopicId}`,
          isNull(subtopics.deletedAt),
        ),
      );
    return rows.map((r) => r.theta);
  }

  /** Sub-topics under the same topic, for widening the pool when a sub-topic runs dry. */
  async siblingSubtopicIds(tenantId: string, subtopicId: string, tx: Executor = this.db): Promise<string[]> {
    const rows = await tx
      .select({ id: subtopics.id })
      .from(subtopics)
      .innerJoin(topics, and(eq(topics.tenantId, subtopics.tenantId), eq(topics.id, subtopics.topicId)))
      .where(
        and(
          eq(subtopics.tenantId, tenantId),
          isNull(subtopics.deletedAt),
          eq(subtopics.status, 'published'),
          isNull(topics.deletedAt),
          eq(topics.status, 'published'),
          sql`${subtopics.topicId} = (SELECT topic_id FROM subtopics WHERE tenant_id = ${tenantId} AND id = ${subtopicId})`,
        ),
      );
    return rows.map((r) => r.id);
  }

  // ---------------------------------------------------------------- selection inputs

  /**
   * Every published question of these sub-topics, with when this student last saw each
   * one. The engine decides eligibility from these dates; the query does not filter, so
   * the exclusion rules live in one place (`filterEligible`).
   */
  async candidatePool(
    tenantId: string,
    userId: string,
    subtopicIds: string[],
    tx: Executor = this.db,
  ): Promise<(Candidate & { calibrationN: number; expectedTimeSeconds: number })[]> {
    if (subtopicIds.length === 0) return [];
    const result = await tx.execute<{
      id: string;
      difficulty_b: string;
      difficulty_label: number;
      duplicate_group_id: string | null;
      calibration_n: number;
      expected_time_seconds: number;
      last_attempted_at: string | Date | null;
      last_skipped_at: string | Date | null;
    }>(sql`
      SELECT q.id,
             q.difficulty_b,
             q.difficulty_label,
             q.duplicate_group_id,
             q.calibration_n,
             q.expected_time_seconds,
             seen.last_attempted_at,
             served.last_skipped_at
        FROM ${questions} q
        LEFT JOIN LATERAL (
              SELECT max(a.created_at) AS last_attempted_at
                FROM ${attempts} a
               WHERE a.tenant_id = q.tenant_id AND a.user_id = ${userId} AND a.question_id = q.id
             ) seen ON true
        LEFT JOIN LATERAL (
              SELECT max(i.served_at) AS last_skipped_at
                FROM ${sessionItems} i
               WHERE i.tenant_id = q.tenant_id AND i.user_id = ${userId} AND i.question_id = q.id
                 AND i.status <> 'answered'
             ) served ON true
       WHERE q.tenant_id = ${tenantId}
         AND q.primary_subtopic_id = ANY(${sql.param(subtopicIds)}::uuid[])
         AND q.status = 'published'
         AND q.deleted_at IS NULL
    `);
    return result.rows.map((r) => ({
      id: r.id,
      difficultyB: Number(r.difficulty_b),
      difficultyLabel: r.difficulty_label,
      duplicateGroupId: r.duplicate_group_id,
      lastAttemptedAt: toDate(r.last_attempted_at),
      lastSkippedAt: toDate(r.last_skipped_at),
      calibrationN: r.calibration_n,
      expectedTimeSeconds: r.expected_time_seconds,
    }));
  }

  /** Near-duplicate groups this student has already seen, and when. */
  async seenDuplicateGroups(tenantId: string, userId: string, since: Date, tx: Executor = this.db): Promise<{ groupId: string; seenAt: Date }[]> {
    const result = await tx.execute<{ group_id: string; seen_at: string | Date }>(sql`
      SELECT q.duplicate_group_id AS group_id, max(seen.seen_at) AS seen_at
        FROM (
              SELECT question_id, created_at AS seen_at FROM ${attempts}
               WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND created_at > ${since}
              UNION ALL
              SELECT question_id, served_at FROM ${sessionItems}
               WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND served_at > ${since}
             ) seen
        JOIN ${questions} q ON q.tenant_id = ${tenantId} AND q.id = seen.question_id
       WHERE q.duplicate_group_id IS NOT NULL
       GROUP BY q.duplicate_group_id
    `);
    return result.rows.map((r) => ({ groupId: r.group_id, seenAt: toDate(r.seen_at)! }));
  }

  // ---------------------------------------------------------------- questions

  /** The answer key and calibration state, read only on the grading path. */
  async questionForGrading(tenantId: string, questionId: string, tx: Executor = this.db): Promise<QuestionForGrading | undefined> {
    const [q] = await tx
      .select({
        id: questions.id,
        type: questions.type,
        version: questions.version,
        correctNumeric: questions.correctNumeric,
        numericTolerance: questions.numericTolerance,
        toleranceMode: questions.toleranceMode,
        matrixAnswer: questions.matrixAnswer,
        difficultyB: questions.difficultyB,
        difficultyLabel: questions.difficultyLabel,
        calibrationN: questions.calibrationN,
        expectedTimeSeconds: questions.expectedTimeSeconds,
      })
      .from(questions)
      .where(and(eq(questions.tenantId, tenantId), eq(questions.id, questionId), isNull(questions.deletedAt)))
      .limit(1);
    if (!q) return undefined;

    const options = await tx
      .select({ key: questionOptions.optionKey, side: questionOptions.side, isCorrect: questionOptions.isCorrect })
      .from(questionOptions)
      .where(and(eq(questionOptions.tenantId, tenantId), eq(questionOptions.questionId, questionId)));

    return {
      id: q.id,
      type: q.type,
      version: q.version,
      difficultyB: q.difficultyB,
      difficultyLabel: q.difficultyLabel,
      calibrationN: q.calibrationN,
      expectedTimeSeconds: q.expectedTimeSeconds,
      correctOptionKeys: options.filter((o) => o.isCorrect).map((o) => o.key),
      optionKeys: {
        single: options.filter((o) => o.side === 'single').map((o) => o.key),
        left: options.filter((o) => o.side === 'left').map((o) => o.key),
        right: options.filter((o) => o.side === 'right').map((o) => o.key),
      },
      correctNumeric: q.correctNumeric,
      numericTolerance: q.numericTolerance,
      toleranceMode: q.toleranceMode,
      matrixAnswer: q.matrixAnswer ?? null,
    };
  }

  /** Calibration update: the question's own difficulty and how many attempts back it. */
  async applyQuestionCalibration(tenantId: string, questionId: string, difficultyB: number, tx: Executor): Promise<void> {
    await tx
      .update(questions)
      .set({ difficultyB, calibrationN: sql`${questions.calibrationN} + 1` })
      .where(and(eq(questions.tenantId, tenantId), eq(questions.id, questionId)));
  }

  /**
   * §6.4: replace an admin's estimate of how long a question takes with the observed median, once
   * enough attempts stand behind it.
   *
   * One statement, deliberately. The median is computed and written in a single UPDATE, so no other
   * transaction can insert an attempt between the read and the write and leave a median that was
   * never true of the data. It is also the reason this cannot be done in application code: reading
   * the attempts out, taking a median in TypeScript and writing it back is the same operation with a
   * race in the middle.
   *
   * Three things make this safe to run inside the attempt transaction:
   *
   *   * It does not bump `questions.version`. `app_questions_bump_version()` fires only on the
   *     columns that change what the question *asks* (stem, type, answer key); calibration is not
   *     an edit, so cached explanations are not invalidated by it. Migration 0011's SQL test asserts
   *     exactly this.
   *   * Every attempt snapshots `expected_time_seconds_at_attempt` (migration 0010), so an attempt
   *     already recorded is replayed against the value that was in force when it was answered. This
   *     write changes what the *next* attempt is measured against, never a past one.
   *   * `WHERE expected_time_seconds <> <new value>` means a median that has not moved writes no
   *     row at all — no dead tuple, no trigger work, and `updated_at` stays honest.
   *
   * `percentile_cont` interpolates, which is the continuous median: for an even number of attempts
   * it is the mean of the middle two rather than an arbitrary one of them. Rounded to whole seconds
   * because the column is an integer, and clamped to the same bounds the admin field itself is
   * checked against so calibration cannot store a value an admin could not have typed.
   *
   * The threshold is tested against `questions.calibration_n`, which is the column §6.4 names, and
   * not against the size of the median's own sample. With probable guesses excluded the sample can
   * be smaller than `calibration_n` — 30 graded attempts of which 4 were guesses gives a median over
   * 26 — and that is the intended reading: the requirement says when to start trusting observation,
   * the exclusion says which observations are of the thing being measured.
   *
   * @returns the stored expected time in seconds if it changed, otherwise null
   */
  async recalibrateExpectedTime(
    tenantId: string,
    questionId: string,
    opts: { minAttempts: number; excludeProbableGuesses: boolean; minSeconds: number; maxSeconds: number },
    tx: Executor,
  ): Promise<number | null> {
    const result = await tx.execute<{ expected_time_seconds: number }>(sql`
      WITH observed AS (
        SELECT count(*) AS sample_n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY a.total_time_ms) AS median_ms
          FROM attempts a
         WHERE a.tenant_id = ${tenantId}
           AND a.question_id = ${questionId}
           -- Every outcome counts, including 'ungraded': a long-form answer awaiting marking is
           -- still a student who spent that long answering the question, which is the quantity
           -- being estimated. A *skip* records no attempt row at all — it lives on
           -- session_items.status — so there is no skipped outcome to exclude here.
           AND a.total_time_ms IS NOT NULL
           ${opts.excludeProbableGuesses ? sql`AND a.probable_guess = false` : sql``}
      ), proposed AS (
        -- ::numeric before round() on purpose. percentile_cont returns double precision, and
        -- round() on a float rounds half to even, so a median of exactly 114.5 s would store 114
        -- while 115.5 stored 116. Rounding as numeric is half away from zero, which is both what
        -- a person expects of a displayed number of seconds and identical on every platform.
        SELECT least(greatest(round((median_ms / 1000.0)::numeric)::int, ${opts.minSeconds}), ${opts.maxSeconds}) AS seconds,
               sample_n, median_ms
          FROM observed
      )
      UPDATE ${questions} q
         SET expected_time_seconds = proposed.seconds
        FROM proposed
       WHERE q.tenant_id = ${tenantId}
         AND q.id = ${questionId}
         -- The threshold the requirement states, on the column it names.
         AND q.calibration_n >= ${opts.minAttempts}
         AND proposed.median_ms IS NOT NULL
         AND proposed.sample_n > 0
         AND q.expected_time_seconds <> proposed.seconds
      RETURNING q.expected_time_seconds
    `);
    const row = result.rows[0];
    return row ? Number(row.expected_time_seconds) : null;
  }

  // ---------------------------------------------------------------- attempts

  async findAttemptByIdempotencyKey(tenantId: string, userId: string, key: string, tx: Executor = this.db): Promise<AttemptRow | undefined> {
    const [row] = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.tenantId, tenantId), eq(attempts.userId, userId), eq(attempts.idempotencyKey, key)))
      .limit(1);
    return row;
  }

  async insertAttempt(values: PgInsertValue<typeof attempts>, tx: Executor): Promise<AttemptRow> {
    const [row] = await tx.insert(attempts).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  /**
   * An attempt's own `created_at`, as a SQL expression rather than a value.
   *
   * `timestamptz` keeps microseconds; a JavaScript `Date` keeps milliseconds. Writing a
   * round-tripped timestamp into `ability_scores.ladder_reset_at` would therefore land up
   * to a millisecond *before* the attempt, and `ladderHistory`'s `created_at > reset`
   * would let the attempt that caused the level change back into the ladder window — two
   * quick correct answers would then promote twice. Reading the value in SQL keeps the
   * boundary exact.
   */
  attemptCreatedAt(tenantId: string, attemptId: string): SQL<Date> {
    return sql<Date>`(SELECT a.created_at FROM ${attempts} a WHERE a.tenant_id = ${tenantId} AND a.id = ${attemptId})`;
  }

  /**
   * One student's whole attempt history in one sub-topic, in the order the engine saw it,
   * for rebuilding the ability projection. `selection_reason` comes from the served item,
   * which is immutable once answered; everything else is on the attempt row itself.
   */
  async attemptsForReplay(tenantId: string, userId: string, subtopicId: string, tx: Executor = this.db): Promise<ReplayAttempt[]> {
    const rows = await tx
      .select({
        id: attempts.id,
        createdAt: attempts.createdAt,
        outcome: attempts.outcome,
        score: attempts.score,
        totalTimeMs: attempts.totalTimeMs,
        thetaBefore: attempts.thetaBefore,
        difficultyBAtAttempt: attempts.difficultyBAtAttempt,
        calibrationNAtAttempt: attempts.calibrationNAtAttempt,
        expectedTimeSecondsAtAttempt: attempts.expectedTimeSecondsAtAttempt,
        probableGuess: attempts.probableGuess,
        selectionReason: sessionItems.selectionReason,
        engineConfigId: attempts.engineConfigId,
      })
      .from(attempts)
      .innerJoin(sessionItems, and(eq(sessionItems.tenantId, attempts.tenantId), eq(sessionItems.id, attempts.sessionItemId)))
      .where(and(eq(attempts.tenantId, tenantId), eq(attempts.userId, userId), eq(attempts.subtopicId, subtopicId)))
      .orderBy(attempts.createdAt, attempts.id);
    return rows;
  }

  /**
   * The ladder window: graded, non-guess attempts in this sub-topic since the level last
   * changed, newest first. `expected_time_seconds` comes from the question so the engine
   * can decide whether each answer was inside the speed condition.
   *
   * The `ladder_reset_at` boundary is read inside this query rather than passed in: a
   * `timestamptz` keeps microseconds and a JavaScript `Date` does not, so a boundary that
   * travelled through TypeScript would be up to a millisecond early and would let the
   * attempt that caused the level change back into its own window. `-infinity` stands in
   * for "no reset yet", so the whole history counts.
   */
  async ladderHistory(tenantId: string, userId: string, subtopicId: string, limit: number, tx: Executor = this.db): Promise<LadderRow[]> {
    const result = await tx.execute<{ score: string | null; total_time_ms: number; is_probe: boolean; expected_time_seconds: number }>(sql`
      SELECT a.score, a.total_time_ms, a.is_probe, q.expected_time_seconds
        FROM ${attempts} a
        JOIN ${questions} q ON q.tenant_id = a.tenant_id AND q.id = a.question_id
       WHERE a.tenant_id = ${tenantId}
         AND a.user_id = ${userId}
         AND a.subtopic_id = ${subtopicId}
         AND a.probable_guess = false
         AND a.outcome <> 'ungraded'
         AND a.created_at > COALESCE(
               (SELECT ab.ladder_reset_at FROM ${abilityScores} ab
                 WHERE ab.tenant_id = a.tenant_id AND ab.user_id = a.user_id AND ab.subtopic_id = a.subtopic_id),
               '-infinity'::timestamptz)
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${limit}
    `);
    return result.rows.map((r) => ({
      score: r.score === null ? null : Number(r.score),
      totalTimeMs: r.total_time_ms,
      isProbe: r.is_probe,
      expectedTimeSeconds: r.expected_time_seconds,
    }));
  }

  /** Probable guesses flagged so far in this session (the pause rule is derived, not stored). */
  async countProbableGuesses(tenantId: string, sessionId: string, tx: Executor = this.db): Promise<number> {
    const result = await tx.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM ${attempts}
       WHERE tenant_id = ${tenantId} AND session_id = ${sessionId} AND probable_guess = true
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------- side effects

  /** Opens one content-gap review task per sub-topic; a second call is a no-op. */
  async openContentGapTask(tenantId: string, subtopicId: string, tx: Executor): Promise<void> {
    await tx.execute(sql`
      INSERT INTO ${reviewTasks} (tenant_id, kind, status, priority, subtopic_id, reason)
      SELECT ${tenantId}, 'content_gap', 'open', 2, ${subtopicId}, 'fewer eligible questions than the engine needs'
       WHERE NOT EXISTS (
         SELECT 1 FROM ${reviewTasks}
          WHERE tenant_id = ${tenantId} AND subtopic_id = ${subtopicId}
            AND kind = 'content_gap' AND status IN ('open', 'in_progress'))
    `);
  }

  /** Focus events; a replayed batch is ignored thanks to the (session, client event) key. */
  /**
   * Which of these served-item ids belong to this session.
   *
   * One query for the whole batch. The caller validates a client's event batch, which can name a
   * different item per event — checking them one at a time was a round trip per event, and a client
   * that batches fifty focus events made fifty of them inside one request.
   */
  async itemIdsInSession(
    tenantId: string,
    sessionId: string,
    itemIds: readonly string[],
    tx: Executor = this.db,
  ): Promise<Set<string>> {
    if (itemIds.length === 0) return new Set();
    const rows = await tx
      .select({ id: sessionItems.id })
      .from(sessionItems)
      .where(
        and(
          eq(sessionItems.tenantId, tenantId),
          eq(sessionItems.sessionId, sessionId),
          inArray(sessionItems.id, [...new Set(itemIds)]),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  async insertEvents(values: PgInsertValue<typeof sessionEvents>[], tx: Executor = this.db): Promise<number> {
    if (values.length === 0) return 0;
    const rows = await tx.insert(sessionEvents).values(values).onConflictDoNothing().returning({ id: sessionEvents.id });
    return rows.length;
  }

  async findQuestionHints(questionId: string, tx: Executor = this.db): Promise<string[]> {
    const [row] = await tx
      .select({ hints: questions.hints })
      .from(questions)
      .where(eq(questions.id, questionId))
      .limit(1);
    return row?.hints ?? [];
  }
}
