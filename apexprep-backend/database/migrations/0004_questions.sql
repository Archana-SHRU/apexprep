-- =============================================================================
-- 0004_questions
-- Question bank, options, secondary sub-topics, assets, official solutions,
-- AI explanations and the admin review queue.
--
-- Answer columns (question_options.is_correct, questions.correct_numeric,
-- numeric_tolerance, tolerance_mode, matrix_answer) must never be selected on a
-- student-facing code path. See docs/ARCHITECTURE.md §6.
-- =============================================================================

CREATE TABLE questions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  primary_subtopic_id    uuid NOT NULL,
  type                   text NOT NULL,
  stem                   text NOT NULL,
  stem_json              jsonb,
  -- answer key -------------------------------------------------------------------
  correct_numeric        numeric,          -- integer / numeric types
  numeric_tolerance      numeric,
  tolerance_mode         text,             -- absolute | relative
  matrix_answer          jsonb,            -- matrix_match: {"A": ["q"], "B": ["p", "s"], ...}
  -- difficulty & calibration ----------------------------------------------------
  difficulty_label       smallint NOT NULL,        -- L1..L5
  difficulty_b           numeric(8, 2) NOT NULL,   -- Elo-scale difficulty, updated by the engine
  calibration_n          integer NOT NULL DEFAULT 0,
  expected_time_seconds  integer NOT NULL,
  hints                  text[] NOT NULL DEFAULT '{}',
  -- provenance ------------------------------------------------------------------
  source_asset_id        uuid,
  source_page            integer,
  source_block_id        uuid,
  duplicate_group_id     uuid,             -- near-duplicate cluster; members are mutually excluded when serving
  -- lifecycle -------------------------------------------------------------------
  status                 text NOT NULL DEFAULT 'draft',
  version                integer NOT NULL DEFAULT 1,   -- bumped on any content/answer change
  published_at           timestamptz,
  created_by             uuid,
  updated_by             uuid,
  search_tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, stem)) STORED,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT questions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT questions_subtopic_fk FOREIGN KEY (tenant_id, primary_subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT questions_asset_fk    FOREIGN KEY (tenant_id, source_asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT questions_block_fk    FOREIGN KEY (tenant_id, source_block_id) REFERENCES content_blocks (tenant_id, id),
  CONSTRAINT questions_creator_fk  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CONSTRAINT questions_updater_fk  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id),
  CONSTRAINT questions_type_valid  CHECK (type IN ('single_correct', 'multi_correct', 'integer', 'numeric',
                                                   'matrix_match', 'assertion_reason', 'long_form')),
  CONSTRAINT questions_stem_length CHECK (length(btrim(stem)) BETWEEN 1 AND 20000),
  CONSTRAINT questions_stem_json_object CHECK (stem_json IS NULL OR jsonb_typeof(stem_json) = 'object'),
  -- numeric answer shape
  CONSTRAINT questions_numeric_has_value   CHECK ((type IN ('integer', 'numeric')) = (correct_numeric IS NOT NULL)),
  CONSTRAINT questions_numeric_tolerance   CHECK ((type IN ('integer', 'numeric')) = (numeric_tolerance IS NOT NULL AND tolerance_mode IS NOT NULL)),
  CONSTRAINT questions_tolerance_nonneg    CHECK (numeric_tolerance IS NULL OR numeric_tolerance >= 0),
  CONSTRAINT questions_tolerance_mode      CHECK (tolerance_mode IS NULL OR tolerance_mode IN ('absolute', 'relative')),
  CONSTRAINT questions_integer_exact       CHECK (type <> 'integer' OR (correct_numeric = trunc(correct_numeric) AND numeric_tolerance = 0)),
  -- matrix answer shape
  CONSTRAINT questions_matrix_has_answer   CHECK ((type = 'matrix_match') = (matrix_answer IS NOT NULL)),
  CONSTRAINT questions_matrix_object       CHECK (matrix_answer IS NULL OR jsonb_typeof(matrix_answer) = 'object'),
  -- difficulty
  CONSTRAINT questions_label_range         CHECK (difficulty_label BETWEEN 1 AND 5),
  CONSTRAINT questions_b_range             CHECK (difficulty_b BETWEEN -1000 AND 5000),
  CONSTRAINT questions_calibration_nonneg  CHECK (calibration_n >= 0),
  CONSTRAINT questions_expected_time_range CHECK (expected_time_seconds BETWEEN 5 AND 7200),
  CONSTRAINT questions_hints_count         CHECK (cardinality(hints) <= 5),
  -- provenance & lifecycle
  CONSTRAINT questions_source_page CHECK (source_page IS NULL OR (source_page >= 1 AND source_asset_id IS NOT NULL)),
  CONSTRAINT questions_status_valid   CHECK (status IN ('draft', 'in_review', 'published', 'retired', 'rejected')),
  CONSTRAINT questions_published_at   CHECK (status <> 'published' OR published_at IS NOT NULL),
  CONSTRAINT questions_version_positive CHECK (version >= 1)
);
-- Serving path: published questions of one sub-topic ordered by difficulty.
CREATE INDEX questions_serving_idx ON questions (tenant_id, primary_subtopic_id, difficulty_b)
  WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX questions_admin_idx ON questions (tenant_id, status, primary_subtopic_id, difficulty_label) WHERE deleted_at IS NULL;
