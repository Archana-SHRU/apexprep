import type { BlockStatus } from '../database/schema';
import type { GateResult } from './quality-gates';

/**
 * Where a block stands on the way to publication, as the administrator sees it in the consolidated preview.
 *
 *   * `ready` — nothing holds it back. The single approval publishes it.
 *   * `flagged` — nothing *blocks* it, but a person has not yet looked at it and the rules say one should have: low
 *     confidence, OCR, a model's involvement, a solution match that is not confirmed. The administrator may confirm
 *     the flagged items together when approving — a deliberate act, counted and recorded, never implied.
 *   * `blocked` — something is missing or contradictory that no confirmation can supply: an answer, a difficulty, a
 *     sub-topic, a duplicate decision. It is edited, or left out, and the approval reports it.
 *   * `done` — already published (or, for a draft, already turned into notes).
 *   * `excluded` — rejected or superseded: not part of the document any more.
 *
 * Pure: this decides nothing about the data, it only reads the verdicts the gates and the pipeline already recorded.
 */
export type Readiness = 'ready' | 'flagged' | 'blocked' | 'done' | 'excluded';

export interface ReadinessInput {
  status: BlockStatus;
  kind: string;
  /** A person has looked at the *content* (not merely chosen its sub-topic). */
  contentReviewed: boolean;
  /** A model read, rewrote or wrote it. */
  aiTouched: boolean;
  /** The pipeline's own verdict: no rule held the block back. */
  autoApprovalEligible: boolean;
  autoApprovalReason: string | null;
  /** For a revision-notes draft: it has already been turned into the sub-topic's notes. */
  draftActivated: boolean;
  /** A theory block with too little text to be material on its own: a heading or a page number the segmenter split off. */
  fragment?: boolean;
  /** For a solution block: it is matched to a question and the match is confirmed. */
  solutionAttached: boolean;
  /** The gates as the block stands, with the real reviewed flag and every open task counted. */
  gatesNow: GateResult;
  /** The gates as they would be once a person had confirmed it: reviewed, and only tasks a confirmation cannot clear. */
  gatesIfConfirmed: GateResult;
}

export interface Assessment {
  readiness: Readiness;
  /** Why, in the words the preview shows. Empty for `ready`, `done` and `excluded`. */
  reasons: string[];
}

/** The pipeline's verdict was recorded before a reviewer filled in what was missing, so a "gate is failing" reason no longer describes the block. */
const staleOrMissing = (reason: string | null): boolean => reason === null || /quality gate is failing/.test(reason);

/** Whether a block is a heading or fragment: too little text to be material on its own (the same floor the stem gate uses). */
export const isFragment = (block: { kind: string; normalizedText: string | null; rawText: string }): boolean =>
  block.kind === 'theory' && (block.normalizedText ?? block.rawText).trim().length < 20;

export function assessReadiness(input: ReadinessInput): Assessment {
  if (input.status === 'published' || input.draftActivated) return { readiness: 'done', reasons: [] };
  if (input.status === 'rejected' || input.status === 'superseded') return { readiness: 'excluded', reasons: [] };

  if (input.fragment && input.kind === 'theory') {
    return { readiness: 'excluded', reasons: ['a heading or fragment with nothing to publish on its own: it is left out, or merge it into the text under it'] };
  }
  if (input.kind === 'ambiguous') {
    return { readiness: 'blocked', reasons: ['the pipeline could not tell what this is: say what it is, or leave it out'] };
  }
  if (input.kind === 'solution') {
    return input.solutionAttached
      ? { readiness: 'ready', reasons: [] }
      : { readiness: 'flagged', reasons: ['this solution is not matched to a question with confidence: it will not be attached to anything unless you do'] };
  }

  const confirmable = input.gatesIfConfirmed.ok;
  if (!confirmable) {
    return { readiness: 'blocked', reasons: input.gatesIfConfirmed.failures.map((f) => f.detail) };
  }

  if (input.gatesNow.ok) {
    if (input.contentReviewed || (input.autoApprovalEligible && !input.aiTouched)) return { readiness: 'ready', reasons: [] };
    const why = input.aiTouched
      ? 'a model read, rewrote or wrote this: check it before it reaches students'
      : staleOrMissing(input.autoApprovalReason) ? 'the pipeline held this back when it was read; a person should look at it before it publishes' : input.autoApprovalReason!;
    return { readiness: 'flagged', reasons: [why] };
  }

  // Only things a person's confirmation clears are failing.
  return { readiness: 'flagged', reasons: input.gatesNow.failures.map((f) => f.detail) };
}
