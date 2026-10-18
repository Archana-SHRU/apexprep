/**
 * Where a piece of ingested content came from, kept on the block so a reviewer — and anyone auditing later — can
 * tell four different things apart that look identical on a screen:
 *
 *   * `extracted` — the text and structure were read from the PDF by rules.
 *   * `ai_assisted` — a model helped read it (classify, structure, tidy). The words are still the document's, but
 *     the reading is a model's, so it always needs a person.
 *   * `ai_generated` — a model *wrote* it (a revision-note draft). Nothing in the PDF says it. It is a draft until a
 *     person approves it, and it is never presented as the document's own.
 *   * `inferred` (listed per fact, in `inferred`) — a conclusion drawn from the document rather than printed in it:
 *     an answer taken from a matched solution, a sub-topic taken from the headings above.
 *
 * `edited` is separate because it is true of content from any origin: a person has changed it since.
 *
 * Stored in `content_blocks.content_json.provenance`. `content_blocks.classified_by` already says who classified a
 * block (`rule`, `model`, `human`); this says what else a model or a person did to it.
 */

export type ContentOrigin = 'extracted' | 'ai_assisted' | 'ai_generated';

export interface AiTouch {
  task: string;
  provider: string;
  model: string;
  at: string;
  /** What happened to the block's text: kept as extracted, replaced by a faithful rewrite, or a rewrite refused. */
  textDecision?: 'unchanged' | 'rewritten' | 'rewrite_refused';
}

export interface Provenance {
  origin: ContentOrigin;
  ai: AiTouch | null;
  /** Facts concluded from the document rather than printed in it, in plain words. */
  inferred: string[];
  /** A person has changed the content since it was produced. */
  edited: boolean;
}

export const EXTRACTED: Provenance = { origin: 'extracted', ai: null, inferred: [], edited: false };

export function readProvenance(contentJson: unknown): Provenance {
  const raw = (contentJson !== null && typeof contentJson === 'object' ? (contentJson as { provenance?: unknown }).provenance : undefined) as
    | Partial<Provenance>
    | undefined;
  if (!raw || typeof raw !== 'object') return { ...EXTRACTED, inferred: [] };
  return {
    origin: raw.origin === 'ai_assisted' || raw.origin === 'ai_generated' ? raw.origin : 'extracted',
    ai: raw.ai ?? null,
    inferred: Array.isArray(raw.inferred) ? raw.inferred.filter((x): x is string => typeof x === 'string') : [],
    edited: raw.edited === true,
  };
}

/** True when a model read, rewrote or wrote this content. Such content is never approved without a person. */
export function isAiTouched(contentJson: unknown): boolean {
  return readProvenance(contentJson).origin !== 'extracted';
}

export function withAi(provenance: Provenance, ai: AiTouch): Provenance {
  return { ...provenance, origin: provenance.origin === 'ai_generated' ? 'ai_generated' : 'ai_assisted', ai };
}

export function withInferred(provenance: Provenance, fact: string): Provenance {
  return provenance.inferred.includes(fact) ? provenance : { ...provenance, inferred: [...provenance.inferred, fact] };
}

export function withEdited(provenance: Provenance): Provenance {
  return { ...provenance, edited: true };
}

/** A block's `content_json` with its provenance replaced. */
export function setProvenance(contentJson: Record<string, unknown>, provenance: Provenance): Record<string, unknown> {
  return { ...contentJson, provenance };
}