CREATE INDEX questions_dup_group_idx ON questions (duplicate_group_id) WHERE duplicate_group_id IS NOT NULL;
CREATE INDEX questions_search_idx ON questions USING gin (search_tsv);
CREATE INDEX questions_stem_trgm_idx ON questions USING gin (stem gin_trgm_ops);  -- near-duplicate detection
CREATE TRIGGER questions_set_updated_at BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- Bump version whenever content or the answer key changes. Engine calibration
-- (difficulty_b, calibration_n) and status changes do not bump it.
CREATE FUNCTION app_questions_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stem              IS DISTINCT FROM OLD.stem
  OR NEW.stem_json         IS DISTINCT FROM OLD.stem_json
  OR NEW.type              IS DISTINCT FROM OLD.type
  OR NEW.correct_numeric   IS DISTINCT FROM OLD.correct_numeric
  OR NEW.numeric_tolerance IS DISTINCT FROM OLD.numeric_tolerance
  OR NEW.tolerance_mode    IS DISTINCT FROM OLD.tolerance_mode
  OR NEW.matrix_answer     IS DISTINCT FROM OLD.matrix_answer THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER questions_bump_version BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION app_questions_bump_version();

CREATE TABLE question_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  question_id  uuid NOT NULL,
  option_key   text NOT NULL,
  side         text NOT NULL DEFAULT 'single',   -- single | left | right (matrix-match columns)
  body         text NOT NULL,
  body_json    jsonb,
  is_correct   boolean NOT NULL DEFAULT false,
  sort_order   smallint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_options_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT question_options_question_fk FOREIGN KEY (tenant_id, question_id)
    REFERENCES questions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT question_options_key_uq     UNIQUE (question_id, side, option_key),
  CONSTRAINT question_options_key_format CHECK (option_key ~ '^[A-Za-z0-9]{1,4}$'),
  CONSTRAINT question_options_side_valid CHECK (side IN ('single', 'left', 'right')),
  CONSTRAINT question_options_body_length CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  CONSTRAINT question_options_json_object CHECK (body_json IS NULL OR jsonb_typeof(body_json) = 'object'),
  -- matrix-match correctness lives in questions.matrix_answer
  CONSTRAINT question_options_matrix_no_flag CHECK (side = 'single' OR NOT is_correct)
);
CREATE INDEX question_options_question_idx ON question_options (question_id, side, sort_order);
CREATE TRIGGER question_options_set_updated_at BEFORE UPDATE ON question_options
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- Option edits on a non-draft question change what students see or how they are
-- graded, so they bump the parent's version too.
CREATE FUNCTION app_question_options_bump_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_question_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.question_id ELSE NEW.question_id END;
BEGIN
  UPDATE questions SET version = version + 1
   WHERE id = v_question_id AND status <> 'draft';
  RETURN NULL;
