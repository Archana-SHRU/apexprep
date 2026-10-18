import { clampTheta } from './levels';
import { daysBetween } from './time';
import type { EngineParams } from './engine-params';

/**
 * Inactivity decay. After `after_days` without practice in a sub-topic, θ drifts back
 * towards the middle by `theta_points_per_period` for every `per_period_days` that pass,
 * optionally capped and floored. Mastery shown to a student should reflect what they can
 * do today, not what they could do two months ago.
 *
 * Pure and idempotent in the sense that matters: the decay is computed from the elapsed
 * time since the last practice, so applying it twice with the same timestamps gives the
 * same θ. The caller records when it was applied.
 */

export interface DecayInput {
  theta: number;
  /** When the student last answered a question in this sub-topic. */
  lastPracticedAt: Date;
  now: Date;
}

export interface DecayResult {
  theta: number;
  /** Points removed (0 when the student is inside the grace window). */
  decayed: number;
  periods: number;
  daysInactive: number;
}

export function applyInactivityDecay(input: DecayInput, params: EngineParams): DecayResult {
  const d = params.inactivity_decay;
  const daysInactive = Math.max(0, daysBetween(input.lastPracticedAt, input.now));
  if (daysInactive < d.after_days || d.theta_points_per_period === 0) {
    return { theta: input.theta, decayed: 0, periods: 0, daysInactive };
  }

  const periods = Math.floor((daysInactive - d.after_days) / d.per_period_days) + 1;
  let decayed = periods * d.theta_points_per_period;
  if (d.max_total_points !== null) decayed = Math.min(decayed, d.max_total_points);

  let theta = input.theta - decayed;
  if (d.floor_theta !== null) theta = Math.max(theta, d.floor_theta);
  theta = clampTheta(theta, params);

  return { theta, decayed: input.theta - theta, periods, daysInactive };
}
