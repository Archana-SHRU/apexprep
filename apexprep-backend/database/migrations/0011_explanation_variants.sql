-- =============================================================================
-- 0011_explanation_variants
--
-- WHY THIS MIGRATION IS NEEDED
--
-- Phase 6 requires distractor-specific explanation variants, cached per option:
-- when a student picks the wrong option B, they get an explanation that also says
-- why B is tempting and where it fails, and that variant is cached so the next
-- student who picks B does not pay for another generation.
--
-- The `explanations` table cannot hold them as it stands. Its key is
--
--   CREATE UNIQUE INDEX explanations_one_active_uq
--     ON explanations (question_id, question_version) WHERE status = 'active';
--
-- so one question version has exactly one active explanation. A per-option
-- variant cannot coexist with the question-level one.
--
-- The alternative that needs no migration — nesting the variants inside the
-- existing `content` jsonb — was rejected, because each variant needs its own
-- row-level state, and all of it is enforced in SQL on this table:
--
--   * its own `status`, so a bad distractor variant can be unpublished
--     (`flagged`) or blocked (`rejected`) without taking the question's main
--     explanation down with it;
--   * its own `grounding_score` and `grounding_block_ids`, because a variant is
--     retrieved and scored separately (CHECK explanations_rag_grounded);
--   * its own `provider`, `model` and `reviewed_by`/`reviewed_at`, because a
--     variant is generated, and approved, on its own.
--
-- Putting that state in jsonb would mean re-implementing five CHECK constraints
-- and a partial unique index in application code — the opposite of how the rest
-- of this schema works.
--
-- BACKWARD COMPATIBLE: the column is nullable and NULL keeps its existing
-- meaning — the explanation for the question as a whole, which is what every row
-- written before this migration is. The unique index gains the column with NULLS
-- NOT DISTINCT, so the old "one active explanation per question version" rule
-- still holds exactly for those rows (PostgreSQL 15+; this project requires 16).
-- =============================================================================

ALTER TABLE explanations
  ADD COLUMN option_key text;

ALTER TABLE explanations
  ADD CONSTRAINT explanations_option_key_format
    CHECK (option_key IS NULL OR option_key ~ '^[A-Za-z0-9]{1,4}$'),
  -- A distractor variant explains a wrong choice, which only option questions have.
  -- (`question_options.option_key` is unique per (question, side), so a foreign key here
  -- would need a `side` column too; the key is validated against the question's options in
  -- the service, the way `questions.matrix_answer` keys are.)
  ADD CONSTRAINT explanations_option_key_tier
    CHECK (option_key IS NULL OR source_tier <> 'official_solution');

DROP INDEX explanations_one_active_uq;
CREATE UNIQUE INDEX explanations_one_active_uq
  ON explanations (question_id, question_version, option_key) NULLS NOT DISTINCT
  WHERE status = 'active';

CREATE INDEX explanations_lookup_idx
  ON explanations (tenant_id, question_id, question_version, status);

COMMENT ON COLUMN explanations.option_key IS
  'NULL = the explanation for the question itself. Otherwise the wrong option this variant also explains (a distractor variant).';
