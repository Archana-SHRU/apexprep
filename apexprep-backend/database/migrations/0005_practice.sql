-- =============================================================================
-- 0005_practice
-- Versioned engine configuration, practice sessions, served items, immutable
-- attempts, ability projections and focus-tracking events.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- engine_config: every tunable engine parameter, versioned per tenant.
-- A version is immutable once written; only activation changes. Every insert and
-- every activation change writes an audit_log row from inside the database, so a
-- config change cannot bypass the audit trail.
-- -----------------------------------------------------------------------------

CREATE TABLE engine_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  version         integer NOT NULL,
  schema_version  smallint NOT NULL DEFAULT 1,
  params          jsonb NOT NULL,
  change_note     text NOT NULL,
  created_by      uuid,              -- NULL = system (e.g. initial provisioning)
  is_active       boolean NOT NULL DEFAULT false,
  activated_at    timestamptz,
  activated_by    uuid,
  deactivated_at  timestamptz,
  deactivated_by  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_config_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT engine_config_version_uq      UNIQUE (tenant_id, version),
  CONSTRAINT engine_config_creator_fk      FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CONSTRAINT engine_config_activator_fk    FOREIGN KEY (tenant_id, activated_by) REFERENCES users (tenant_id, id),
  CONSTRAINT engine_config_deactivator_fk  FOREIGN KEY (tenant_id, deactivated_by) REFERENCES users (tenant_id, id),
  CONSTRAINT engine_config_inactive_state  CHECK (NOT is_active OR deactivated_at IS NULL),
  CONSTRAINT engine_config_version_positive CHECK (version >= 1),
  CONSTRAINT engine_config_schema_positive  CHECK (schema_version >= 1),
  CONSTRAINT engine_config_params_object    CHECK (jsonb_typeof(params) = 'object'),
  CONSTRAINT engine_config_note_length      CHECK (length(btrim(change_note)) BETWEEN 1 AND 2000),
  CONSTRAINT engine_config_active_has_time  CHECK (NOT is_active OR activated_at IS NOT NULL)
);
CREATE UNIQUE INDEX engine_config_one_active_uq ON engine_config (tenant_id) WHERE is_active;
CREATE TRIGGER engine_config_set_updated_at BEFORE UPDATE ON engine_config
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
CREATE TRIGGER engine_config_no_delete BEFORE DELETE ON engine_config
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation('versioned: create a new version instead');
CREATE TRIGGER engine_config_no_truncate BEFORE TRUNCATE ON engine_config
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation('versioned: create a new version instead');

CREATE FUNCTION app_engine_config_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.params         IS DISTINCT FROM OLD.params
  OR NEW.version        IS DISTINCT FROM OLD.version
  OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
  OR NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.change_note    IS DISTINCT FROM OLD.change_note
  OR NEW.created_by     IS DISTINCT FROM OLD.created_by
  OR NEW.created_at     IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'engine_config version % is immutable; create a new version instead', OLD.version
      USING ERRCODE = 'AP001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER engine_config_guard BEFORE UPDATE ON engine_config
  FOR EACH ROW EXECUTE FUNCTION app_engine_config_guard();

CREATE FUNCTION app_engine_config_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app_write_audit(NEW.tenant_id, NEW.created_by, 'engine_config.created', 'engine_config', NEW.id,
      NULL, jsonb_build_object('version', NEW.version, 'params', NEW.params, 'change_note', NEW.change_note,
                               'is_active', NEW.is_active));
    IF NEW.is_active THEN
      PERFORM app_write_audit(NEW.tenant_id, coalesce(NEW.activated_by, NEW.created_by), 'engine_config.activated',
        'engine_config', NEW.id, NULL, jsonb_build_object('version', NEW.version));
    END IF;
  ELSIF NEW.is_active AND NOT OLD.is_active THEN
    PERFORM app_write_audit(NEW.tenant_id, NEW.activated_by, 'engine_config.activated', 'engine_config', NEW.id,
      jsonb_build_object('is_active', false), jsonb_build_object('version', NEW.version, 'is_active', true));
  ELSIF OLD.is_active AND NOT NEW.is_active THEN
    PERFORM app_write_audit(NEW.tenant_id, NEW.deactivated_by, 'engine_config.deactivated', 'engine_config', NEW.id,
      jsonb_build_object('is_active', true), jsonb_build_object('version', NEW.version, 'is_active', false));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER engine_config_audit AFTER INSERT OR UPDATE ON engine_config
  FOR EACH ROW EXECUTE FUNCTION app_engine_config_audit();

