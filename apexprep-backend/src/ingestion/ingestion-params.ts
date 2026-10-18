import { z } from 'zod';

/**
 * The ingestion pipeline's tunables, read from the same versioned `engine_config.params` the
 * adaptive engine and the explanation system use.
 *
 * A schema slice of its own, for the reason Phase 6 gave: adding required keys to
 * `src/adaptive/engine-params.ts` would invalidate every configuration version already stored and
 * stop Phases 1-5 working on existing data. So this validates exactly what ingestion needs and
 * fails loudly naming the missing key, rather than substituting a default.
 *
 * **No key has a default here.** Values the requirements state are marked; the rest are listed in
 * docs/DECISIONS.md §C as NOT SPECIFIED.
 */

const fraction = z.number().min(0).max(1);

export const ingestionParamsSchema = z.object({
  near_duplicate: z
    .object({
      /** The similarity at which two questions are near-duplicates. Reused from Phase 4. */
      trigram_similarity: fraction,
    })
    .strip(),
  ingestion: z
    .object({
      confidence: z
        .object({
          /** A block classified below this goes to review rather than being trusted. */
          classification_min: fraction,
          /** A syllabus mapping below this goes to review. */
          mapping_min: fraction,
          /** A question extraction below this goes to review. */
          question_min: fraction,
          /** A solution match below this is not linked; a review task is opened instead. */
          solution_min: fraction,
        })
        .strip(),
      auto_approval: z
        .object({
          /** Whether any content may be approved without a human at all. */
          enabled: z.boolean(),
          /** Every confidence on the block must be at or above this to be eligible. */
          min_confidence: fraction,
          /** Fraction of auto-approved content sampled for audit. Stated: 0.05. */
          audit_sample_rate: fraction,
          /**
           * Difficulty labels that always need a human, whatever the confidence. The
           * requirements name Olympiad L5 content; the track side is matched by slug, the same
           * way the explanation system identifies an Olympiad (DECISIONS.md §B47).
           */
          mandatory_review_difficulty_labels: z.array(z.number().int().min(1).max(5)).max(5),
          mandatory_review_track_slug_patterns: z.array(z.string().min(1).max(80)).max(50),
          /** OCR'd content is never auto-approved when true. */
          require_review_for_ocr: z.boolean(),
        })
        .strip(),
      /**
       * How long an approval can be undone for. The requirements say approval must be reversible
       * for a window without saying how long, so it is configuration rather than a constant.
       */
      approval_reversal_window_hours: z.number().int().min(0).max(8760),
      /** A page whose text layer yields fewer characters than this is a candidate for OCR. */
      ocr_min_page_chars: z.number().int().min(0).max(10_000),
    })
    .strip(),
});

export type IngestionParams = z.infer<typeof ingestionParamsSchema>;

export interface IngestionParamIssue {
  field: string;
  message: string;
}

export function parseIngestionParams(
  input: unknown,
): { ok: true; value: IngestionParams } | { ok: false; issues: IngestionParamIssue[] } {
  const result = ingestionParamsSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({ field: ['params', ...i.path.map(String)].join('.'), message: i.message })),
  };
}