END $$;
CREATE TRIGGER question_options_bump_parent AFTER INSERT OR UPDATE OR DELETE ON question_options
  FOR EACH ROW EXECUTE FUNCTION app_question_options_bump_parent();

-- -----------------------------------------------------------------------------
-- Publish validation (AP002). Deferred so options and the question can be edited
-- in one transaction; checked at COMMIT (or immediately under SET CONSTRAINTS).
-- -----------------------------------------------------------------------------

CREATE FUNCTION app_assert_question_publishable(p_question_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  q          questions%ROWTYPE;
  n_single   integer;
  n_correct  integer;
  n_left     integer;
  n_right    integer;
  v_bad      text;
BEGIN
  SELECT * INTO q FROM questions WHERE id = p_question_id;
  IF NOT FOUND OR q.status <> 'published' OR q.deleted_at IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*) FILTER (WHERE side = 'single'),
         count(*) FILTER (WHERE side = 'single' AND is_correct),
         count(*) FILTER (WHERE side = 'left'),
         count(*) FILTER (WHERE side = 'right')
    INTO n_single, n_correct, n_left, n_right
    FROM question_options
   WHERE question_id = q.id;

  IF q.type IN ('single_correct', 'assertion_reason') THEN
    IF n_single < 2 OR n_correct <> 1 OR n_left + n_right > 0 THEN
      RAISE EXCEPTION 'question % (%) needs at least 2 options and exactly 1 correct; has % options, % correct',
        q.id, q.type, n_single, n_correct USING ERRCODE = 'AP002';
    END IF;

  ELSIF q.type = 'multi_correct' THEN
    IF n_single < 2 OR n_correct < 1 OR n_left + n_right > 0 THEN
      RAISE EXCEPTION 'question % (multi_correct) needs at least 2 options and at least 1 correct; has % options, % correct',
        q.id, n_single, n_correct USING ERRCODE = 'AP002';
    END IF;

  ELSIF q.type IN ('integer', 'numeric', 'long_form') THEN
    IF n_single + n_left + n_right > 0 THEN
      RAISE EXCEPTION 'question % (%) must not have options', q.id, q.type USING ERRCODE = 'AP002';
    END IF;

  ELSIF q.type = 'matrix_match' THEN
    IF n_left < 2 OR n_right < 2 OR n_single > 0 THEN
      RAISE EXCEPTION 'question % (matrix_match) needs at least 2 left and 2 right items', q.id USING ERRCODE = 'AP002';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(q.matrix_answer) e
                WHERE jsonb_typeof(e.value) <> 'array' OR jsonb_array_length(e.value) = 0) THEN
      RAISE EXCEPTION 'question % (matrix_match): every answer entry must be a non-empty array', q.id USING ERRCODE = 'AP002';
    END IF;
    SELECT k INTO v_bad FROM (
      SELECT option_key AS k FROM question_options WHERE question_id = q.id AND side = 'left'
      EXCEPT SELECT jsonb_object_keys(q.matrix_answer)) s LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'question % (matrix_match): left item % has no answer', q.id, v_bad USING ERRCODE = 'AP002';
    END IF;
    SELECT k INTO v_bad FROM (
      SELECT jsonb_object_keys(q.matrix_answer) AS k
      EXCEPT SELECT option_key FROM question_options WHERE question_id = q.id AND side = 'left') s LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'question % (matrix_match): answer key % is not a left item', q.id, v_bad USING ERRCODE = 'AP002';
    END IF;
    SELECT v INTO v_bad FROM (
      SELECT jsonb_array_elements_text(e.value) AS v FROM jsonb_each(q.matrix_answer) e
      EXCEPT SELECT option_key FROM question_options WHERE question_id = q.id AND side = 'right') s LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'question % (matrix_match): answer value % is not a right item', q.id, v_bad USING ERRCODE = 'AP002';
    END IF;
  END IF;
