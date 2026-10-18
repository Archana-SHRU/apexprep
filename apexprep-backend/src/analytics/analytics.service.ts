import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { UsersRepository } from '../users/users.repository';
import {
  accuracyByLevel,
  accuracyPct,
  correctOf,
  coveragePct,
  daysUntil,
  gradedOf,
  median,
  paceSeconds,
  streakDays,
  weeklyTrend,
  type AttemptFact,
} from './analytics.math';
import { AnalyticsRepository } from './analytics.repository';
import type {
  AnalyticsRange,
  LearnerAnalyticsDto,
  LearnerSummaryDto,
  RecommendationDto,
  RecommendationsDto,
  SubjectSummaryDto,
  SubtopicPerformanceDto,
} from './dto/analytics.dto';
import type { AdminStatsDto } from './dto/admin-stats.dto';

/** How many days each range covers, and how many weekly points the trend gets. */
const RANGE_DAYS: Record<AnalyticsRange, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };
const RANGE_WEEKS: Record<AnalyticsRange, number> = { '7d': 4, '30d': 8, '90d': 13, all: 13 };

import { ReportPdfService } from './report-pdf.service';

/**
 * A learner's own figures, computed from their own rows.
 *
 * Three principles, all of which the tests hold to:
 *
 * 1. **Every number is a count, a ratio of counts, or a median over real attempts.** Nothing is projected,
 *    estimated, smoothed or benchmarked. If the data does not support a figure, the figure is `null` and
 *    the UI shows `—`.
 * 2. **Mastery is the engine's L1–L5 level, read from `ability_scores`.** No mastery percentage is computed
 *    here, because the requirements define none (§10 defines mastery as θ mapped to a band). Nothing in
 *    this service recomputes what the adaptive engine decided.
 * 3. **The learner is the JWT's learner.** `tenantId` and `userId` come from the verified token and are
 *    passed to every query; no request field can widen the scope.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly users: UsersRepository,
    private readonly pdfService: ReportPdfService,
  ) {}

  // ---------------------------------------------------------------- summary

  async summary(auth: AuthContext): Promise<LearnerSummaryDto> {
    const user = await this.users.findById(auth.tenantId, auth.userId);
    if (!user) throw AppException.unauthenticated();

    const [today, days, total] = await Promise.all([
      this.repo.today(auth.tenantId, auth.userId),
      this.repo.attemptDays(auth.tenantId, auth.userId),
      this.repo.totalAttempts(auth.tenantId, auth.userId),
    ]);

    return {
      solvedToday: today.attempts,
      todayAccuracy: accuracyPct(today.correct, today.graded),
      // Rounded to a whole minute: the UI shows "1h 45m", and second-level precision on a figure that
      // changes every second would make the dashboard look unstable for no gain.
      studyMinutesToday: Math.round(today.timeMs / 60_000),
      streakDays: streakDays(days, new Date()),
      dailyQuestionGoal: user.dailyQuestionGoal ?? null,
      questionsSolvedTotal: total,
      daysToTargetExam: daysUntil(user.targetExamDate === null ? null : new Date(user.targetExamDate), new Date()),
    };
  }

  // ---------------------------------------------------------------- analytics

  async analytics(auth: AuthContext, opts: { range?: AnalyticsRange; subjectId?: string }): Promise<LearnerAnalyticsDto> {
    const range: AnalyticsRange = opts.range ?? '30d';
    const days = RANGE_DAYS[range];
    const now = new Date();
    const since = days === null ? undefined : new Date(now.getTime() - days * 86_400_000);

    const [windowed, performance, subjects, publishedSubtopics] = await Promise.all([
      this.repo.attemptFacts(auth.tenantId, auth.userId, { since, subjectId: opts.subjectId }),
      this.repo.subtopicPerformance(auth.tenantId, auth.userId, { subjectId: opts.subjectId }),
      this.repo.subjectsOfLearnerTracks(auth.tenantId, auth.userId),
      this.repo.publishedSubtopicCount(auth.tenantId, auth.userId, { subjectId: opts.subjectId }),
    ]);

    const graded = gradedOf(windowed);
    const overallAccuracy = accuracyPct(correctOf(graded), graded.length);

    // The preceding window of equal length, for the delta. `all` has no preceding window, so no delta.
    let accuracyDelta: number | null = null;
    if (days !== null && overallAccuracy !== null) {
      const prevFrom = new Date(now.getTime() - days * 2 * 86_400_000);
      const previous = (await this.repo.attemptFacts(auth.tenantId, auth.userId, { since: prevFrom, subjectId: opts.subjectId })).filter(
        (a) => a.createdAt < since!,
      );
      const prevGraded = gradedOf(previous);
      const prevAccuracy = accuracyPct(correctOf(prevGraded), prevGraded.length);
      // Null rather than a delta against nothing: a learner's first week has no "change".
      if (prevAccuracy !== null) accuracyDelta = Math.round((overallAccuracy - prevAccuracy) * 10) / 10;
    }

    const perf = performance.map((p) => this.toPerformance(p, now));
    // Enough evidence to rank on. Below this a single unlucky question would name a "weakest sub-topic",
    // so such a sub-topic is reported in the lists' source data but never ranked into them.
    const rankable = perf.filter((p) => p.accuracy !== null && p.questions >= 5);

    return {
      range,
      overallAccuracy,
      accuracyDelta,
      questionsSolved: windowed.length,
      paceSeconds: paceSeconds(windowed),
      coveragePct: coveragePct(
        performance.map((p) => p.questions),
        publishedSubtopics,
      ),
      levelAccuracy: accuracyByLevel(windowed),
      trend: weeklyTrend(windowed, RANGE_WEEKS[range], now),
      weakSubtopics: [...rankable].sort((a, b) => a.accuracy! - b.accuracy!).slice(0, 5),
      strongSubtopics: [...rankable].sort((a, b) => b.accuracy! - a.accuracy!).slice(0, 5),
      // Unranked and unsliced: the syllabus pages label each sub-topic with the learner's own level, and a
      // top-five slice would blank out sub-topics they have genuinely practised.
      subtopicPerformance: perf,
      subjectSummary: this.subjectSummary(subjects, perf, performance),
    };
  }

  private toPerformance(
    p: Awaited<ReturnType<AnalyticsRepository['subtopicPerformance']>>[number],
    now: Date,
  ): SubtopicPerformanceDto {
    return {
      subtopicId: p.subtopicId,
      subtopicName: p.subtopicName,
      topicName: p.topicName,
      subjectName: p.subjectName,
      subjectId: p.subjectId,
      questions: p.questions,
      accuracy: accuracyPct(p.correct, p.graded),
      paceSeconds: p.paceMs === null ? null : Math.round(p.paceMs / 1000),
      level: p.level,
      lastPracticedDays: p.lastAttemptAt === null ? null : Math.max(0, -daysUntil(p.lastAttemptAt, now)!),
    };
  }

  /**
   * One row per subject the learner can practise, whether or not they have attempted it.
   *
   * A subject with no attempts is present with `null` figures rather than omitted: the Dashboard lists
   * subjects as a progress panel, and a subject vanishing because it has not been started would read as
   * though it were not on the syllabus.
   */
  private subjectSummary(
    subjects: { subjectId: string; name: string; colorHex: string | null }[],
    perf: SubtopicPerformanceDto[],
    raw: Awaited<ReturnType<AnalyticsRepository['subtopicPerformance']>>,
  ): SubjectSummaryDto[] {
    return subjects.map((s) => {
      const mine = perf.filter((p) => p.subjectId === s.subjectId);
      const rows = raw.filter((p) => p.subjectId === s.subjectId);
      const graded = rows.reduce((n, r) => n + r.graded, 0);
      const correct = rows.reduce((n, r) => n + r.correct, 0);
      const levels = mine.map((p) => p.level).filter((l): l is number => l !== null);
      const ranked = mine.filter((p) => p.accuracy !== null && p.questions >= 5);
      const best = [...ranked].sort((a, b) => b.accuracy! - a.accuracy!)[0];
      const worst = [...ranked].sort((a, b) => a.accuracy! - b.accuracy!)[0];
      return {
        subjectId: s.subjectId,
        name: s.name,
        colorHex: s.colorHex,
        questions: rows.reduce((n, r) => n + r.questions, 0),
        accuracy: accuracyPct(correct, graded),
        // The mean band across sub-topics that have one. Explicitly an aggregate of the engine's levels,
        // not a mastery score of its own: one decimal, so the UI can show "L3.4" honestly or round it.
        level: levels.length === 0 ? null : Math.round((levels.reduce((a, b) => a + b, 0) / levels.length) * 10) / 10,
        strongest: best?.subtopicName ?? null,
        needsReview: worst?.subtopicName ?? null,
      };
    });
  }

  // ---------------------------------------------------------------- recommendations

  /**
   * Up to three sub-topics worth opening next, each justified by the learner's own attempts.
   *
   * Deliberately **not** a model. Each item is a fact with a stated reason:
   *   * `continue` — the sub-topic of their most recent session.
   *   * `practice` — their lowest-accuracy sub-topic with enough attempts to mean something.
   *   * `focus` — the sub-topic they have left longest, among those they have started.
   *
   * Fewer than three items is a normal answer, and the right one for a learner with no history: inventing a
   * recommendation for someone who has answered nothing is exactly the fabrication this integration avoids.
   */
  async recommendations(auth: AuthContext): Promise<RecommendationsDto> {
    const now = new Date();
    const [performance, lastSubtopic] = await Promise.all([
      this.repo.subtopicPerformance(auth.tenantId, auth.userId),
      this.repo.lastPractisedSubtopic(auth.tenantId, auth.userId),
    ]);
    if (performance.length === 0) return { items: [] };

    const perf = performance.map((p) => this.toPerformance(p, now));
    const counts = await this.repo.questionCounts(
      auth.tenantId,
      perf.map((p) => p.subtopicId),
    );
    const items: RecommendationDto[] = [];
    const used = new Set<string>();

    const push = (p: SubtopicPerformanceDto | undefined, kind: RecommendationDto['kind'], reason: string) => {
      if (!p || used.has(p.subtopicId)) return;
      used.add(p.subtopicId);
      items.push({
        kind,
        subtopicId: p.subtopicId,
        subtopicName: p.subtopicName,
        topicName: p.topicName,
        subjectName: p.subjectName,
        subjectId: p.subjectId,
        questionCount: counts.get(p.subtopicId) ?? 0,
        accuracy: p.accuracy,
        level: p.level,
        lastPracticedDays: p.lastPracticedDays,
        reason,
      });
    };

    const continueHere = perf.find((p) => p.subtopicId === lastSubtopic);
    if (continueHere) {
      push(continueHere, 'continue', continueHere.level === null ? 'Your most recent session' : `Your most recent session — currently L${continueHere.level}`);
    }

    const rankable = perf.filter((p) => p.accuracy !== null && p.questions >= 5);
    const weakest = [...rankable].sort((a, b) => a.accuracy! - b.accuracy!)[0];
    push(weakest, 'practice', weakest ? `${weakest.accuracy}% accuracy over ${weakest.questions} questions` : '');

    const stalest = [...perf].filter((p) => p.lastPracticedDays !== null).sort((a, b) => b.lastPracticedDays! - a.lastPracticedDays!)[0];
    if (stalest && stalest.lastPracticedDays! > 0) {
      push(stalest, 'focus', `Not practised for ${stalest.lastPracticedDays} day${stalest.lastPracticedDays === 1 ? '' : 's'}`);
    }

    return { items };
  }

  /** Exposed for the unit tests, which assert the median helper is the one in use. */
  static medianOf(values: readonly number[]): number | null {
    return median(values);
  }

  /** Exposed for the unit tests. */
  static factsOf(attempts: readonly AttemptFact[]): { graded: number; correct: number } {
    const graded = gradedOf(attempts);
    return { graded: graded.length, correct: correctOf(graded) };
  }

  async adminStats(auth: AuthContext): Promise<AdminStatsDto> {
    return this.repo.adminStats(auth.tenantId);
  }

  async exportReportPdf(auth: AuthContext, range: AnalyticsRange = 'all'): Promise<Buffer> {
    const user = await this.users.findById(auth.tenantId, auth.userId);
    if (!user) throw AppException.unauthenticated();

    const analyticsData = await this.analytics(auth, { range });
    return this.pdfService.generatePerformanceReport(
      { name: user.displayName, email: user.email },
      analyticsData,
      range,
    );
  }
}
