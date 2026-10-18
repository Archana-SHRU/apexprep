import { targetDifficulty } from './elo';
import { levelWidth, type EngineParams } from './engine-params';
import { daysBetween } from './time';

/**
 * What to serve next. Pure: the caller (the practice API, Phase 5) loads the candidate
 * pool for the sub-topic and passes it in; this decides which one and why.
 *
 * Order of the rules, all parameterised:
 *   1. cold start   — the student's first question in this sub-topic
 *   2. placement    — the first `placement.question_count` questions, when enabled
 *   3. probe        — every `probe.every_n`-th question of the session, aimed
 *                     `probe.levels_above_target` level widths above the usual target
 *   4. adaptive     — everything else
 *
 * Eligibility removes questions attempted inside `exclusion_days` (and skipped ones when
 * `exclusion_includes_skipped`), plus near-duplicates of questions already seen. When
 * fewer than `content_gap.min_eligible` remain the result is flagged as a content gap, and
 * when nothing remains the caller may widen to the topic or fall back deliberately.
 */

export type SelectionReason = 'cold_start' | 'placement' | 'adaptive' | 'probe' | 'content_gap_fallback';

export interface Candidate {
  id: string;
  difficultyB: number;
  difficultyLabel: number;
  duplicateGroupId: string | null;
  /** When this student last answered this question (null: never). */
  lastAttemptedAt: Date | null;
  /** When it was last served to this student without an answer (skipped or abandoned). */
  lastSkippedAt: Date | null;
}

export interface SelectionState {
  /** 1-based position of the question about to be served in this session. */
  position: number;
  theta: number;
  level: number;
  /** Graded attempts this student already has in this sub-topic (0 means cold start). */
  attemptsInSubtopic: number;
  /** Duplicate groups the student has seen, with when they saw them. */
  seenDuplicateGroups?: readonly { groupId: string; seenAt: Date }[];
  now: Date;
}

export interface Selection {
  questionId: string;
  reason: SelectionReason;
  /** The difficulty the selector aimed for. */
  targetB: number;
  thetaAtServe: number;
  difficultyBAtServe: number;
}

export interface SelectionResult {
  selection: Selection | null;
  eligibleCount: number;
  /** Fewer eligible questions than `content_gap.min_eligible`. */
  contentGap: boolean;
  /** The configured response to that gap: widen the pool to the parent topic. */
  widenToParentTopic: boolean;
  /** The configured response to that gap: raise a content-gap alert for admins. */
  raiseContentGapAlert: boolean;
  /** Nothing eligible at all: widen to the topic, or use `fallbackSelection`. */
  exhausted: boolean;
}

/** The reason that applies at this point of the session. */
export function selectionReason(state: SelectionState, params: EngineParams): Exclude<SelectionReason, 'content_gap_fallback'> {
  if (state.attemptsInSubtopic === 0 && state.position === 1) return 'cold_start';
  if (params.placement.enabled && state.attemptsInSubtopic < params.placement.question_count) return 'placement';
  if (state.position % params.probe.every_n === 0) return 'probe';
  return 'adaptive';
}

/**
 * Difficulty a probe aims at: `probe.levels_above_target` level widths above the student's
 * normal target difficulty — half a level above target under the stated requirements.
 */
export function probeTargetB(theta: number, level: number, params: EngineParams): number {
  return targetDifficulty(theta, params) + params.probe.levels_above_target * levelWidth(params, level);
}

/** Questions this student may be served right now. */
export function filterEligible(candidates: readonly Candidate[], state: SelectionState, params: EngineParams): Candidate[] {
  const seen = state.seenDuplicateGroups ?? [];
  return candidates.filter((c) => {
    if (c.lastAttemptedAt && daysBetween(c.lastAttemptedAt, state.now) < params.exclusion_days) return false;
    if (params.exclusion_includes_skipped && c.lastSkippedAt && daysBetween(c.lastSkippedAt, state.now) < params.exclusion_days) return false;
    if (c.duplicateGroupId) {
      const group = seen.find((g) => g.groupId === c.duplicateGroupId);
      if (group && daysBetween(group.seenAt, state.now) < params.near_duplicate.exclude_days) return false;
    }
    return true;
  });
}

/** Closest to the target difficulty; ties broken by id so the choice is reproducible. */
export function rankByTarget(candidates: readonly Candidate[], targetB: number): Candidate[] {
  return [...candidates].sort((a, b) => {
    const d = Math.abs(a.difficultyB - targetB) - Math.abs(b.difficultyB - targetB);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

export function selectNextQuestion(state: SelectionState, candidates: readonly Candidate[], params: EngineParams): SelectionResult {
  const eligible = filterEligible(candidates, state, params);
  const contentGap = eligible.length < params.content_gap.min_eligible;
  const gapResponse = {
    widenToParentTopic: contentGap && params.content_gap.widen_to_topic,
    raiseContentGapAlert: contentGap && params.content_gap.open_review_task,
  };
  if (eligible.length === 0) return { selection: null, eligibleCount: 0, contentGap: true, ...gapResponse, exhausted: true };

  const reason = selectionReason(state, params);
  const targetB = reason === 'probe' ? probeTargetB(state.theta, state.level, params) : targetDifficulty(state.theta, params);
  const best = rankByTarget(eligible, targetB)[0]!;

  return {
    selection: { questionId: best.id, reason, targetB, thetaAtServe: state.theta, difficultyBAtServe: best.difficultyB },
    eligibleCount: eligible.length,
    contentGap,
    ...gapResponse,
    exhausted: false,
  };
}

/**
 * Deliberate fallback when nothing is eligible: the question seen longest ago (never-seen
 * first), marked `content_gap_fallback` so reports can tell it apart from adaptive serving.
 */
export function fallbackSelection(candidates: readonly Candidate[], state: SelectionState, params: EngineParams): Selection | null {
  if (candidates.length === 0) return null;
  const lastSeen = (c: Candidate): number =>
    Math.max(c.lastAttemptedAt?.getTime() ?? 0, params.exclusion_includes_skipped ? (c.lastSkippedAt?.getTime() ?? 0) : 0);
  const oldest = [...candidates].sort((a, b) => {
    const d = lastSeen(a) - lastSeen(b);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  })[0]!;
  return {
    questionId: oldest.id,
    reason: 'content_gap_fallback',
    targetB: targetDifficulty(state.theta, params),
    thetaAtServe: state.theta,
    difficultyBAtServe: oldest.difficultyB,
  };
}
