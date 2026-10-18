import { applyAttempt, levelForTheta, type EngineParams, type LadderAttempt, type SelectionReason } from '../adaptive';
import type { AttemptOutcome, PlacementStatus } from '../database/schema';

/**
 * Rebuilding `ability_scores` from the immutable `attempts` rows.
 *
 * `ability_scores` is a projection: it is what you get by replaying one student's attempts
 * in one sub-topic, in (created_at, id) order, through the same Phase 4 engine that wrote
 * them. Nothing here re-implements an adaptive rule — every step goes through
 * `applyAttempt`, exactly as the live submission path does — so a rebuild cannot drift
 * from the engine by construction.
 *
 * Two things a replay cannot read off an attempt, and how each is handled honestly:
 *
 *   * **Inactivity decay** is applied when a session opens, not when a question is
 *     answered, so it leaves no attempt row. It is still visible as a gap: the θ this
 *     replay computed after attempt n does not match the `theta_before` that attempt n+1
 *     recorded. The replay follows the recorded value (an immutable fact), re-derives the
 *     level from it the way the live path does, and reports the difference as
 *     `outOfBandThetaAdjustment` — the gap is surfaced, never hidden.
 *
 *   * **Attempts written before migration 0010** carry no `calibrationNAtAttempt` or
 *     `expectedTimeSecondsAtAttempt`, so the K factors and the speed condition that
 *     produced them are unknown. Those rows are counted in `unreplayableAttempts` and the
 *     result is marked `exact: false`. No value is ever guessed for them.
 *
 * One projection value is likewise outside the attempt stream: `placement_status` of
 * 'skipped' means a student was excused from placement, which no attempt records. A replay
 * therefore produces only 'not_started', 'in_progress' or 'completed'.
 */

/** One immutable attempt, as the replay needs it. Every field is stored on the row. */
export interface ReplayAttempt {
  id: string;
  createdAt: Date;
  outcome: AttemptOutcome;
  score: number | null;
  totalTimeMs: number;
  thetaBefore: number;
  difficultyBAtAttempt: number;
  calibrationNAtAttempt: number | null;
  expectedTimeSecondsAtAttempt: number | null;
  probableGuess: boolean;
  selectionReason: SelectionReason;
  engineConfigId: string;
}

/** The columns of `ability_scores` that the attempt stream determines. */
export interface ReplayedAbility {
  theta: number;
  level: number;
  attemptsCount: number;
  gradedCount: number;
  correctCount: number;
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  placementAnswered: number;
  placementStatus: PlacementStatus;
  /** `created_at` of the attempt at which the level last changed; null if it never did. */
  ladderResetAt: Date | null;
  lastAttemptId: string | null;
  lastAttemptAt: Date | null;
  /** The engine configuration the last attempt was graded under. */
  engineConfigId: string | null;
}

export interface ReplayResult {
  ability: ReplayedAbility;
  /** False when an attempt could not be replayed faithfully; see the module comment. */
  exact: boolean;
  unreplayableAttempts: number;
  /** θ movement no attempt accounts for — inactivity decay, in practice. */
  outOfBandThetaAdjustment: number;
  /** Attempts whose recomputed probable-guess verdict differs from the stored flag. */
  guessVerdictMismatches: number;
}

/**
 * Replays one student's attempts in one sub-topic.
 *
 * `attempts` must be in (created_at, id) order — the order the engine saw them.
 * `paramsFor` returns the parameters of the `engine_config` version an attempt was graded
 * under, so a history spanning a configuration change replays under the rules of the day.
 */
