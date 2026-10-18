import { z } from 'zod';

/**
 * Every tunable of the adaptive engine, as stored in `engine_config.params`.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *  1. **No defaults.** Nothing here has a fallback value. A configuration version that
 *     omits a key is rejected when it is created, with the key named, rather than the
 *     engine quietly running on an invented number.
 *  2. **No literals in engine code.** Every function in `src/adaptive/` takes these
 *     parameters as an argument. Changing behaviour means a new, audited config version.
 *
 * The shapes below follow the stated requirements: stepped K-factors for students and
 * questions, a promotion/demotion ladder with a speed condition, probable guesses defined
 * as an incorrect answer given too quickly, probes half a level above target, and a
 * session pause after repeated guessing. Keys whose VALUES the requirements have not
 * stated are marked in docs/DECISIONS.md §C; the schema still requires them, so nothing
 * runs on an implicit default.
 */

const positive = z.number().finite().positive();
const nonNegative = z.number().finite().nonnegative();
const fraction = z.number().finite().min(0).max(1);
const level = z.number().int().min(1).max(5);

/** How an event that is not a normal graded attempt affects an update. */
const updateWeight = z.enum(['skip', 'half', 'full']);

const levelBand = z
  .object({
    level,
    /** null on the first band: no lower bound. */
    theta_min: z.number().finite().nullable(),
    /** null on the last band: no upper bound. */
    theta_max: z.number().finite().nullable(),
  })
  .strict();

