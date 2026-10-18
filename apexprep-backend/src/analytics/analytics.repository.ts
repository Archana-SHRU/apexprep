import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import type { AttemptFact } from './analytics.math';
import type { AdminStatsDto } from './dto/admin-stats.dto';

/**
 * Reads for a learner's own figures.
 *
 * Every query takes `tenantId` **and** `userId` and puts both in the WHERE clause. Both come from the
 * verified JWT and never from the request, so there is no path by which one learner's figures can be
 * computed from another's rows — the tests assert it.
 *
 * These are reads over `attempts` (immutable, one row per answer) and `ability_scores` (the engine's own
 * projection). Nothing here writes, and nothing here recomputes what the adaptive engine already decided:
 * `level` is read from `ability_scores`, never derived.
 */
@Injectable()
export class AnalyticsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The learner's attempts, optionally from a date and optionally within one subject.
   *
   * Returned as rows rather than aggregated in SQL because the figures are many small statistics over the
   * same sample — accuracy, pace, per-level, weekly — and computing them in one pass over a typed array is
   * both cheaper than five round trips and unit-testable. A learner's own attempt count is bounded by how
   * many questions they have answered, so this is a small result set by construction; `limit` is a
   * backstop, not a pager.
   */
  async attemptFacts(
    tenantId: string,
    userId: string,
    opts: { since?: Date; subjectId?: string; limit?: number } = {},
    tx: Executor = this.db,
  ): Promise<AttemptFact[]> {
    const result = await tx.execute<{
      correct: boolean | null;
      total_time_ms: number | null;
      difficulty_label_at_attempt: number;
      created_at: string | Date;
      probable_guess: boolean;
    }>(sql`
      SELECT
        -- 'ungraded' is a long-form answer awaiting marking: counted as an attempt, never as evidence.
        CASE a.outcome WHEN 'ungraded' THEN NULL WHEN 'correct' THEN true ELSE false END AS correct,
        a.total_time_ms,
        a.difficulty_label_at_attempt,
        a.created_at,
        a.probable_guess
      FROM attempts a
      ${opts.subjectId ? sql`
      -- subtopic_paths is the right tool here: this filters the learner's own attempts to one subject,
      -- and an attempt on a sub-topic later unpublished is still their attempt.
      JOIN subtopic_paths p
        ON p.tenant_id = a.tenant_id AND p.subtopic_id = a.subtopic_id
       AND p.subject_id = ${opts.subjectId}` : sql``}
      WHERE a.tenant_id = ${tenantId}
        AND a.user_id = ${userId}
        ${opts.since ? sql`AND a.created_at >= ${opts.since}` : sql``}
      ORDER BY a.created_at
      LIMIT ${opts.limit ?? 100_000}
    `);
    return result.rows.map((r) => ({
      correct: r.correct,
      totalTimeMs: r.total_time_ms === null ? null : Number(r.total_time_ms),
      difficultyLabel: Number(r.difficulty_label_at_attempt),
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
      probableGuess: r.probable_guess,
    }));
  }

  /** The distinct UTC days the learner attempted anything, newest first — the input to the streak. */
  async attemptDays(tenantId: string, userId: string, tx: Executor = this.db): Promise<string[]> {
    const result = await tx.execute<{ day: string }>(sql`
      SELECT DISTINCT to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
        FROM attempts a
       WHERE a.tenant_id = ${tenantId} AND a.user_id = ${userId}
       ORDER BY day DESC
       LIMIT 400
    `);
    return result.rows.map((r) => r.day);
  }

  /** Today's counts, computed in SQL so "today" is one definition in one place (the UTC day). */
  async today(tenantId: string, userId: string, tx: Executor = this.db): Promise<{ attempts: number; graded: number; correct: number; timeMs: number }> {
    const result = await tx.execute<{ attempts: string; graded: string; correct: string; time_ms: string | null }>(sql`
      SELECT count(*) AS attempts,
             count(*) FILTER (WHERE a.outcome <> 'ungraded') AS graded,
             count(*) FILTER (WHERE a.outcome = 'correct') AS correct,
             coalesce(sum(a.total_time_ms), 0) AS time_ms
        FROM attempts a
       WHERE a.tenant_id = ${tenantId} AND a.user_id = ${userId}
         AND (a.created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
    `);
    const row = result.rows[0];
    return {
      attempts: Number(row?.attempts ?? 0),
      graded: Number(row?.graded ?? 0),
      correct: Number(row?.correct ?? 0),
      timeMs: Number(row?.time_ms ?? 0),
    };
  }

  async totalAttempts(tenantId: string, userId: string, tx: Executor = this.db): Promise<number> {
    const result = await tx.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM attempts WHERE tenant_id = ${tenantId} AND user_id = ${userId}
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * Per-sub-topic performance for every sub-topic the learner has attempted.
   *
   * `level` and `theta` come from `ability_scores` — the engine's own numbers, read not recomputed. The
   * accuracy and pace here are over *all* of the learner's attempts in that sub-topic rather than the
   * requested window, because "your weakest sub-topic" is a statement about what they know, not about the
   * last seven days.
   *
   * `subtopic_paths` is the existing live view that joins a sub-topic to its topic, subject and track, so
   * the names come back in one query rather than four.
   */
  async subtopicPerformance(
    tenantId: string,
    userId: string,
    opts: { subjectId?: string } = {},
    tx: Executor = this.db,
  ): Promise<
    {
      subtopicId: string;
      subtopicName: string;
      topicName: string;
      subjectId: string;
      subjectName: string;
      questions: number;
      graded: number;
      correct: number;
      paceMs: number | null;
      level: number | null;
      lastAttemptAt: Date | null;
    }[]
  > {
    const result = await tx.execute<{
      subtopic_id: string;
      subtopic_name: string;
      topic_name: string;
      subject_id: string;
      subject_name: string;
      questions: string;
      graded: string;
      correct: string;
      pace_ms: string | null;
      level: number | null;
      last_attempt_at: string | Date | null;
    }>(sql`
      SELECT a.subtopic_id,
             st.name  AS subtopic_name,
             tp.name  AS topic_name,
             sb.id    AS subject_id,
             sb.name  AS subject_name,
             count(*)                                   AS questions,
             count(*) FILTER (WHERE a.outcome <> 'ungraded') AS graded,
             count(*) FILTER (WHERE a.outcome = 'correct')   AS correct,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY CASE WHEN a.probable_guess THEN NULL ELSE a.total_time_ms END
             )                                          AS pace_ms,
             max(ab.level)                              AS level,
             max(a.created_at)                          AS last_attempt_at
        FROM attempts a
        JOIN subtopics st ON st.tenant_id = a.tenant_id AND st.id = a.subtopic_id
        JOIN topics    tp ON tp.tenant_id = a.tenant_id AND tp.id = st.topic_id
        JOIN chapters  ch ON ch.tenant_id = a.tenant_id AND ch.id = tp.chapter_id
        JOIN subjects  sb ON sb.tenant_id = a.tenant_id AND sb.id = ch.subject_id
        LEFT JOIN ability_scores ab
               ON ab.tenant_id = a.tenant_id AND ab.user_id = a.user_id AND ab.subtopic_id = a.subtopic_id
       WHERE a.tenant_id = ${tenantId}
         AND a.user_id = ${userId}
         ${opts.subjectId ? sql`AND sb.id = ${opts.subjectId}` : sql``}
       GROUP BY a.subtopic_id, st.name, tp.name, sb.id, sb.name
    `);
    return result.rows.map((r) => ({
      subtopicId: r.subtopic_id,
      subtopicName: r.subtopic_name,
      topicName: r.topic_name,
      subjectId: r.subject_id,
      subjectName: r.subject_name,
      questions: Number(r.questions),
      graded: Number(r.graded),
      correct: Number(r.correct),
      paceMs: r.pace_ms === null ? null : Number(r.pace_ms),
      level: r.level === null ? null : Number(r.level),
      lastAttemptAt: r.last_attempt_at === null ? null : r.last_attempt_at instanceof Date ? r.last_attempt_at : new Date(r.last_attempt_at),
    }));
  }

  /** Published subjects of the learner's enrolled tracks, so the summary lists subjects they can practise. */
  async subjectsOfLearnerTracks(
    tenantId: string,
    userId: string,
    tx: Executor = this.db,
  ): Promise<{ subjectId: string; name: string; colorHex: string | null }[]> {
    const result = await tx.execute<{ subject_id: string; name: string; color_hex: string | null }>(sql`
      SELECT DISTINCT sb.id AS subject_id, sb.name, sb.color_hex
        FROM subjects sb
        JOIN tracks tr ON tr.tenant_id = sb.tenant_id AND tr.id = sb.track_id
       WHERE sb.tenant_id = ${tenantId}
         AND sb.status = 'published' AND sb.deleted_at IS NULL
         AND tr.status = 'published' AND tr.deleted_at IS NULL
         AND (
           -- the learner's enrolments, or their profile's primary track when they have no enrolment yet
           EXISTS (SELECT 1 FROM learner_tracks lt
                    WHERE lt.tenant_id = sb.tenant_id AND lt.user_id = ${userId}
                      AND lt.track_id = tr.id AND lt.status = 'active')
           OR tr.id = (SELECT u.primary_track_id FROM users u WHERE u.tenant_id = ${tenantId} AND u.id = ${userId})
         )
       ORDER BY sb.name
    `);
    return result.rows.map((r) => ({ subjectId: r.subject_id, name: r.name, colorHex: r.color_hex }));
  }

  /**
   * How many published sub-topics the learner could practise — the denominator of §10 coverage.
   *
   * Scoped to their enrolled tracks: coverage of the whole organisation's catalogue would be a different
   * (and much less useful) number for a learner in one track of many.
   */
  async publishedSubtopicCount(tenantId: string, userId: string, opts: { subjectId?: string } = {}, tx: Executor = this.db): Promise<number> {
    // Against the tables rather than `subtopic_paths`, because that view's `is_live` means only
    // "nothing in the chain is soft-deleted" — a draft sub-topic is `is_live` but is not practisable, and
    // counting drafts in the denominator would understate coverage for every learner.
    const result = await tx.execute<{ n: string }>(sql`
      SELECT count(*) AS n
        FROM subtopics st
        JOIN topics   tp ON tp.tenant_id = st.tenant_id AND tp.id = st.topic_id
        JOIN chapters ch ON ch.tenant_id = tp.tenant_id AND ch.id = tp.chapter_id
        JOIN subjects sb ON sb.tenant_id = ch.tenant_id AND sb.id = ch.subject_id
        JOIN tracks   tr ON tr.tenant_id = sb.tenant_id AND tr.id = sb.track_id
       WHERE st.tenant_id = ${tenantId}
         AND st.status = 'published' AND st.deleted_at IS NULL
         AND tp.status = 'published' AND tp.deleted_at IS NULL
         AND ch.status = 'published' AND ch.deleted_at IS NULL
         AND sb.status = 'published' AND sb.deleted_at IS NULL
         AND tr.status = 'published' AND tr.deleted_at IS NULL
         ${opts.subjectId ? sql`AND sb.id = ${opts.subjectId}` : sql``}
         AND (
           EXISTS (SELECT 1 FROM learner_tracks lt
                    WHERE lt.tenant_id = st.tenant_id AND lt.user_id = ${userId}
                      AND lt.track_id = tr.id AND lt.status = 'active')
           OR tr.id = (SELECT u.primary_track_id FROM users u WHERE u.tenant_id = ${tenantId} AND u.id = ${userId})
         )
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Published question counts for the named sub-topics, so a recommendation can say how much is there. */
  async questionCounts(tenantId: string, subtopicIds: readonly string[], tx: Executor = this.db): Promise<Map<string, number>> {
    if (subtopicIds.length === 0) return new Map();
    const result = await tx.execute<{ subtopic_id: string; n: string }>(sql`
      SELECT primary_subtopic_id AS subtopic_id, count(*) AS n
        FROM questions
       WHERE tenant_id = ${tenantId}
         AND status = 'published' AND deleted_at IS NULL
         AND primary_subtopic_id = ANY(${sql.param([...subtopicIds])}::uuid[])
       GROUP BY primary_subtopic_id
    `);
    return new Map(result.rows.map((r) => [r.subtopic_id, Number(r.n)]));
  }

  /** The sub-topic of the learner's most recent session, for the "continue where you left off" card. */
  async lastPractisedSubtopic(tenantId: string, userId: string, tx: Executor = this.db): Promise<string | undefined> {
    const result = await tx.execute<{ subtopic_id: string }>(sql`
      SELECT s.subtopic_id
        FROM sessions s
       WHERE s.tenant_id = ${tenantId} AND s.user_id = ${userId}
       ORDER BY s.last_activity_at DESC
       LIMIT 1
    `);
    return result.rows[0]?.subtopic_id;
  }

  /**
   * Platform-wide aggregate metrics for admin dashboard and analytics (`reports:tenant`).
   * Evaluated inside PostgreSQL via concurrent aggregation queries scoped strictly to the tenant.
   */
  async adminStats(tenantId: string, tx: Executor = this.db): Promise<AdminStatsDto> {
    const [learnersRes, questionCountsRes, subjectQuestionsRes, practiceCountsRes, dailyVolumeRes, ingestionRes] = await Promise.all([
      tx.execute<{ total: number; active: number; onboarded: number; enrolled: number }>(sql`
        SELECT
          count(*)::int AS total,
          count(CASE WHEN u.status = 'active' THEN 1 END)::int AS active,
          count(CASE WHEN u.onboarded_at IS NOT NULL THEN 1 END)::int AS onboarded,
          (SELECT count(DISTINCT lt.user_id)::int FROM learner_tracks lt WHERE lt.tenant_id = ${tenantId} AND lt.status = 'active') AS enrolled
        FROM users u
        WHERE u.tenant_id = ${tenantId} AND u.role = 'STUDENT' AND u.deleted_at IS NULL
      `),
      tx.execute<{ total: number; published: number; draft: number; retired: number }>(sql`
        SELECT
          count(*)::int AS total,
          count(CASE WHEN q.status = 'published' THEN 1 END)::int AS published,
          count(CASE WHEN q.status = 'draft' THEN 1 END)::int AS draft,
          count(CASE WHEN q.status = 'retired' THEN 1 END)::int AS retired
        FROM questions q
        WHERE q.tenant_id = ${tenantId} AND q.deleted_at IS NULL
      `),
      tx.execute<{
        subject_id: string;
        subject_name: string;
        track_name: string;
        color_hex: string | null;
        published_count: number;
        total_count: number;
      }>(sql`
        SELECT
          sj.id AS subject_id,
          sj.name AS subject_name,
          tr.name AS track_name,
          sj.color_hex,
          count(CASE WHEN q.status = 'published' AND q.deleted_at IS NULL THEN 1 END)::int AS published_count,
          count(CASE WHEN q.deleted_at IS NULL THEN q.id END)::int AS total_count
        FROM subjects sj
        JOIN tracks tr ON tr.tenant_id = sj.tenant_id AND tr.id = sj.track_id AND tr.deleted_at IS NULL
        LEFT JOIN subtopic_paths p ON p.tenant_id = sj.tenant_id AND p.subject_id = sj.id AND p.is_live
        LEFT JOIN questions q ON q.tenant_id = p.tenant_id AND q.primary_subtopic_id = p.subtopic_id
        WHERE sj.tenant_id = ${tenantId} AND sj.deleted_at IS NULL
        GROUP BY sj.id, sj.name, tr.name, sj.color_hex, sj.sort_order
        ORDER BY sj.sort_order, sj.name
      `),
      tx.execute<{ total_attempts: number; today_attempts: number }>(sql`
        SELECT
          count(*)::int AS total_attempts,
          count(CASE WHEN a.created_at >= date_trunc('day', now()) THEN 1 END)::int AS today_attempts
        FROM attempts a
        WHERE a.tenant_id = ${tenantId}
      `),
      tx.execute<{ date: string; total_attempts: number; correct_attempts: number; active_learners: number }>(sql`
        SELECT
          to_char(a.created_at, 'YYYY-MM-DD') AS date,
          count(*)::int AS total_attempts,
          count(CASE WHEN a.outcome = 'correct' THEN 1 END)::int AS correct_attempts,
          count(DISTINCT a.user_id)::int AS active_learners
        FROM attempts a
        WHERE a.tenant_id = ${tenantId}
          AND a.created_at >= now() - interval '30 days'
        GROUP BY to_char(a.created_at, 'YYYY-MM-DD')
        ORDER BY date ASC
      `),
      tx.execute<{ total_jobs: number; successful_jobs: number; failed_jobs: number; total_pages: number; extracted_questions: number }>(sql`
        SELECT
          count(*)::int AS total_jobs,
          count(CASE WHEN status IN ('published', 'awaiting_review', 'publishing') THEN 1 END)::int AS successful_jobs,
          count(CASE WHEN status = 'failed' THEN 1 END)::int AS failed_jobs,
          coalesce(sum(pages_total), 0)::int AS total_pages,
          coalesce(sum(blocks_question), 0)::int AS extracted_questions
        FROM ingestion_jobs
        WHERE tenant_id = ${tenantId}
      `),
    ]);

    const l = learnersRes.rows[0] ?? { total: 0, active: 0, onboarded: 0, enrolled: 0 };
    const q = questionCountsRes.rows[0] ?? { total: 0, published: 0, draft: 0, retired: 0 };
    const p = practiceCountsRes.rows[0] ?? { total_attempts: 0, today_attempts: 0 };
    const ing = ingestionRes.rows[0] ?? { total_jobs: 0, successful_jobs: 0, failed_jobs: 0, total_pages: 0, extracted_questions: 0 };

    const finishedJobs = Number(ing.successful_jobs) + Number(ing.failed_jobs);
    const successRate = finishedJobs > 0 ? Math.round((Number(ing.successful_jobs) / finishedJobs) * 100) : null;

    return {
      learners: {
        total: Number(l.total ?? 0),
        active: Number(l.active ?? 0),
        disabled: Math.max(0, Number(l.total ?? 0) - Number(l.active ?? 0)),
        onboarded: Number(l.onboarded ?? 0),
        enrolled: Number(l.enrolled ?? 0),
      },
      questions: {
        total: Number(q.total ?? 0),
        published: Number(q.published ?? 0),
        draft: Number(q.draft ?? 0),
        retired: Number(q.retired ?? 0),
        bySubject: subjectQuestionsRes.rows.map((s) => ({
          subjectId: s.subject_id,
          subjectName: s.subject_name,
          trackName: s.track_name,
          colorHex: s.color_hex,
          publishedCount: Number(s.published_count ?? 0),
          totalCount: Number(s.total_count ?? 0),
          questionCount: Number(s.published_count ?? 0),
        })),
      },
      practice: {
        totalAttempts: Number(p.total_attempts ?? 0),
        todayAttempts: Number(p.today_attempts ?? 0),
        dailyVolume: dailyVolumeRes.rows.map((d) => ({
          date: d.date,
          totalAttempts: Number(d.total_attempts ?? 0),
          correctAttempts: Number(d.correct_attempts ?? 0),
          activeLearners: Number(d.active_learners ?? 0),
        })),
        dailyPracticeVolume: dailyVolumeRes.rows.map((d) => ({
          date: d.date,
          totalAttempts: Number(d.total_attempts ?? 0),
          correctAttempts: Number(d.correct_attempts ?? 0),
          activeLearners: Number(d.active_learners ?? 0),
          attemptsCount: Number(d.total_attempts ?? 0),
          uniqueLearners: Number(d.active_learners ?? 0),
        })),
      },
      ingestion: {
        totalJobs: Number(ing.total_jobs ?? 0),
        successfulJobs: Number(ing.successful_jobs ?? 0),
        publishedJobs: Number(ing.successful_jobs ?? 0),
        failedJobs: Number(ing.failed_jobs ?? 0),
        awaitingReviewJobs: 0,
        successRate,
        successRatePct: successRate ?? 0,
        totalPages: Number(ing.total_pages ?? 0),
        extractedQuestions: Number(ing.extracted_questions ?? 0),
      },
    };
  }
}
