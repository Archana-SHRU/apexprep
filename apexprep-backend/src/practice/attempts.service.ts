import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { applyAttempt, type EngineParams, type LadderAttempt } from '../adaptive';
import type { AuthContext } from '../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { sessions, type AbilityScoreRow, type AttemptRow, type SessionRow } from '../database/schema';
import { EngineConfigService, type ActiveEngineConfig } from '../engine-config/engine-config.service';
import { QuestionsRepository } from '../questions/questions.repository';
import type { AttemptResultDto, SubmitAttemptDto } from './dto/practice.dto';
import { gradeResponse, revealedAnswer, type StudentResponse } from './grading';
import { PracticeRepository, type QuestionForGrading } from './practice.repository';
import { PracticeService, toProgressDto } from './practice.service';

/**
 * How far past the time that has actually passed since the question was served a reported time may reach.
 * The student's browser measures the time on the question, and honest browsers report less than the server saw
 * (the question was served before it was shown); this allowance covers timer rounding and nothing more.
 */
export const REPORTED_TIME_TOLERANCE_MS = 3_000;

/**
 * The time the engine should believe. The engine's pace rules read it — a rushed wrong answer is not counted
 * against the student, a fast right one can promote them — so a browser must not be able to claim a time the
 * clock cannot account for. The upper bound is the server's own measurement; below it the report is kept, because
 * the browser legitimately leaves out time the tab was not in front of the student.
 */
export function trustedTimeMs(reportedMs: number, servedForMs: number | null): number {
  if (servedForMs === null) return reportedMs;
  return Math.min(reportedMs, servedForMs + REPORTED_TIME_TOLERANCE_MS);
}

/**
 * Attempt submission: the one place a student's answer is graded and the one place the
 * adaptive engine is applied.
 *
 * Order inside a single transaction:
 *   1. lock the served item and the session — an item can be answered exactly once
 *   2. grade the response **server-side** from the answer key (nothing about correctness
 *      is read from the request)
 *   3. hand θ, b, the timings and the ladder history to `applyAttempt` (Phase 4 engine)
 *   4. insert the immutable attempt row with everything needed to replay the update
 *   5. move the question's own difficulty and calibration count
 *   6. write the ability projection (θ, level, counters, placement, ladder reset)
 *
 * Idempotency: the client's key is unique per student in the database, and a replay
 * returns the stored attempt instead of grading again.
 */
@Injectable()
export class AttemptsService {
  private readonly logger = new Logger(AttemptsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: PracticeRepository,
    private readonly practice: PracticeService,
    private readonly engineConfig: EngineConfigService,
    private readonly questions: QuestionsRepository,
    private readonly audit: AuditService,
  ) {}

  async submit(auth: AuthContext, dto: SubmitAttemptDto, headerKey?: string): Promise<AttemptResultDto> {
    const idempotencyKey = (headerKey ?? dto.idempotencyKey ?? '').trim();
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) {
      throw AppException.validation([
        { field: 'Idempotency-Key', message: 'send an Idempotency-Key header (8-128 characters of letters, digits, _ . : or -)' },
      ]);
    }

    const replay = await this.repo.findAttemptByIdempotencyKey(auth.tenantId, auth.userId, idempotencyKey);
    if (replay) {
      // A replay has to be a replay *of this answer*. Reusing one key for a second question used to
      // return the first question's result with `replayed: true` — so the student's second answer
      // was never graded, its served item stayed `served` for ever, and the response said success.
      // The stored attempt names the item it graded, so the mismatch is detectable and refusable.
      if (replay.sessionItemId !== dto.sessionItemId) {
        throw AppException.conflict(
          'this Idempotency-Key was already used for a different question; use a fresh key for each answer',
          'IDEMPOTENCY_KEY_REUSED',
        );
      }
      return this.replayResult(auth, replay);
    }

    const config = await this.engineConfig.requireActive(auth.tenantId);
    const params = config.params;