const levelBands = z
  .array(levelBand)
  .length(5)
  .superRefine((bands, ctx) => {
    if (bands.length !== 5) return; // the length check has already reported this
    const sorted = [...bands].sort((a, b) => a.level - b.level);
    if (sorted.some((b, i) => b.level !== i + 1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'level_bands must cover levels 1 to 5 exactly once' });
      return;
    }
    if (sorted[0]!.theta_min !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the L1 band must have theta_min = null (no lower bound)' });
    if (sorted[4]!.theta_max !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the L5 band must have theta_max = null (no upper bound)' });
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const upper = sorted[i]!.theta_max;
      const nextLower = sorted[i + 1]!.theta_min;
      if (upper === null || nextLower === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bands L${i + 1} and L${i + 2} must both be bounded where they meet` });
      } else if (upper !== nextLower) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `band L${i + 1} ends at ${upper} but L${i + 2} starts at ${nextLower}; bands must be contiguous` });
      }
    }
  });

export const engineParamsSchema = z
  .object({
    // --- Elo -----------------------------------------------------------------
    /** Scale of the logistic curve: E = 1 / (1 + 10^((b − θ)/elo_scale)). */
    elo_scale: positive,

    /** K in θ' = θ + K_s(S − E): larger while the student is new to a sub-topic. */
    k_student: z
      .object({
        /** K for the student's first `initial_attempts` attempts in a sub-topic. */
        initial: nonNegative,
        initial_attempts: z.number().int().min(0).max(1000),
        /** K once they are past that. */
        steady: nonNegative,
        /** A question with fewer than this many calibrating attempts is weak evidence… */
        low_calibration_threshold: z.number().int().min(0).max(10000),
        /** …so the student's update is scaled by this factor. */
        low_calibration_factor: fraction,
      })
      .strict(),

    /** K in b' = b + K_q(E − S): larger while the question itself is uncalibrated. */
    k_question: z
      .object({
        /** K while `questions.calibration_n` is below `calibrated_after`. */
        uncalibrated: nonNegative,
        calibrated_after: z.number().int().min(0).max(100000),
        /** K once the question is calibrated. */
        steady: nonNegative,
      })
      .strict(),

    // --- levels --------------------------------------------------------------
    cold_start: z
      .object({
        /** Level a student starts at with no history. */
        level,
        /** Seed θ from the student's ability in the parent topic when there is one. */
        seed_from_parent_topic: z.boolean(),
      })
      .strict(),
    /** θ ranges that define L1-L5; contiguous and open at both ends. */
    level_bands: levelBands,
    /** Starting `questions.difficulty_b` for a newly authored question, per label. */
    initial_b_by_level: z
      .object({ '1': z.number().finite(), '2': z.number().finite(), '3': z.number().finite(), '4': z.number().finite(), '5': z.number().finite() })
      .strict(),
    /** Probability of a correct answer the selector aims for. */
    target_success: z.number().finite().gt(0).lt(1),

    // --- placement -----------------------------------------------------------
    placement: z.object({ enabled: z.boolean(), question_count: z.number().int().min(1).max(50) }).strict(),

    // --- the level ladder ----------------------------------------------------
    /** Promotion: N consecutive correct answered quickly enough, OR M correct of the last W. */
    promotion: z
      .object({
        consecutive_correct: z.number().int().min(1).max(50),
        /** "Quickly enough" = within this multiple of the question's expected time. */
        within_expected_time_factor: positive,
        window: z.number().int().min(1).max(100),
        correct_in_window: z.number().int().min(1).max(100),
      })
      .strict()
      .refine((p) => p.correct_in_window <= p.window, { message: 'promotion.correct_in_window cannot exceed promotion.window' }),
    /** Demotion: N consecutive incorrect, OR M incorrect of the last W. */
    demotion: z
      .object({
        consecutive_incorrect: z.number().int().min(1).max(50),
        window: z.number().int().min(1).max(100),
        incorrect_in_window: z.number().int().min(1).max(100),
      })
      .strict()
      .refine((p) => p.incorrect_in_window <= p.window, { message: 'demotion.incorrect_in_window cannot exceed demotion.window' }),

    /** L1 protection: a student is never demoted below L1; the θ floor is optional. */
    l1_protection: z.object({ block_demotion: z.boolean(), theta_floor: z.number().finite().nullable() }).strict(),
    /** L5 ceiling: a student is never promoted above L5; the θ cap is optional. */
    l5_ceiling: z.object({ block_promotion: z.boolean(), theta_cap: z.number().finite().nullable() }).strict(),

    // --- probable guesses ----------------------------------------------------
    probable_guess: z
      .object({
        /** Whether a guess must also be wrong (the stated rule: incorrect AND too fast). */
        requires_incorrect: z.boolean(),
        /** Too fast = under this fraction of the question's expected time. */
        max_time_fraction_of_expected: fraction,
        /** What a probable guess does to θ, to the question's b, and to the ladder. */
        theta_update: updateWeight,
        question_update: updateWeight,
        counts_towards_level: z.boolean(),
        /** This many flagged guesses in one session pauses it. */
        pause_session_after: z.number().int().min(1).max(100),
      })
      .strict(),

    // --- expected time -------------------------------------------------------
    /**
     * When the admin's estimate of how long a question takes gives way to what students
     * actually do.
     *
     * §6.4 states it exactly: `expected_time_seconds` is "admin-set at first, replaced by
     * observed median once `calibration_n` >= 30". Both the statistic (the median, not the
     * mean) and the threshold (30) are the document's, so this key is **stated**, not a
     * value chosen here. The median is the right statistic and the reason is worth keeping:
     * one student who leaves a tab open for an hour moves a mean by minutes and a median not
     * at all.
     *
     * The value matters because `probable_guess.max_time_fraction_of_expected` is a fraction
     * *of this number*: while it is a guess, so is every judgement about whether an answer
     * came too fast to be thought about.
     */
    expected_time: z
      .object({
        /** Graded attempts behind a question before its observed median replaces the estimate. Stated: 30. */
        recalibrate_after_attempts: z.number().int().min(1).max(10_000),
        /**
         * Whether attempts flagged as probable guesses are left out of the median.
         *
         * They are, and this is a decision rather than a requirement — the document does not
         * say which attempts count. A probable guess is by definition answered in a small
         * fraction of the expected time, so counting guesses pulls the median down, which
         * lowers the expected time, which makes the guess threshold shorter, which flags fewer
         * guesses. That feedback loop has no fixed point worth landing on, and the quantity
         * being estimated is how long the question takes to *answer*, which a guess never
         * measures. See docs/DECISIONS.md.
         */
        exclude_probable_guesses: z.boolean(),
        /**
         * A floor and a ceiling on what the observed median may write back, in seconds.
         *
         * Not a tuning knob: the same bounds the admin field itself is validated against
         * (questions_expected_time_range, migration 0002), so calibration can never write a
         * value an admin could not have typed, and a pathological cohort cannot drive a
         * question's expected time to zero.
         */
        min_seconds: z.number().int().min(1).max(36_000),
        max_seconds: z.number().int().min(1).max(36_000),
      })
      .strict()
      .refine((p) => p.min_seconds <= p.max_seconds, {
        message: 'expected_time.min_seconds cannot exceed expected_time.max_seconds',
      }),

    // --- probes --------------------------------------------------------------
    probe: z
      .object({
        /** Every n-th question in a session is a probe. */
        every_n: z.number().int().min(2).max(50),
        /** How far above the target difficulty a probe aims, in level widths. */
        levels_above_target: z.number().finite().min(0).max(4),
        updates_theta: z.boolean(),
        updates_question_b: z.boolean(),
        /** Whether a probe result counts towards the promotion and demotion counters. */
        counts_towards_promotion: z.boolean(),
        counts_towards_demotion: z.boolean(),
      })
      .strict(),

    // --- inactivity ----------------------------------------------------------
    inactivity_decay: z
      .object({
        /** Days of no practice in a sub-topic before θ starts decaying. */
        after_days: z.number().int().min(1).max(365),
        /** Length of one decay period once decay has started. */
        per_period_days: z.number().int().min(1).max(365),
        /** θ points removed per period. */
        theta_points_per_period: nonNegative,
        /** Cap on the total decay, or null for no cap. */
        max_total_points: nonNegative.nullable(),
        /** θ never decays below this, or null for no floor. */
        floor_theta: z.number().finite().nullable(),
      })
      .strict(),

    // --- what may be served --------------------------------------------------
    /** A question attempted within this many days is not served again. */
    exclusion_days: z.number().int().min(0).max(3650),
    /** Whether questions that were served and skipped are excluded too (DECISIONS.md §B12). */
    exclusion_includes_skipped: z.boolean(),
    near_duplicate: z
      .object({
        /** pg_trgm similarity at or above which two stems count as near-duplicates. */
        trigram_similarity: fraction,
        /** Days a near-duplicate of a seen question stays excluded. */
        exclude_days: z.number().int().min(0).max(3650),
      })
      .strict(),
    content_gap: z
      .object({
        /** Fewer eligible questions than this is a content gap. */
        min_eligible: z.number().int().min(1).max(100),
        /** Whether selection widens to the parent topic when the gap is hit. */
        widen_to_topic: z.boolean(),
        /** Whether a content-gap alert (review task) is raised for admins. */
        open_review_task: z.boolean(),
      })
      .strict(),

    // --- downstream phases ---------------------------------------------------
    benchmark: z
      .object({
        window_days: z.number().int().min(1).max(3650),
        top_k: z.number().int().min(1).max(100),
        min_qualifying_students: z.number().int().min(1).max(10000),
      })
      .strict(),
    rag: z
      .object({
        top_k: z.number().int().min(1).max(50),
        widen_order: z.array(z.enum(['subtopic', 'topic', 'chapter'])).min(1).max(3),
      })
      .strict(),
  })
  // Bookkeeping the development seed carries; harmless in any version.
  .catchall(z.unknown());

export type EngineParams = z.infer<typeof engineParamsSchema>;
export type LevelBand = z.infer<typeof levelBand>;
export type UpdateWeight = z.infer<typeof updateWeight>;

export interface ParamIssue {
  field: string;
  message: string;
}

/** Validates a stored or submitted params object, reporting every problem by key path. */
export function parseEngineParams(input: unknown): { ok: true; value: EngineParams } | { ok: false; issues: ParamIssue[] } {
  const result = engineParamsSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({ field: ['params', ...i.path.map(String)].join('.'), message: i.message })),
  };
}

/** The weight an update carries: skip = 0, half = 0.5, full = 1. */
export function updateFactor(weight: UpdateWeight): number {
  return weight === 'skip' ? 0 : weight === 'half' ? 0.5 : 1;
}

/** Bands sorted L1 → L5. */
export function bandsByLevel(params: EngineParams): LevelBand[] {
  return [...params.level_bands].sort((a, b) => a.level - b.level);
}

/**
 * Width of one level in θ points. The open-ended L1 and L5 bands have no width of their
 * own, so they borrow the average of the bounded ones — used by the probe offset
 * ("half a level above target").
 */
export function levelWidth(params: EngineParams, level: number): number {
  const bands = bandsByLevel(params);
  const widths = bands.filter((b) => b.theta_min !== null && b.theta_max !== null).map((b) => b.theta_max! - b.theta_min!);
  const mean = widths.length > 0 ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
  const band = bands.find((b) => b.level === level);
  if (!band || band.theta_min === null || band.theta_max === null) return mean;
  return band.theta_max - band.theta_min;
}