-- -----------------------------------------------------------------------------
-- sessions: one practice session scoped to one sub-topic
-- -----------------------------------------------------------------------------

CREATE TABLE sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  user_id                 uuid NOT NULL,
  subtopic_id             uuid NOT NULL,
  mode                    text NOT NULL DEFAULT 'adaptive',
  status                  text NOT NULL DEFAULT 'active',
  engine_config_id        uuid NOT NULL,
  focus_tracking_enabled  boolean NOT NULL,      -- effective setting snapshotted at start
  device_type             text NOT NULL DEFAULT 'unknown',
  target_question_count   smallint,
  served_count            integer NOT NULL DEFAULT 0,
  answered_count          integer NOT NULL DEFAULT 0,
  started_at              timestamptz NOT NULL DEFAULT now(),
  last_activity_at        timestamptz NOT NULL DEFAULT now(),
  ended_at                timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- lets children prove they belong to the same user and sub-topic as the session
  CONSTRAINT sessions_owner_scope_uq  UNIQUE (tenant_id, id, user_id, subtopic_id),
  CONSTRAINT sessions_user_fk     FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT sessions_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT sessions_config_fk   FOREIGN KEY (tenant_id, engine_config_id) REFERENCES engine_config (tenant_id, id),
  CONSTRAINT sessions_mode_valid    CHECK (mode IN ('adaptive', 'placement', 'review')),
  CONSTRAINT sessions_status_valid  CHECK (status IN ('active', 'completed', 'abandoned', 'expired')),
  CONSTRAINT sessions_device_valid  CHECK (device_type IN ('desktop', 'tablet', 'mobile', 'unknown')),
  CONSTRAINT sessions_target_range  CHECK (target_question_count IS NULL OR target_question_count BETWEEN 1 AND 200),
  CONSTRAINT sessions_counts        CHECK (served_count >= 0 AND answered_count >= 0 AND answered_count <= served_count),
  CONSTRAINT sessions_end_state     CHECK ((status = 'active') = (ended_at IS NULL)),
  CONSTRAINT sessions_time_order    CHECK ((ended_at IS NULL OR ended_at >= started_at) AND last_activity_at >= started_at)
);
-- One live session per student per sub-topic: /next sequencing stays consistent.
CREATE UNIQUE INDEX sessions_one_active_uq ON sessions (tenant_id, user_id, subtopic_id) WHERE status = 'active';
CREATE INDEX sessions_user_time_idx ON sessions (tenant_id, user_id, started_at DESC);
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- -----------------------------------------------------------------------------
-- session_items: what was served. A served-but-unanswered item is 'skipped' or
-- 'abandoned' — it never becomes an incorrect attempt.
-- -----------------------------------------------------------------------------