END $$;

CREATE FUNCTION app_questions_publishable_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_assert_question_publishable(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER questions_publishable AFTER INSERT OR UPDATE ON questions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'published')
  EXECUTE FUNCTION app_questions_publishable_trg();

CREATE FUNCTION app_question_options_publishable_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM app_assert_question_publishable(OLD.question_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM app_assert_question_publishable(NEW.question_id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER question_options_publishable AFTER INSERT OR UPDATE OR DELETE ON question_options
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_question_options_publishable_trg();

-- -----------------------------------------------------------------------------

CREATE TABLE question_secondary_subtopics (
  tenant_id    uuid NOT NULL,
  question_id  uuid NOT NULL,
  subtopic_id  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, subtopic_id),
  CONSTRAINT qss_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT qss_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id)
);
CREATE INDEX qss_subtopic_idx ON question_secondary_subtopics (tenant_id, subtopic_id);

CREATE FUNCTION app_qss_not_primary() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND primary_subtopic_id = NEW.subtopic_id) THEN
    RAISE EXCEPTION 'sub-topic % is already the primary sub-topic of question %', NEW.subtopic_id, NEW.question_id
      USING ERRCODE = 'AP004';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qss_not_primary BEFORE INSERT OR UPDATE ON question_secondary_subtopics
  FOR EACH ROW EXECUTE FUNCTION app_qss_not_primary();

