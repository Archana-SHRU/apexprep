-- =============================================================================
-- 0010_attempt_engine_inputs
--
-- WHY THIS MIGRATION IS NEEDED
--
-- Phase 5 requires that `ability_scores` be a pure projection: rebuildable by
-- replaying the immutable `attempts` rows in (created_at, id) order. The attempts
-- table was already designed for that — it snapshots `difficulty_b_at_attempt`,
-- `difficulty_label_at_attempt`, `theta_before`, `expected_score` and the
-- `engine_config_id` in force — but two inputs the engine actually used were
-- missing, and both come from mutable columns on `questions`:
--
--   * `calibration_n_at_attempt` — K_s is halved when the question had fewer than
--     `k_student.low_calibration_threshold` attempts behind it, and K_q steps down
--     once the question passes `k_question.calibrated_after`. `questions.calibration_n`
--     has moved on since (every later attempt increments it), so the K values that
--     produced this attempt's theta step cannot be recovered from it.
--
--   * `expected_time_seconds_at_attempt` — the probable-guess rule (incorrect and
--     under `probable_guess.max_time_fraction_of_expected`) and the promotion speed
--     condition (within `promotion.within_expected_time_factor`) are both measured
--     against it, and an editor may change `questions.expected_time_seconds` at any
--     time.
--
-- Without these, a replay could reproduce the whole theta trajectory except its
-- final step — which is exactly the value `ability_scores.theta` holds. So the
-- claim "the projection can be rebuilt from attempts" was not true, and this
-- migration is what makes it true.
--
-- Both columns are NULLABLE on purpose: `attempts` is append-only and immutable,
-- so rows written before this migration cannot be backfilled, and inventing
-- values for them would be worse than admitting they are unknown. A replay that
-- meets such a row reports it instead of guessing (see src/practice/ability-replay.ts).
-- Every attempt written from here on has both.
-- =============================================================================

ALTER TABLE attempts
  ADD COLUMN calibration_n_at_attempt         integer,
  ADD COLUMN expected_time_seconds_at_attempt integer;

ALTER TABLE attempts
  ADD CONSTRAINT attempts_calibration_n_at_attempt_valid
    CHECK (calibration_n_at_attempt IS NULL OR calibration_n_at_attempt >= 0),
  ADD CONSTRAINT attempts_expected_time_at_attempt_valid
    CHECK (expected_time_seconds_at_attempt IS NULL
           OR (expected_time_seconds_at_attempt BETWEEN 5 AND 7200));

COMMENT ON COLUMN attempts.calibration_n_at_attempt IS
  'questions.calibration_n as it stood when this attempt was graded; the K factors are derived from it. NULL only for rows written before migration 0010.';
COMMENT ON COLUMN attempts.expected_time_seconds_at_attempt IS
  'questions.expected_time_seconds as it stood when this attempt was graded; the guess and promotion speed rules are measured against it. NULL only for rows written before migration 0010.';
