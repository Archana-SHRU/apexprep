-- =============================================================================
-- 0009_ladder_reset
--
-- WHY THIS MIGRATION IS NEEDED
--
-- The level ladder promotes on "2 consecutive correct (within 1.25x the expected
-- time) OR 3 correct of the last 4", and demotes on "2 consecutive incorrect OR
-- 3 incorrect of the last 5". Those are *counters*: when one fires, the evidence
-- it consumed must not immediately fire it again at the new level. Without a
-- reset point, a student answering three quick questions correctly would climb
-- two levels, because the same 3-of-4 window would still be true after the first
-- promotion.
--
-- The ladder window is derived from the immutable `attempts` rows, so the only
-- state that cannot be derived is *where the current level started*. This column
-- records it. It is a projection value like the rest of `ability_scores`: a
-- rebuild that replays attempts in (created_at, id) order recomputes it, and
-- `attempts` stays immutable and authoritative.
--
-- Nothing else in Phase 5 needed schema support: session pausing after three
-- probable guesses is derived from `attempts.probable_guess` within the session,
-- and every other value already has a column.
-- =============================================================================

ALTER TABLE ability_scores
  ADD COLUMN ladder_reset_at timestamptz;

COMMENT ON COLUMN ability_scores.ladder_reset_at IS
  'Attempts at or before this time do not count towards the promotion/demotion windows: set whenever the level changes. NULL means the whole history counts.';