CREATE TABLE question_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  question_id  uuid NOT NULL,
  asset_id     uuid NOT NULL,
  role         text NOT NULL,          -- stem | option | solution
  option_id    uuid,
  sort_order   smallint NOT NULL DEFAULT 0,
  alt_text     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_assets_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT question_assets_asset_fk    FOREIGN KEY (tenant_id, asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT question_assets_option_fk   FOREIGN KEY (tenant_id, option_id) REFERENCES question_options (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT question_assets_role_valid  CHECK (role IN ('stem', 'option', 'solution')),
  CONSTRAINT question_assets_option_pair CHECK ((role = 'option') = (option_id IS NOT NULL)),
  CONSTRAINT question_assets_alt_length  CHECK (alt_text IS NULL OR length(alt_text) <= 500),
  CONSTRAINT question_assets_uq UNIQUE NULLS NOT DISTINCT (question_id, asset_id, role, option_id)
);

CREATE TABLE official_solutions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  question_id        uuid NOT NULL,
  body               text NOT NULL,
  body_json          jsonb,              -- structured steps; rubric for long-form questions
  final_answer_text  text,
  source_asset_id    uuid,
  source_page        integer,
  source_block_id    uuid,
  status             text NOT NULL DEFAULT 'draft',
  approved_by        uuid,
  approved_at        timestamptz,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT official_solutions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT official_solutions_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT official_solutions_asset_fk    FOREIGN KEY (tenant_id, source_asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT official_solutions_block_fk    FOREIGN KEY (tenant_id, source_block_id) REFERENCES content_blocks (tenant_id, id),
  CONSTRAINT official_solutions_approver_fk FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  CONSTRAINT official_solutions_creator_fk  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CONSTRAINT official_solutions_body_length CHECK (length(btrim(body)) BETWEEN 1 AND 50000),
  CONSTRAINT official_solutions_json_object CHECK (body_json IS NULL OR jsonb_typeof(body_json) = 'object'),
  CONSTRAINT official_solutions_status_valid CHECK (status IN ('draft', 'approved', 'rejected')),
  CONSTRAINT official_solutions_approved_at CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  CONSTRAINT official_solutions_source_page CHECK (source_page IS NULL OR (source_page >= 1 AND source_asset_id IS NOT NULL))
);
-- At most one approved official solution per question.
CREATE UNIQUE INDEX official_solutions_one_approved_uq ON official_solutions (question_id)
  WHERE status = 'approved' AND deleted_at IS NULL;
CREATE TRIGGER official_solutions_set_updated_at BEFORE UPDATE ON official_solutions
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- Cached explanations. Priority: official_solution → rag_grounded → general_ai.
CREATE TABLE explanations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  question_id           uuid NOT NULL,
  question_version      integer NOT NULL,
  source_tier           text NOT NULL,
  official_solution_id  uuid,
  provider              text,
  model                 text,
  prompt_version        text,
  grounding_score       numeric(4, 3),
  grounding_block_ids   uuid[] NOT NULL DEFAULT '{}',
  retrieval_scope       text,            -- subtopic | topic | chapter (how far retrieval widened)
  content               jsonb NOT NULL,  -- {summary, steps[], key_concept, common_mistake, related_subtopic_id}
  status                text NOT NULL DEFAULT 'active',
  generated_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT explanations_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT explanations_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT explanations_solution_fk FOREIGN KEY (tenant_id, official_solution_id) REFERENCES official_solutions (tenant_id, id),
  CONSTRAINT explanations_reviewer_fk FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users (tenant_id, id),
  CONSTRAINT explanations_version_positive CHECK (question_version >= 1),
  CONSTRAINT explanations_tier_valid   CHECK (source_tier IN ('official_solution', 'rag_grounded', 'general_ai')),
  CONSTRAINT explanations_official_link CHECK ((source_tier = 'official_solution') = (official_solution_id IS NOT NULL)),
  CONSTRAINT explanations_ai_provenance CHECK (source_tier = 'official_solution' OR (provider IS NOT NULL AND model IS NOT NULL)),
  CONSTRAINT explanations_grounding_range CHECK (grounding_score IS NULL OR grounding_score BETWEEN 0 AND 1),
  CONSTRAINT explanations_rag_grounded  CHECK (source_tier <> 'rag_grounded'
                                               OR (grounding_score IS NOT NULL AND cardinality(grounding_block_ids) BETWEEN 1 AND 20
                                                   AND retrieval_scope IS NOT NULL)),
  CONSTRAINT explanations_scope_valid   CHECK (retrieval_scope IS NULL OR retrieval_scope IN ('subtopic', 'topic', 'chapter')),
  CONSTRAINT explanations_content_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT explanations_status_valid  CHECK (status IN ('active', 'superseded', 'flagged', 'rejected')),
  CONSTRAINT explanations_reviewed_pair CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CONSTRAINT explanations_text_lengths  CHECK ((provider IS NULL OR length(provider) <= 50) AND (model IS NULL OR length(model) <= 100)
                                               AND (prompt_version IS NULL OR length(prompt_version) <= 50))
);
CREATE UNIQUE INDEX explanations_one_active_uq ON explanations (question_id, question_version) WHERE status = 'active';
CREATE TRIGGER explanations_set_updated_at BEFORE UPDATE ON explanations
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- -----------------------------------------------------------------------------
-- review_tasks: the admin review queue (ingestion output, student reports, gaps)
-- -----------------------------------------------------------------------------