CREATE TABLE session_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  session_id             uuid NOT NULL,
  user_id                uuid NOT NULL,     -- denormalised for exclusion queries; FK-checked below
  subtopic_id            uuid NOT NULL,
  question_id            uuid NOT NULL,
  position               integer NOT NULL,
  selection_reason       text NOT NULL,
  difficulty_b_at_serve  numeric(8, 2) NOT NULL,
  theta_at_serve         numeric(8, 2) NOT NULL,
  target_b               numeric(8, 2),
  status                 text NOT NULL DEFAULT 'served',
  served_at              timestamptz NOT NULL DEFAULT now(),
  answered_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_items_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT session_items_attempt_target_uq UNIQUE (tenant_id, id, session_id, question_id),
  CONSTRAINT session_items_session_fk FOREIGN KEY (tenant_id, session_id, user_id, subtopic_id)
    REFERENCES sessions (tenant_id, id, user_id, subtopic_id),
  CONSTRAINT session_items_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT session_items_position_uq UNIQUE (session_id, position),
  CONSTRAINT session_items_question_once_uq UNIQUE (session_id, question_id),
  CONSTRAINT session_items_position_positive CHECK (position >= 1),
  CONSTRAINT session_items_reason_valid CHECK (selection_reason IN
    ('cold_start', 'placement', 'adaptive', 'probe', 'content_gap_fallback')),
  CONSTRAINT session_items_status_valid CHECK (status IN ('served', 'answered', 'skipped', 'abandoned')),
  CONSTRAINT session_items_answered_pair CHECK ((status = 'answered') = (answered_at IS NOT NULL)),
  CONSTRAINT session_items_time_order CHECK (answered_at IS NULL OR answered_at >= served_at)
);
-- 30-day exclusion and near-duplicate exclusion look up by student.
CREATE INDEX session_items_user_seen_idx ON session_items (tenant_id, user_id, subtopic_id, served_at DESC);
CREATE INDEX session_items_question_idx ON session_items (tenant_id, question_id);
CREATE TRIGGER session_items_set_updated_at BEFORE UPDATE ON session_items
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- -----------------------------------------------------------------------------
-- attempts: IMMUTABLE. Stores everything needed to replay the engine:
-- difficulty_b and version at answer time, the S score and the config version.
-- -----------------------------------------------------------------------------

