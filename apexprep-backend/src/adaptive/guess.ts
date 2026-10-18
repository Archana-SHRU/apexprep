import { updateFactor, type EngineParams } from './engine-params';

/**
 * Probable-guess detection, as stated: an answer that is **incorrect** and given in under
 * `max_time_fraction_of_expected` of the question's expected solving time.
 *
 * A flagged attempt is always stored; the configuration decides how much it may move θ and
 * the question's difficulty, and whether it reaches the level ladder. After
 * `pause_session_after` flags in one session the session is paused (enforced by the
 * practice API, decided here).
 */

export interface GuessInput {
  /** Whether the response was graded correct. Partial credit counts as correct if > 0. */
  correct: boolean;
  totalTimeMs: number;
  expectedTimeSeconds: number;
}

export interface GuessAssessment {
  isProbableGuess: boolean;
  /** The time under which an answer to this question looks rushed, in seconds. */
  thresholdSeconds: number;
  tooFast: boolean;
  thetaWeight: number;
  questionWeight: number;
  countsTowardsLevel: boolean;
}

export function assessGuess(input: GuessInput, params: EngineParams): GuessAssessment {
  const p = params.probable_guess;
  const thresholdSeconds = input.expectedTimeSeconds * p.max_time_fraction_of_expected;
  const tooFast = input.totalTimeMs / 1000 < thresholdSeconds;
  const isProbableGuess = tooFast && (!p.requires_incorrect || !input.correct);

  return {
    isProbableGuess,
    thresholdSeconds,
    tooFast,
    thetaWeight: isProbableGuess ? updateFactor(p.theta_update) : 1,
    questionWeight: isProbableGuess ? updateFactor(p.question_update) : 1,
    countsTowardsLevel: isProbableGuess ? p.counts_towards_level : true,
  };
}

/** Whether a session should be paused after this many flagged guesses. */
export function shouldPauseSession(flaggedGuessCount: number, params: EngineParams): boolean {
  return flaggedGuessCount >= params.probable_guess.pause_session_after;
}