    const outcome = await this.db.transaction(async (tx) => {
      const item = await this.repo.findItem(auth.tenantId, dto.sessionItemId, tx, true);
      if (!item || item.userId !== auth.userId) throw AppException.notFound('Served question not found');
      if (item.status === 'answered') throw AppException.conflict('This question has already been answered', 'INVALID_STATE');
      if (item.status !== 'served') throw AppException.conflict(`This question was ${item.status}`, 'INVALID_STATE');

      const session = await this.repo.findSession(auth.tenantId, auth.userId, item.sessionId, tx, true);
      if (!session) throw AppException.notFound('Practice session not found');
      if (session.status !== 'active') throw AppException.conflict(`This session is ${session.status}`, 'INVALID_STATE');

      const flaggedBefore = await this.repo.countProbableGuesses(auth.tenantId, session.id, tx);
      if (flaggedBefore >= params.probable_guess.pause_session_after) {
        throw AppException.conflict('This session is paused after repeated rushed answers', 'SESSION_PAUSED');
      }

      const question = await this.repo.questionForGrading(auth.tenantId, item.questionId, tx);
      if (!question) throw AppException.notFound('Question not found');

      // --- the time the engine will believe -----------------------------------
      const servedForMs = await this.repo.msSinceServed(auth.tenantId, item.id, tx);
      const totalTimeMs = trustedTimeMs(dto.totalTimeMs, servedForMs);
      const ttfiMs = dto.ttfiMs === undefined ? null : Math.min(dto.ttfiMs, totalTimeMs);
      if (totalTimeMs < dto.totalTimeMs) {
        this.logger.warn(
          `attempt on item ${item.id}: reported ${dto.totalTimeMs} ms but the question had been open ${servedForMs} ms; using ${totalTimeMs} ms`,
        );
      }

      // --- server-side grading ------------------------------------------------
      const graded = gradeResponse(question, dto.response as unknown as StudentResponse);
      if (!graded.ok) throw AppException.validation([{ field: graded.field, message: graded.message }]);

      // --- the Phase 4 engine -------------------------------------------------
      const ability = await this.abilityFor(auth, session, config, tx);
      const history = await this.ladderHistory(auth, session.subtopicId, params, tx);
      const update = applyAttempt(
        {
          score: graded.score,
          theta: ability.theta,
          level: ability.level,
          difficultyB: question.difficultyB,
          questionCalibrationN: question.calibrationN,
          attemptsInSubtopic: ability.gradedCount,
          totalTimeMs,
          expectedTimeSeconds: question.expectedTimeSeconds,
          selectionReason: item.selectionReason,
          ladderHistory: history,
          flaggedGuessesInSession: flaggedBefore,
        },
        params,
      );

      // --- the immutable record ----------------------------------------------
      const attempt = await this.repo.insertAttempt(
        {
          tenantId: auth.tenantId,
          userId: auth.userId,
          questionId: question.id,
          questionVersion: question.version,
          subtopicId: session.subtopicId,
          sessionId: session.id,
          sessionItemId: item.id,
          idempotencyKey,
          response: graded.stored,
          outcome: graded.outcome,
          score: graded.score,
          ttfiMs,
          totalTimeMs,
          answerChanges: dto.answerChanges ?? 0,
          hintCount: dto.hintCount ?? 0,
          difficultyBAtAttempt: question.difficultyB,
          difficultyLabelAtAttempt: question.difficultyLabel,
          thetaBefore: ability.theta,
          expectedScore: Number(update.expectedScore.toFixed(4)),
          // The two engine inputs that live on mutable question columns (migration 0010),
          // without which this update could not be replayed later.
          calibrationNAtAttempt: question.calibrationN,
          expectedTimeSecondsAtAttempt: question.expectedTimeSeconds,
          engineConfigId: config.id,
          deviceType: session.deviceType,
          isProbe: item.selectionReason === 'probe',
          isPlacement: item.selectionReason === 'placement',
          probableGuess: update.guess.isProbableGuess,
          clientSubmittedAt: dto.clientSubmittedAt ? new Date(dto.clientSubmittedAt) : null,
        },
        tx,
      );

      await this.repo.updateItem(auth.tenantId, item.id, { status: 'answered', answeredAt: sql`now()` }, tx);
      const updatedSession = await this.repo.updateSession(
        auth.tenantId,
        session.id,
        { answeredCount: sql`${sessions.answeredCount} + 1`, lastActivityAt: sql`now()` },
        tx,
      );

      // --- the question's own calibration ------------------------------------
      if (update.graded && update.questionWeight > 0) {
        await this.repo.applyQuestionCalibration(auth.tenantId, question.id, update.difficultyB, tx);
        // §6.4: once `calibration_n` reaches the stated threshold, the admin's estimate of how long
        // this question takes gives way to the observed median. It runs after the bump above, so the
        // attempt just recorded counts towards its own threshold, and after the attempt insert, so
        // that row's `expected_time_seconds_at_attempt` still holds the value the student was
        // actually measured against. Nothing here touches `questions.version`.
        const recalibrated = await this.repo.recalibrateExpectedTime(
          auth.tenantId,
          question.id,
          {
            minAttempts: params.expected_time.recalibrate_after_attempts,
            excludeProbableGuesses: params.expected_time.exclude_probable_guesses,
            minSeconds: params.expected_time.min_seconds,
            maxSeconds: params.expected_time.max_seconds,
          },
          tx,
        );
        if (recalibrated !== null) {
          // Worth an audit row: it changes what every later student is measured against, and an
          // admin who set 90 seconds and finds 140 stored needs to be able to see why.
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              action: 'question.expected_time_recalibrated',
              entityType: 'question',
              entityId: question.id,
              // The engine did this, not the student who happened to submit the 30th attempt.
              actor: null,
              before: { expectedTimeSeconds: question.expectedTimeSeconds },
              after: { expectedTimeSeconds: recalibrated, calibrationN: question.calibrationN + 1 },
            },
            tx,
          );
        }
      }