CREATE TABLE attempts (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    uuid NOT NULL,
  user_id                      uuid NOT NULL,
  question_id                  uuid NOT NULL,
  question_version             integer NOT NULL,
  subtopic_id                  uuid NOT NULL,
  session_id                   uuid NOT NULL,
  session_item_id              uuid NOT NULL,
  idempotency_key              text NOT NULL,
  response                     jsonb NOT NULL,        -- {option_ids:[…]} | {value:"4.20"} | {matrix:{…}} | {text:"…"}
  outcome                      text NOT NULL,
  score                        numeric(4, 3),         -- S ∈ [0,1]; NULL when ungraded
  ttfi_ms                      integer,               -- time to first interaction
  total_time_ms                integer NOT NULL,
  answer_changes               smallint NOT NULL DEFAULT 0,
  hint_count                   smallint NOT NULL DEFAULT 0,
  difficulty_b_at_attempt      numeric(8, 2) NOT NULL,
  difficulty_label_at_attempt  smallint NOT NULL,
  theta_before                 numeric(8, 2) NOT NULL,
  expected_score               numeric(5, 4) NOT NULL,
  engine_config_id             uuid NOT NULL,
  device_type                  text NOT NULL DEFAULT 'unknown',
  is_probe                     boolean NOT NULL DEFAULT false,
  is_placement                 boolean NOT NULL DEFAULT false,
  probable_guess               boolean NOT NULL DEFAULT false,
  flagged_for_review           boolean NOT NULL DEFAULT false,
  client_submitted_at          timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT attempts_idempotency_uq  UNIQUE (tenant_id, user_id, idempotency_key),
  CONSTRAINT attempts_one_per_item_uq UNIQUE (session_item_id),
  CONSTRAINT attempts_user_fk     FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT attempts_question_fk FOREIGN KEY (tenant_id, question_id) REFERENCES questions (tenant_id, id),
  CONSTRAINT attempts_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  -- same user and sub-topic as the session …
  CONSTRAINT attempts_session_fk  FOREIGN KEY (tenant_id, session_id, user_id, subtopic_id)
    REFERENCES sessions (tenant_id, id, user_id, subtopic_id),
  -- … and the question must be the one actually served in that item
  CONSTRAINT attempts_item_fk     FOREIGN KEY (tenant_id, session_item_id, session_id, question_id)
    REFERENCES session_items (tenant_id, id, session_id, question_id),
  CONSTRAINT attempts_config_fk   FOREIGN KEY (tenant_id, engine_config_id) REFERENCES engine_config (tenant_id, id),
  CONSTRAINT attempts_idempotency_format CHECK (length(idempotency_key) BETWEEN 8 AND 128
                                                AND idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  CONSTRAINT attempts_version_positive CHECK (question_version >= 1),
  CONSTRAINT attempts_response_object  CHECK (jsonb_typeof(response) = 'object'),
  CONSTRAINT attempts_outcome_valid    CHECK (outcome IN ('correct', 'incorrect', 'partial', 'ungraded')),
  -- Written as CASE + coalesce so a NULL score can never satisfy a graded outcome
  -- (a CHECK that evaluates to NULL passes).
  CONSTRAINT attempts_score_matches    CHECK (CASE outcome
    WHEN 'correct'   THEN coalesce(score = 1, false)
    WHEN 'incorrect' THEN coalesce(score = 0, false)
    WHEN 'partial'   THEN coalesce(score > 0 AND score < 1, false)
    WHEN 'ungraded'  THEN score IS NULL
    ELSE false END),
  CONSTRAINT attempts_times            CHECK (total_time_ms BETWEEN 0 AND 86400000
                                              AND (ttfi_ms IS NULL OR (ttfi_ms >= 0 AND ttfi_ms <= total_time_ms))),
  CONSTRAINT attempts_counters         CHECK (answer_changes >= 0 AND hint_count >= 0),
  CONSTRAINT attempts_label_range      CHECK (difficulty_label_at_attempt BETWEEN 1 AND 5),
  CONSTRAINT attempts_expected_range   CHECK (expected_score BETWEEN 0 AND 1),
  CONSTRAINT attempts_device_valid     CHECK (device_type IN ('desktop', 'tablet', 'mobile', 'unknown'))
);
CREATE INDEX attempts_user_subtopic_idx ON attempts (tenant_id, user_id, subtopic_id, created_at, id);
CREATE INDEX attempts_user_time_idx ON attempts (tenant_id, user_id, created_at DESC);
CREATE INDEX attempts_question_idx ON attempts (tenant_id, question_id, created_at);
CREATE INDEX attempts_subtopic_time_idx ON attempts (tenant_id, subtopic_id, created_at);

CREATE TRIGGER attempts_immutable BEFORE UPDATE OR DELETE ON attempts
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation('immutable');
CREATE TRIGGER attempts_no_truncate BEFORE TRUNCATE ON attempts
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation('immutable');

-- -----------------------------------------------------------------------------
-- ability_scores: projection of attempts per student × sub-topic.
-- Rebuildable at any time by replaying attempts in (created_at, id) order.
-- -----------------------------------------------------------------------------

CREATE TABLE ability_scores (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  user_id                uuid NOT NULL,
  subtopic_id            uuid NOT NULL,
  theta                  numeric(8, 2) NOT NULL,
  level                  smallint NOT NULL,
  attempts_count         integer NOT NULL DEFAULT 0,
  graded_count           integer NOT NULL DEFAULT 0,
  correct_count          integer NOT NULL DEFAULT 0,
  consecutive_correct    smallint NOT NULL DEFAULT 0,
  consecutive_incorrect  smallint NOT NULL DEFAULT 0,
  placement_status       text NOT NULL DEFAULT 'not_started',
  placement_answered     smallint NOT NULL DEFAULT 0,
  last_attempt_id        uuid,
  last_attempt_at        timestamptz,
  last_decay_applied_at  timestamptz,
  engine_config_id       uuid NOT NULL,
  rebuilt_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ability_scores_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT ability_scores_user_subtopic_uq UNIQUE (tenant_id, user_id, subtopic_id),
  CONSTRAINT ability_scores_user_fk     FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT ability_scores_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT ability_scores_attempt_fk  FOREIGN KEY (tenant_id, last_attempt_id) REFERENCES attempts (tenant_id, id),
  CONSTRAINT ability_scores_config_fk   FOREIGN KEY (tenant_id, engine_config_id) REFERENCES engine_config (tenant_id, id),
  CONSTRAINT ability_scores_level_range CHECK (level BETWEEN 1 AND 5),
  CONSTRAINT ability_scores_theta_range CHECK (theta BETWEEN -1000 AND 5000),
  CONSTRAINT ability_scores_counts      CHECK (attempts_count >= 0 AND graded_count >= 0 AND correct_count >= 0
                                               AND graded_count <= attempts_count AND correct_count <= graded_count),
  CONSTRAINT ability_scores_streaks     CHECK (consecutive_correct >= 0 AND consecutive_incorrect >= 0
                                               AND (consecutive_correct = 0 OR consecutive_incorrect = 0)),
  CONSTRAINT ability_scores_placement   CHECK (placement_status IN ('not_started', 'in_progress', 'completed', 'skipped')
                                               AND placement_answered >= 0),
  CONSTRAINT ability_scores_last_pair   CHECK ((last_attempt_id IS NULL) = (last_attempt_at IS NULL))
);
CREATE INDEX ability_scores_subtopic_idx ON ability_scores (tenant_id, subtopic_id);
CREATE TRIGGER ability_scores_set_updated_at BEFORE UPDATE ON ability_scores
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- -----------------------------------------------------------------------------
-- session_events: focus tracking. Only whitelisted event types; there is no
-- free-form payload column, so nothing else (keystrokes, content) can be stored.
-- Rejected (AP003) when focus tracking was disabled for the session.
-- -----------------------------------------------------------------------------

CREATE TABLE session_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  session_id       uuid NOT NULL,
  user_id          uuid NOT NULL,
  subtopic_id      uuid NOT NULL,
  session_item_id  uuid,
  client_event_id  uuid NOT NULL,        -- client-generated; makes batch retries idempotent
  event_type       text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  duration_ms      integer,
  received_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_events_session_fk FOREIGN KEY (tenant_id, session_id, user_id, subtopic_id)
    REFERENCES sessions (tenant_id, id, user_id, subtopic_id),
  CONSTRAINT session_events_item_fk FOREIGN KEY (tenant_id, session_item_id) REFERENCES session_items (tenant_id, id),
  CONSTRAINT session_events_client_uq UNIQUE (session_id, client_event_id),
  CONSTRAINT session_events_type_valid CHECK (event_type IN (
    'visibility_hidden', 'visibility_visible',     -- tab switch count / duration
    'app_background', 'app_foreground',             -- app switch count / duration
    'first_interaction', 'answer_changed',          -- TTFI, answer changes
    'idle_start', 'idle_end',                       -- idle time
    'break_start', 'break_end',                     -- breaks
    'explanation_opened', 'explanation_closed')),   -- explanation engagement
  CONSTRAINT session_events_duration CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  CONSTRAINT session_events_clock_skew CHECK (occurred_at <= received_at + interval '5 minutes')
);
CREATE INDEX session_events_session_idx ON session_events (tenant_id, session_id, occurred_at);

CREATE TRIGGER session_events_no_update BEFORE UPDATE ON session_events
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation('append-only');

CREATE FUNCTION app_session_events_require_tracking() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id AND focus_tracking_enabled) THEN
    RAISE EXCEPTION 'focus tracking is disabled for session %', NEW.session_id USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_events_require_tracking BEFORE INSERT ON session_events
  FOR EACH ROW EXECUTE FUNCTION app_session_events_require_tracking();
