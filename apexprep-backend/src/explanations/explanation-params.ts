import { z } from 'zod';

/**
 * The explanation system's tunables, read from the same versioned `engine_config.params`
 * the adaptive engine uses.
 *
 * Why a schema of its own rather than extending `src/adaptive/engine-params.ts`: that schema
 * is what the adaptive engine validates on every attempt, and adding required keys to it
 * would invalidate every configuration version already stored — Phases 1-5 would stop
 * working on existing data. This follows the pattern `initialBSchema` already set in
 * `engine-config.service.ts`: validate exactly the slice this feature needs, and fail loudly
 * naming the missing key rather than substituting a default.
 *
 * **No key has a default here.** A configuration version that does not carry them makes the
 * explanation API answer `422 ENGINE_CONFIG_INVALID` listing what is missing, exactly as the
 * adaptive engine does. Values come from the product requirements; the ones the requirements
 * do not state are listed in docs/DECISIONS.md §C as NOT SPECIFIED and marked there.
 */

const fraction = z.number().min(0).max(1);

export const explanationParamsSchema = z.object({
  rag: z
    .object({
      /** How many chunks are put in front of the model. */
      top_k: z.number().int().min(1).max(50),
      /** The widening ladder, narrowest first. */
      widen_order: z.array(z.enum(['subtopic', 'topic', 'chapter'])).min(1).max(3),
    })
    .strip(),
  explanation: z
    .object({
      chunk: z
        .object({
          /** A chunk below this is merged with its neighbour rather than sent alone. */
          min_tokens: z.number().int().min(50).max(4000),
          /** A block longer than this is split. The requirements state 500-800 tokens. */
          max_tokens: z.number().int().min(100).max(8000),
        })
        .strip(),
      retrieval: z
        .object({
          /**
           * Weight of semantic similarity in the hybrid score; the remainder goes to the
           * keyword score. 0 means keyword-only, 1 means vector-only.
           */
          vector_weight: fraction,
          /** Widen to the next scope while fewer than this many chunks are eligible. */
          min_chunks: z.number().int().min(1).max(50),
          /** A candidate below this fused score is not worth putting in the prompt. */
          min_candidate_score: fraction,
        })
        .strip(),
      grounding: z
        .object({
          /** At or above this, the explanation is served as notes-only. */
          notes_only_min: fraction,
          /** At or above this (and below notes_only_min), it is served as mostly-notes. */
          mostly_notes_min: fraction,
        })
        .strip(),
      approval: z
        .object({
          /**
           * Track slugs (matched as case-insensitive substrings) whose explanations need a
           * human before a student sees them. The requirements mandate this for Olympiad
           * tracks; nothing in the schema marks a track as an Olympiad, so the match is
           * configured here rather than inferred in code.
           */
          mandatory_track_slug_patterns: z.array(z.string().min(1).max(80)).max(50),
          /** Whether a general-knowledge explanation always opens a review task. */
          review_general_knowledge: z.boolean(),
        })
        .strip(),
      reports: z
        .object({
          /** Distinct reporters after which the explanation is unpublished. Stated: 3. */
          unpublish_threshold: z.number().int().min(1).max(100),
        })
        .strip(),
      /**
       * Whether a student must have answered a question before they can read its explanation.
       *
       * **This is a floor, not a preference: it may only be `true`.**
       *
       * With it off, `GET /v1/questions/:id/explanation` is an answer oracle — the explanation
       * names and works through the correct answer, so a student could read the solution to every
       * unattempted question in the bank and the adaptive engine would be measuring nothing. That
       * makes a stored `false` indistinguishable from "expose the correct answer", which the
       * product forbids outright, and a single wrong row in `engine_configs` is not an acceptable
       * distance between a working platform and a leaked answer key.
       *
       * So the key stays — it is the place the rule is written down, and a stricter successor
       * (a minimum time on the question, say) belongs here — but a configuration that tries to
       * switch the protection off is **rejected**, not silently ignored. Silently ignoring it would
       * leave an admin looking at `false` in the configuration and gated explanations in the
       * product, with no way to tell which was true.
       *
       * Rejecting it fails the explanation slice only: `parseExplanationParams` is independent of
       * the engine and ingestion slices (see the slice comment at the top of this file), so an
       * unsafe value takes out the explanation endpoints — the feature it is unsafe for — and
       * nothing else. Fail closed, contained, and loud.
       */
      require_attempt: z.boolean().refine((value) => value === true, {
        message:
          'must be true: an explanation reveals the correct answer, so reading one before attempting the question cannot be permitted by configuration',
      }),
    })
    .strip(),
});

export type ExplanationParams = z.infer<typeof explanationParamsSchema>;

export interface ExplanationParamIssue {
  field: string;
  message: string;
}

/** Validates the explanation slice of a stored params object, reporting each problem by key. */
export function parseExplanationParams(
  input: unknown,
): { ok: true; value: ExplanationParams } | { ok: false; issues: ExplanationParamIssue[] } {
  const result = explanationParamsSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({ field: ['params', ...i.path.map(String)].join('.'), message: i.message })),
  };
}

/** Sanity check the two grounding bands are ordered; a version with them crossed is unusable. */
export function groundingBandsOrdered(params: ExplanationParams): boolean {
  return params.explanation.grounding.notes_only_min >= params.explanation.grounding.mostly_notes_min;
}