      // --- the ability projection --------------------------------------------
      const levelChanged = update.level.change !== 'unchanged';
      const inPlacementPhase = item.selectionReason === 'placement' || item.selectionReason === 'cold_start';
      const ladderEntry = update.ladderEntry;
      const nextAbility = await this.repo.updateAbility(
        auth.tenantId,
        ability.id,
        {
          theta: update.theta,
          level: update.level.level,
          attemptsCount: ability.attemptsCount + 1,
          gradedCount: ability.gradedCount + (update.graded ? 1 : 0),
          correctCount: ability.correctCount + (graded.outcome === 'correct' ? 1 : 0),
          consecutiveCorrect: ladderEntry ? (ladderEntry.correct ? ability.consecutiveCorrect + 1 : 0) : ability.consecutiveCorrect,
          consecutiveIncorrect: ladderEntry ? (ladderEntry.correct ? 0 : ability.consecutiveIncorrect + 1) : ability.consecutiveIncorrect,
          // The cold-start question is the first question of the placement phase, so it
          // counts here too: placement then completes exactly when the engine stops
          // choosing 'placement' (both are driven by the graded-attempt count).
          placementAnswered: ability.placementAnswered + (inPlacementPhase ? 1 : 0),
          placementStatus: this.placementStatusAfter(ability, inPlacementPhase, params),
          lastAttemptId: attempt.id,
          lastAttemptAt: attempt.createdAt,
          engineConfigId: config.id,
          // Exact to the microsecond, so this attempt cannot count towards the next change.
          ...(levelChanged ? { ladderResetAt: this.repo.attemptCreatedAt(auth.tenantId, attempt.id) } : {}),
        },
        tx,
      );

      const solution = await this.questions.approvedSolution(auth.tenantId, question.id, tx);

