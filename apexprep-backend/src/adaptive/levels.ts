import { bandsByLevel, type EngineParams } from './engine-params';

/**
 * The level ladder, as the requirements state it:
 *
 *   promotion  — `consecutive_correct` correct in a row, each answered within
 *                `within_expected_time_factor` × the question's expected time,
 *                OR `correct_in_window` correct out of the last `window`.
 *   demotion   — `consecutive_incorrect` incorrect in a row,
 *                OR `incorrect_in_window` incorrect out of the last `window`.
 *   guards     — no demotion below L1, no promotion above L5.
 *
 * Probable guesses never reach the ladder (attempt-update.ts drops them), and a probe
 * counts only where the configuration says it does — by default towards promotion but
 * not towards the demotion counters, since a probe is deliberately above the student's
 * level and failing one is not evidence of falling behind.
 */

export type LevelChange = 'promoted' | 'demoted' | 'unchanged';

/** One ladder entry, newest first in the arrays below. */
export interface LadderAttempt {
  correct: boolean;
  /** Answered within `promotion.within_expected_time_factor` × expected time. */
  withinExpectedTime: boolean;
  isProbe: boolean;
}

export interface LevelDecision {
  level: number;
  change: LevelChange;
  /** Which rule fired. */
  rule?: 'consecutive_correct' | 'correct_in_window' | 'consecutive_incorrect' | 'incorrect_in_window';
  /** Set when a change was earned but a guard stopped it. */
  blockedBy?: 'l1_protection' | 'l5_ceiling';
  consideredAttempts: number;
}

/** The level whose band contains θ. Bands are contiguous, half-open [min, max). */
export function levelForTheta(theta: number, params: EngineParams): number {
  const bands = bandsByLevel(params);
  for (const band of bands) {
    const aboveMin = band.theta_min === null || theta >= band.theta_min;
    const belowMax = band.theta_max === null || theta < band.theta_max;
    if (aboveMin && belowMax) return band.level;
  }
  return theta < (bands[0]!.theta_max ?? 0) ? 1 : 5;
}

/** Keeps θ inside the L1 floor and L5 cap when they are configured. */
export function clampTheta(theta: number, params: EngineParams): number {
  const floor = params.l1_protection.theta_floor;
  const cap = params.l5_ceiling.theta_cap;
  let value = theta;
  if (floor !== null) value = Math.max(value, floor);
  if (cap !== null) value = Math.min(value, cap);
  return value;
}

/**
 * θ for a student starting a sub-topic.
 *
 * With `cold_start.seed_from_parent_topic`, a student who has already practised other
 * sub-topics of the same topic starts from that ability rather than from scratch; the
 * caller passes the parent-topic θ (see `parentTopicTheta`). Otherwise the student starts
 * at the middle of the cold-start band, falling back to that level's starting question
 * difficulty when the band is open-ended.
 */
export function coldStartTheta(params: EngineParams, parentTopicTheta: number | null = null): number {
  if (params.cold_start.seed_from_parent_topic && parentTopicTheta !== null) return clampTheta(parentTopicTheta, params);
  const band = bandsByLevel(params).find((b) => b.level === params.cold_start.level)!;
  if (band.theta_min !== null && band.theta_max !== null) return (band.theta_min + band.theta_max) / 2;
  return params.initial_b_by_level[String(params.cold_start.level) as '1' | '2' | '3' | '4' | '5'];
}

/** The parent topic's ability: the mean θ of the student's other sub-topics under it. */
export function parentTopicTheta(siblingThetas: readonly number[]): number | null {
  if (siblingThetas.length === 0) return null;
  return siblingThetas.reduce((a, b) => a + b, 0) / siblingThetas.length;
}

/** Level the student starts a sub-topic at, given their parent-topic ability. */
export function coldStartLevel(params: EngineParams, parentTopicThetaValue: number | null = null): number {
  return params.cold_start.seed_from_parent_topic && parentTopicThetaValue !== null
    ? levelForTheta(clampTheta(parentTopicThetaValue, params), params)
    : params.cold_start.level;
}

function promotionRule(history: readonly LadderAttempt[], params: EngineParams): LevelDecision['rule'] | undefined {
  const p = params.promotion;
  const forPromotion = history.filter((a) => !a.isProbe || params.probe.counts_towards_promotion);

  const streak = forPromotion.slice(0, p.consecutive_correct);
  if (streak.length === p.consecutive_correct && streak.every((a) => a.correct && a.withinExpectedTime)) return 'consecutive_correct';

  const window = forPromotion.slice(0, p.window);
  if (window.length === p.window && window.filter((a) => a.correct).length >= p.correct_in_window) return 'correct_in_window';

  return undefined;
}

function demotionRule(history: readonly LadderAttempt[], params: EngineParams): LevelDecision['rule'] | undefined {
  const d = params.demotion;
  const forDemotion = history.filter((a) => !a.isProbe || params.probe.counts_towards_demotion);

  const streak = forDemotion.slice(0, d.consecutive_incorrect);
  if (streak.length === d.consecutive_incorrect && streak.every((a) => !a.correct)) return 'consecutive_incorrect';

  const window = forDemotion.slice(0, d.window);
  if (window.length === d.window && window.filter((a) => !a.correct).length >= d.incorrect_in_window) return 'incorrect_in_window';

  return undefined;
}

/** Applies the ladder to the student's recent attempts at this level, newest first. */
export function evaluateLevel(currentLevel: number, history: readonly LadderAttempt[], params: EngineParams): LevelDecision {
  const considered = history.length;

  const promotion = promotionRule(history, params);
  if (promotion) {
    if (currentLevel >= 5) {
      return params.l5_ceiling.block_promotion
        ? { level: 5, change: 'unchanged', rule: promotion, blockedBy: 'l5_ceiling', consideredAttempts: considered }
        : { level: 5, change: 'unchanged', rule: promotion, consideredAttempts: considered };
    }
    return { level: currentLevel + 1, change: 'promoted', rule: promotion, consideredAttempts: considered };
  }

  const demotion = demotionRule(history, params);
  if (demotion) {
    if (currentLevel <= 1) {
      return params.l1_protection.block_demotion
        ? { level: 1, change: 'unchanged', rule: demotion, blockedBy: 'l1_protection', consideredAttempts: considered }
        : { level: 1, change: 'unchanged', rule: demotion, consideredAttempts: considered };
    }
    return { level: currentLevel - 1, change: 'demoted', rule: demotion, consideredAttempts: considered };
  }

  return { level: currentLevel, change: 'unchanged', consideredAttempts: considered };
}
