import type { EngineParams } from './engine-params';

/**
 * The Elo core:
 *
 *   E  = 1 / (1 + 10^((b − θ) / scale))
 *   θ' = θ + K_s (S − E)
 *   b' = b + K_q (E − S)
 *
 * K is not a single number. Per the stated requirements:
 *   - K_s is larger for a student's first `k_student.initial_attempts` attempts in a
 *     sub-topic, and is scaled down against a question that is barely calibrated
 *     (fewer than `low_calibration_threshold` attempts), because such a b is weak evidence.
 *   - K_q is larger while the question itself is uncalibrated (`calibration_n` below
 *     `k_question.calibrated_after`), so a new question finds its level quickly.
 *
 * Pure arithmetic: no clamping and no level logic — levels.ts and attempt-update.ts
 * combine these with the ladder and the guess rules.
 */

/** Probability that a student of ability θ answers a question of difficulty b correctly. */
export function expectedScore(theta: number, b: number, params: Pick<EngineParams, 'elo_scale'>): number {
  return 1 / (1 + 10 ** ((b - theta) / params.elo_scale));
}

export interface StudentKInput {
  /** Graded attempts the student already has in this sub-topic. */
  attemptsInSubtopic: number;
  /** `questions.calibration_n` of the question being answered. */
  questionCalibrationN: number;
}

/** K_s for this attempt: the stepped schedule, halved against an uncalibrated question. */
export function studentK(input: StudentKInput, params: Pick<EngineParams, 'k_student'>): number {
  const k = params.k_student;
  const base = input.attemptsInSubtopic < k.initial_attempts ? k.initial : k.steady;
  return input.questionCalibrationN < k.low_calibration_threshold ? base * k.low_calibration_factor : base;
}

/** K_q for this attempt: larger until the question has enough attempts behind it. */
export function questionK(calibrationN: number, params: Pick<EngineParams, 'k_question'>): number {
  const k = params.k_question;
  return calibrationN < k.calibrated_after ? k.uncalibrated : k.steady;
}

/** θ' after one graded response. `weight` scales the step (probes, probable guesses). */
export function updatedTheta(theta: number, score: number, expected: number, k: number, weight = 1): number {
  return theta + weight * k * (score - expected);
}

/** b' after one graded response: a question gets easier when students beat it. */
export function updatedDifficulty(b: number, score: number, expected: number, k: number, weight = 1): number {
  return b + weight * k * (expected - score);
}

/**
 * The difficulty at which this student's chance of success is `target_success`:
 *
 *   b* = θ + scale · log10(1/p − 1)
 */
export function targetDifficulty(theta: number, params: Pick<EngineParams, 'elo_scale' | 'target_success'>): number {
  return theta + params.elo_scale * Math.log10(1 / params.target_success - 1);
}

/** Rounds to the 2 decimals `numeric(8,2)` stores, so reads match what was written. */
export function roundToStorage(value: number): number {
  return Math.round(value * 100) / 100;
}