      return {
        attempt,
        question,
        session: updatedSession ?? session,
        ability: nextAbility ?? ability,
        update,
        explanationAvailable: Boolean(solution),
      };
    });

    return {
      attemptId: outcome.attempt.id,
      questionId: outcome.attempt.questionId,
      questionVersion: outcome.attempt.questionVersion,
      outcome: outcome.attempt.outcome,
      score: outcome.attempt.score,
      correct: outcome.attempt.outcome === 'ungraded' ? null : outcome.attempt.outcome === 'correct',
      revealedAnswer: revealedAnswer(outcome.question),
      explanationAvailable: outcome.explanationAvailable,
      probableGuess: outcome.attempt.probableGuess,
      progress: toProgressDto(outcome.ability),
      level: {
        change: outcome.update.level.change,
        rule: outcome.update.level.rule ?? null,
        blockedBy: outcome.update.level.blockedBy ?? null,
      },
      session: await this.practice.toSessionDto(outcome.session, { resumed: false }, params),
      replayed: false,
    };
  }

  // ---------------------------------------------------------------- internals

  /** A replayed key returns the stored attempt; nothing is graded or updated again. */
  private async replayResult(auth: AuthContext, attempt: AttemptRow): Promise<AttemptResultDto> {
    const [question, ability, session, solution] = await Promise.all([
      this.repo.questionForGrading(auth.tenantId, attempt.questionId),
      this.repo.findAbility(auth.tenantId, auth.userId, attempt.subtopicId),
      this.repo.findSession(auth.tenantId, auth.userId, attempt.sessionId),
      this.questions.approvedSolution(auth.tenantId, attempt.questionId),
    ]);
    if (!question || !ability || !session) throw AppException.notFound('Attempt not found');
    return {
      attemptId: attempt.id,
      questionId: attempt.questionId,
      questionVersion: attempt.questionVersion,
      outcome: attempt.outcome,
      score: attempt.score,
      correct: attempt.outcome === 'ungraded' ? null : attempt.outcome === 'correct',
      revealedAnswer: revealedAnswer(question),
      explanationAvailable: Boolean(solution),
      probableGuess: attempt.probableGuess,
      progress: toProgressDto(ability),
      level: { change: 'unchanged', rule: null, blockedBy: null },
      session: await this.practice.toSessionDto(session, { resumed: false }),
      replayed: true,
    };
  }

  private async abilityFor(auth: AuthContext, session: SessionRow, config: ActiveEngineConfig, tx: Executor): Promise<AbilityScoreRow> {
    const existing = await this.repo.findAbility(auth.tenantId, auth.userId, session.subtopicId, tx, true);
    if (existing) return existing;
    // Defensive: a session always creates the row, so this only fires if it was removed.
    return (await this.practice.abilityForSession(auth, session.subtopicId, config, tx)).ability;
  }

  /**
   * The ladder window from the immutable attempts: graded, non-guess attempts since the
   * level last changed, newest first, with the speed condition applied per attempt.
   */
  private async ladderHistory(auth: AuthContext, subtopicId: string, params: EngineParams, tx: Executor): Promise<LadderAttempt[]> {
    const depth = Math.max(
      params.promotion.window,
      params.demotion.window,
      params.promotion.consecutive_correct,
      params.demotion.consecutive_incorrect,
    );
    const rows = await this.repo.ladderHistory(auth.tenantId, auth.userId, subtopicId, depth, tx);
    return rows.map((r) => ({
      correct: (r.score ?? 0) > 0,
      withinExpectedTime: r.totalTimeMs / 1000 <= r.expectedTimeSeconds * params.promotion.within_expected_time_factor,
      isProbe: r.isProbe,
    }));
  }

  private placementStatusAfter(ability: AbilityScoreRow, answeredPlacement: boolean, params: EngineParams): AbilityScoreRow['placementStatus'] {
    if (!answeredPlacement || ability.placementStatus === 'completed' || ability.placementStatus === 'skipped') return ability.placementStatus;
    const answered = ability.placementAnswered + 1;
    return answered >= params.placement.question_count ? 'completed' : 'in_progress';
  }
}

export type { QuestionForGrading };