export function replayAbility(attempts: readonly ReplayAttempt[], paramsFor: (engineConfigId: string) => EngineParams): ReplayResult {
  const first = attempts[0];
  if (!first) throw new Error('replayAbility needs at least one attempt: with none, the cold start alone decides the projection');

  // The level a sub-topic starts at is the band its cold-start θ falls in: whether θ came
  // from `cold_start.level` or was seeded from the parent topic, the two agree at the start.
  let theta = first.thetaBefore;
  let level = levelForTheta(theta, paramsFor(first.engineConfigId));
  let consecutiveCorrect = 0;
  let consecutiveIncorrect = 0;
  let attemptsCount = 0;
  let gradedCount = 0;
  let correctCount = 0;
  let placementAnswered = 0;
  let placementStatus: PlacementStatus = 'not_started';
  let ladderResetAt: Date | null = null;
  /** The ladder window at the current level, newest first — what `ladderHistory` reads back. */
  let window: LadderAttempt[] = [];

  let unreplayable = 0;
  let outOfBand = 0;
  let guessMismatches = 0;
  let lastAttemptId: string | null = null;
  let lastAttemptAt: Date | null = null;
  let engineConfigId: string | null = null;

  for (const attempt of attempts) {
    const params = paramsFor(attempt.engineConfigId);

    // An attempt records the θ the engine actually used. Following it keeps the replay on
    // the real trajectory, and makes any out-of-band adjustment measurable.
    if (attempt.thetaBefore !== theta) {
      outOfBand += attempt.thetaBefore - theta;
      theta = attempt.thetaBefore;
      level = levelForTheta(theta, params); // what the live path does when decay lands
    }

    attemptsCount += 1;
    if (attempt.outcome === 'correct') correctCount += 1;
    lastAttemptId = attempt.id;
    lastAttemptAt = attempt.createdAt;
    engineConfigId = attempt.engineConfigId;

    if (attempt.calibrationNAtAttempt === null || attempt.expectedTimeSecondsAtAttempt === null) {
      unreplayable += 1;
      if (attempt.score !== null) gradedCount += 1;
      continue;
    }

    const depth = Math.max(
      params.promotion.window,
      params.demotion.window,
      params.promotion.consecutive_correct,
      params.demotion.consecutive_incorrect,
    );
    const update = applyAttempt(
      {
        score: attempt.score,
        theta,
        level,
        difficultyB: attempt.difficultyBAtAttempt,
        questionCalibrationN: attempt.calibrationNAtAttempt,
        attemptsInSubtopic: gradedCount,
        totalTimeMs: attempt.totalTimeMs,
        expectedTimeSeconds: attempt.expectedTimeSecondsAtAttempt,
        selectionReason: attempt.selectionReason,
        ladderHistory: window.slice(0, depth),
      },
      params,
    );
    if (update.guess.isProbableGuess !== attempt.probableGuess) guessMismatches += 1;

    theta = update.theta;
    if (update.graded) gradedCount += 1;
    if (update.ladderEntry) {
      window = [update.ladderEntry, ...window];
      consecutiveCorrect = update.ladderEntry.correct ? consecutiveCorrect + 1 : 0;
      consecutiveIncorrect = update.ladderEntry.correct ? 0 : consecutiveIncorrect + 1;
    }
    if (update.level.change !== 'unchanged') {
      level = update.level.level;
      ladderResetAt = attempt.createdAt;
      window = []; // the evidence a rule consumed does not carry to the new level
    }

    // 'skipped' is not reachable from a replay: nothing in the attempt stream records that a
    // student was excused from placement, so only 'not_started' → 'in_progress' → 'completed'
    // can be reproduced here (see the module comment).
    if ((attempt.selectionReason === 'placement' || attempt.selectionReason === 'cold_start') && placementStatus !== 'completed') {
      placementAnswered += 1;
      placementStatus = placementAnswered >= params.placement.question_count ? 'completed' : 'in_progress';
    }
  }

  return {
    ability: {
      theta,
      level,
      attemptsCount,
      gradedCount,
      correctCount,
      consecutiveCorrect,
      consecutiveIncorrect,
      placementAnswered,
      placementStatus,
      ladderResetAt,
      lastAttemptId,
      lastAttemptAt,
      engineConfigId,
    },
    exact: unreplayable === 0,
    unreplayableAttempts: unreplayable,
    outOfBandThetaAdjustment: Number(outOfBand.toFixed(2)),
    guessVerdictMismatches: guessMismatches,
  };
}
