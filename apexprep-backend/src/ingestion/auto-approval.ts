import { createHash } from 'node:crypto';
import { isOlympiadTrack, type TrackIdentity } from '../common/learning/track-identity';
import type { IngestionParams } from './ingestion-params';

/**
 * Whether a piece of ingested content may be approved without a human, and whether it is one of
 * the sampled ones.
 *
 * Five rules. Four come from the requirements; the fifth is the line this codebase draws around models:
 *
 *   1. Only high-confidence content is eligible — every confidence recorded for it must be at or
 *      above `auto_approval.min_confidence`.
 *   2. OCR'd and low-confidence content always needs a person.
 *   3. Olympiad L5 content always needs a person, whatever its confidence. "Olympiad" means
 *      `tracks.kind = 'olympiad'` (migration 0013), not a track name that happens to say so.
 *   4. `audit_sample_rate` of what is auto-approved is sampled for audit — 5% as stated.
 *   5. Content a model read or rewrote is never eligible, whatever confidence the model reported about itself.
 *
 * Pure and deterministic, including the sampling. That last part matters: sampling with
 * `Math.random()` would make a run unreproducible, so whether an item is sampled is a hash of its
 * own id. The same item is always sampled or always not, the rate holds across many items because
 * the hash is uniform, and a test can assert the decision instead of stubbing a random number
 * generator.
 */

export interface AutoApprovalInput {
  /** The block or question id: what the sampling decision is keyed on. */
  entityId: string;
  /** Every confidence recorded for this item (classification, mapping, extraction, matching). */
  confidences: readonly number[];
  fromOcr: boolean;
  /** A model read or rewrote this content. What a model produces is never approved without a person. */
  aiAssisted?: boolean;
  /** L1-L5, or null when the item has no difficulty (a theory block). */
  difficultyLabel: number | null;
  /** The track this content sits under: its `kind` decides the Olympiad rule, not its name. */
  track: TrackIdentity;
  /** True when any gate is currently failing: never auto-approve content that cannot publish. */
  gatesPass: boolean;
  /** Open review tasks naming this item. */
  openCriticalTasks: number;
}

export type AutoApprovalDecision =
  | { autoApprove: true; sampledForAudit: boolean; reason: string; lowestConfidence: number }
  | { autoApprove: false; reason: string; lowestConfidence: number };

export function decideAutoApproval(input: AutoApprovalInput, params: IngestionParams): AutoApprovalDecision {
  const auto = params.ingestion.auto_approval;
  const lowestConfidence = input.confidences.length === 0 ? 0 : round3(Math.min(...input.confidences));
  const no = (reason: string): AutoApprovalDecision => ({ autoApprove: false, reason, lowestConfidence });

  if (!auto.enabled) return no('auto-approval is switched off for this organisation');
  if (!input.gatesPass) return no('a publication quality gate is failing');
  if (input.openCriticalTasks > 0) return no(`${input.openCriticalTasks} open review task(s) name this content`);
  if (input.fromOcr && auto.require_review_for_ocr) return no('the text came from OCR, which always needs a person');
  if (input.aiAssisted) return no('a model read or rewrote this content, which always needs a person');
  if (input.confidences.length === 0) return no('nothing recorded a confidence for this content');
  if (lowestConfidence < auto.min_confidence) {
    return no(`its lowest confidence ${lowestConfidence} is below the ${auto.min_confidence} auto-approval floor`);
  }
  if (input.difficultyLabel !== null && auto.mandatory_review_difficulty_labels.includes(input.difficultyLabel)) {
    // Since migration 0013 this is `tracks.kind = 'olympiad'`, with the slug patterns kept only as
    // a fallback for tracks that predate the column — see isOlympiadTrack for why both.
    const olympiad = isOlympiadTrack(input.track, auto.mandatory_review_track_slug_patterns);
    // The stated rule is Olympiad *and* L5. A configuration with no track patterns and an
    // uncategorised track makes the difficulty rule apply everywhere, which is a stricter reading
    // and still safe.
    if (olympiad || (input.track.kind === null && auto.mandatory_review_track_slug_patterns.length === 0)) {
      return no(`L${input.difficultyLabel} content on "${input.track.slug}" always needs a person`);
    }
  }

  return {
    autoApprove: true,
    sampledForAudit: isSampled(input.entityId, auto.audit_sample_rate),
    reason: `every confidence is at or above ${auto.min_confidence} (lowest ${lowestConfidence}) and no rule holds it back`,
    lowestConfidence,
  };
}

/**
 * Deterministic sampling: the first 8 hex digits of sha256(id) as a fraction of 2^32, compared
 * with the rate. Uniform, reproducible, and independent of how many items came before.
 */
export function isSampled(entityId: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const digest = createHash('sha256').update(entityId).digest();
  const value = digest.readUInt32BE(0) / 0x1_0000_0000;
  return value < rate;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
