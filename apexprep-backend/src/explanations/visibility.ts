import { isOlympiadTrack, type TrackIdentity } from '../common/learning/track-identity';
import type { ExplanationParams } from './explanation-params';

/**
 * Whether a stored explanation may be shown to a student, and how it must be labelled.
 *
 * Visibility is **derived**, not stored: it follows from the explanation's tier, its status,
 * its grounding and the track it belongs to. That is why Phase 6 adds no `pending_review`
 * status — a column would have to be kept in step with the approval rules by hand, and a
 * stale one would be the difference between a student seeing an unapproved Olympiad
 * explanation and not.
 *
 * The three labels answer the requirement that the response distinguish an official solution
 * from an explanation grounded in official notes from general knowledge. The general-knowledge
 * notice is the product's exact wording and is asserted character-for-character by the tests:
 *
 *     "Not from official notes — pending review"
 *
 * Pure: no database, no clock.
 */

/** The product's wording for a general-knowledge explanation. Do not reword. */
export const GENERAL_KNOWLEDGE_NOTICE = 'Not from official notes — pending review';

export type SourceTier = 'official_solution' | 'rag_grounded' | 'general_ai';
export type ExplanationStatus = 'active' | 'superseded' | 'flagged' | 'rejected';

/** What the student is told about where the explanation came from. */
export type PresentedSource =
  /** The course's own approved solution. */
  | 'official_solution'
  /** Generated, and fully supported by the course notes (grounding >= notes_only_min). */
  | 'notes_only'
  /** Generated, mostly supported by the course notes (grounding >= mostly_notes_min). */
  | 'mostly_notes'
  /** Generated from general subject knowledge; carries the notice above. */
  | 'general_knowledge';

export type BlockedReason =
  | 'failed_validation'
  | 'unpublished_after_reports'
  | 'superseded'
  | 'pending_human_approval';

export interface VisibilityInput {
  tier: SourceTier;
  status: ExplanationStatus;
  /** Null for an official solution, which is not scored. */
  groundingScore: number | null;
  /** When a human approved this explanation, or null. */
  reviewedAt: Date | null;
  /** The track the question sits under, for the mandatory-approval rule. */
  track: TrackIdentity;
}

export type Visibility =
  | { visible: true; source: PresentedSource; notice: string | null; requiresReview: boolean }
  | { visible: false; blockedReason: BlockedReason };

/**
 * Whether this track's generated explanations need a human before a student sees them.
 *
 * The requirements mandate it for Olympiad tracks. Since migration 0013 the authoritative signal is
 * `tracks.kind = 'olympiad'`; `explanation.approval.mandatory_track_slug_patterns` survives only as
 * a fallback for tracks that predate the column. `isOlympiadTrack` carries the full reasoning.
 * An approved official solution is a human artefact already and is never held.
 */
export function requiresHumanApproval(track: TrackIdentity, tier: SourceTier, params: ExplanationParams): boolean {
  if (tier === 'official_solution') return false;
  return isOlympiadTrack(track, params.explanation.approval.mandatory_track_slug_patterns);
}

export function studentVisibility(input: VisibilityInput, params: ExplanationParams): Visibility {
  // Order matters: a blocking status wins over everything, so an explanation that failed
  // validation can never be reasoned into visibility by its tier or its grounding.
  if (input.status === 'rejected') return { visible: false, blockedReason: 'failed_validation' };
  if (input.status === 'flagged') return { visible: false, blockedReason: 'unpublished_after_reports' };
  if (input.status === 'superseded') return { visible: false, blockedReason: 'superseded' };

  if (requiresHumanApproval(input.track, input.tier, params) && input.reviewedAt === null) {
    return { visible: false, blockedReason: 'pending_human_approval' };
  }

  if (input.tier === 'official_solution') {
    return { visible: true, source: 'official_solution', notice: null, requiresReview: false };
  }

  if (input.tier === 'general_ai') {
    return {
      visible: true,
      source: 'general_knowledge',
      notice: GENERAL_KNOWLEDGE_NOTICE,
      requiresReview: params.explanation.approval.review_general_knowledge,
    };
  }

  // rag_grounded. A row is only written at this tier once its score cleared mostly_notes_min,
  // but the band is re-derived here rather than trusted, so a configuration change that
  // raises the bar immediately re-labels what was already stored.
  const { notes_only_min: notesOnly, mostly_notes_min: mostlyNotes } = params.explanation.grounding;
  const score = input.groundingScore ?? 0;
  if (score >= notesOnly) return { visible: true, source: 'notes_only', notice: null, requiresReview: false };
  if (score >= mostlyNotes) return { visible: true, source: 'mostly_notes', notice: null, requiresReview: false };
  return {
    visible: true,
    source: 'general_knowledge',
    notice: GENERAL_KNOWLEDGE_NOTICE,
    requiresReview: params.explanation.approval.review_general_knowledge,
  };
}