CREATE TABLE review_tasks (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL,
  kind                      text NOT NULL,
  status                    text NOT NULL DEFAULT 'open',
  priority                  smallint NOT NULL DEFAULT 3,     -- 1 = highest
  job_id                    uuid,
  content_block_id          uuid,
  question_id               uuid,
  explanation_id            uuid,
  subtopic_id               uuid,
  duplicate_of_question_id  uuid,
  reason                    text,
  suggestion                jsonb,      -- model-proposed classification / tags / match
  reporter_user_id          uuid,
  reporter_comment          text,
  assigned_to               uuid,
  resolution_note           text,
  resolved_by               uuid,
  resolved_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_tasks_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT review_tasks_job_fk         FOREIGN KEY (tenant_id, job_id) REFERENCES ingestion_jobs (tenant_id, id),
  CONSTRAINT review_tasks_block_fk       FOREIGN KEY (tenant_id, content_block_id) REFERENCES content_blocks (tenant_id, id),
  CONSTRAINT review_tasks_question_fk    FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT review_tasks_explanation_fk FOREIGN KEY (tenant_id, explanation_id) REFERENCES explanations (tenant_id, id),
  CONSTRAINT review_tasks_subtopic_fk    FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT review_tasks_duplicate_fk   FOREIGN KEY (tenant_id, duplicate_of_question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT review_tasks_reporter_fk    FOREIGN KEY (tenant_id, reporter_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT review_tasks_assignee_fk    FOREIGN KEY (tenant_id, assigned_to) REFERENCES users (tenant_id, id),
  CONSTRAINT review_tasks_resolver_fk    FOREIGN KEY (tenant_id, resolved_by) REFERENCES users (tenant_id, id),
  CONSTRAINT review_tasks_kind_valid CHECK (kind IN ('block_classification', 'theory_review', 'question_review',
    'solution_match', 'duplicate_candidate', 'student_report', 'explanation_review', 'content_gap')),
  CONSTRAINT review_tasks_status_valid CHECK (status IN ('open', 'in_progress', 'approved', 'rejected', 'resolved', 'cancelled')),
  CONSTRAINT review_tasks_priority_range CHECK (priority BETWEEN 1 AND 5),
  CONSTRAINT review_tasks_has_target CHECK (num_nonnulls(content_block_id, question_id, explanation_id, subtopic_id) >= 1),
  -- `reason IS NOT NULL` is required: `NULL IN (...)` is NULL, and a NULL CHECK passes.
  CONSTRAINT review_tasks_student_report CHECK (kind <> 'student_report' OR (question_id IS NOT NULL AND reporter_user_id IS NOT NULL
    AND reason IS NOT NULL
    AND reason IN ('wrong_answer', 'wrong_solution', 'typo', 'unclear', 'missing_diagram', 'wrong_topic', 'other'))),
  CONSTRAINT review_tasks_reporter_only_reports CHECK (reporter_user_id IS NULL OR kind = 'student_report'),
  CONSTRAINT review_tasks_content_gap CHECK (kind <> 'content_gap' OR subtopic_id IS NOT NULL),
  CONSTRAINT review_tasks_duplicate CHECK (kind <> 'duplicate_candidate' OR duplicate_of_question_id IS NOT NULL
                                           OR content_block_id IS NOT NULL),
  CONSTRAINT review_tasks_resolution CHECK ((status IN ('approved', 'rejected', 'resolved', 'cancelled')) = (resolved_at IS NOT NULL)),
  CONSTRAINT review_tasks_suggestion_object CHECK (suggestion IS NULL OR jsonb_typeof(suggestion) = 'object'),
  CONSTRAINT review_tasks_text_lengths CHECK ((reason IS NULL OR length(reason) <= 200)
    AND (reporter_comment IS NULL OR length(reporter_comment) <= 2000)
    AND (resolution_note IS NULL OR length(resolution_note) <= 2000))
);
CREATE INDEX review_tasks_queue_idx ON review_tasks (tenant_id, status, priority, created_at);
CREATE INDEX review_tasks_block_idx ON review_tasks (content_block_id) WHERE content_block_id IS NOT NULL;
CREATE INDEX review_tasks_question_idx ON review_tasks (question_id) WHERE question_id IS NOT NULL;
CREATE INDEX review_tasks_job_idx ON review_tasks (job_id) WHERE job_id IS NOT NULL;
-- One open content-gap task per sub-topic; one open report per student per question.
CREATE UNIQUE INDEX review_tasks_open_gap_uq ON review_tasks (tenant_id, subtopic_id)
  WHERE kind = 'content_gap' AND status IN ('open', 'in_progress');
CREATE UNIQUE INDEX review_tasks_open_report_uq ON review_tasks (question_id, reporter_user_id)
  WHERE kind = 'student_report' AND status IN ('open', 'in_progress');
CREATE TRIGGER review_tasks_set_updated_at BEFORE UPDATE ON review_tasks
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
