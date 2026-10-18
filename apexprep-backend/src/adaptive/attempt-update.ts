import { expectedScore, questionK, roundToStorage, studentK, updatedDifficulty, updatedTheta } from './elo';
import { assessGuess, type GuessAssessment } from './guess';
import { clampTheta, evaluateLevel, levelForTheta, type LadderAttempt, type LevelDecision } from './levels';
import type { EngineParams } from './engine-params';
import type { SelectionReason } from './selection';

/**
 * One graded attempt, end to end: expected score → θ and b updates → ladder decision.
 * Pure, so the practice API can compute the whole update inside its transaction and store
 * every input it used (θ before, b at attempt, expected score, K values, config version)
 * for replay.
 *
 * Order of the stated rules:
 *   - a probable guess (incorrect and too fast) is excluded from the ability update and
 *     from the ladder;
 *   - a probe updates θ but does not feed the demotion counters;
 *   - K_s steps down after the student's first attempts and is halved against a barely
 *     calibrated question; K_q steps down once the question is calibrated;
 *   - an ungraded (long-form) attempt moves nothing at all.
 */

export interface AttemptInput {
  /** S ∈ [0,1]; null when the response cannot be graded automatically. */
  score: number | null;
  theta: number;
  level: number;
  difficultyB: number;
  /** `questions.calibration_n` before this attempt. */
  questionCalibrationN: number;
  /** Graded attempts the student already has in this sub-topic. */
  attemptsInSubtopic: number;
  totalTimeMs: number;
  expectedTimeSeconds: number;
  selectionReason: SelectionReason;
  /** The student's ladder history at this level, newest first, excluding this attempt. */
  ladderHistory: readonly LadderAttempt[];
  /** Probable guesses already flagged in this session, excluding this attempt. */
  flaggedGuessesInSession?: number;
}

export interface AttemptUpdate {
  graded: boolean;
  expectedScore: number;
  thetaBefore: number;
  theta: number;
  difficultyBBefore: number;
  difficultyB: number;
  /** The K values actually applied, for the attempt record. */
  kStudent: number;
  kQuestion: number;
  /** Level band θ now falls in; reported alongside the working level. */
  bandLevel: number;
  level: LevelDecision;
  guess: GuessAssessment;
  /** This attempt as it enters the ladder, or null when it does not. */
  ladderEntry: LadderAttempt | null;
  thetaWeight: number;
  questionWeight: number;
  /** True when the session has now hit the flagged-guess limit. */
  pauseSession: boolean;
}

export function applyAttempt(input: AttemptInput, params: EngineParams): AttemptUpdate {
  const expected = expectedScore(input.theta, input.difficultyB, params);
  const correct = (input.score ?? 0) > 0;
  const guess = assessGuess(
    { correct, totalTimeMs: input.totalTimeMs, expectedTimeSeconds: input.expectedTimeSeconds },
    params,
  );
  const flagged = (input.flaggedGuessesInSession ?? 0) + (guess.isProbableGuess ? 1 : 0);
  const pauseSession = flagged >= params.probable_guess.pause_session_after;

  if (input.score === null) {
    return {
      graded: false,
      expectedScore: expected,
      thetaBefore: input.theta,
      theta: input.theta,
      difficultyBBefore: input.difficultyB,
      difficultyB: input.difficultyB,
      kStudent: 0,
      kQuestion: 0,
      bandLevel: levelForTheta(input.theta, params),
      level: { level: input.level, change: 'unchanged', consideredAttempts: 0 },
      guess,
      ladderEntry: null,
      thetaWeight: 0,
      questionWeight: 0,
      pauseSession,
    };
  }

  const isProbe = input.selectionReason === 'probe';
  const thetaWeight = guess.thetaWeight * (isProbe && !params.probe.updates_theta ? 0 : 1);
  const questionWeight = guess.questionWeight * (isProbe && !params.probe.updates_question_b ? 0 : 1);

  const kStudent = studentK({ attemptsInSubtopic: input.attemptsInSubtopic, questionCalibrationN: input.questionCalibrationN }, params);
  const kQuestion = questionK(input.questionCalibrationN, params);

  const theta = roundToStorage(clampTheta(updatedTheta(input.theta, input.score, expected, kStudent, thetaWeight), params));
  const difficultyB = roundToStorage(updatedDifficulty(input.difficultyB, input.score, expected, kQuestion, questionWeight));

  const ladderEntry: LadderAttempt | null = guess.countsTowardsLevel
    ? {
        correct,
        withinExpectedTime: input.totalTimeMs / 1000 <= input.expectedTimeSeconds * params.promotion.within_expected_time_factor,
        isProbe,
      }
    : null;
  const history = ladderEntry ? [ladderEntry, ...input.ladderHistory] : [...input.ladderHistory];

  return {
    graded: true,
    expectedScore: expected,
    thetaBefore: input.theta,
    theta,
    difficultyBBefore: input.difficultyB,
    difficultyB,
    kStudent,
    kQuestion,
    bandLevel: levelForTheta(theta, params),
    level: evaluateLevel(input.level, history, params),
    guess,
    ladderEntry,
    thetaWeight,
    questionWeight,
    pauseSession,
  };
}
