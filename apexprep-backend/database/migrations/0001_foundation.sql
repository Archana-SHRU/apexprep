-- =============================================================================
-- 0001_foundation
-- Extensions, shared trigger functions, tenants, users, auth tokens, audit_log.
--
-- Conventions used by every migration:
--   * uuid primary keys (gen_random_uuid, core since PG13)
--   * tenant-owned tables carry tenant_id and expose UNIQUE (tenant_id, id) so that
--     children can use composite foreign keys: a row can never reference a row that
--     belongs to another tenant.
--   * enumerations are text + CHECK
--   * custom SQLSTATEs:  AP001 immutable / append-only violation
--                        AP002 publish validation failed
--                        AP003 focus tracking disabled
--                        AP004 invalid cross-row state
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- digest(), gen_random_bytes()
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram similarity: keyword search, near-duplicates

-- -----------------------------------------------------------------------------
-- Shared trigger functions
-- -----------------------------------------------------------------------------

CREATE FUNCTION app_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Raises AP001. TG_ARGV[0] describes the rule ("append-only", "immutable", ...).
CREATE FUNCTION app_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on "%" is not allowed: the table is %', TG_OP, TG_TABLE_NAME, TG_ARGV[0]
    USING ERRCODE = 'AP001';
END $$;

-- -----------------------------------------------------------------------------
-- tenants
-- -----------------------------------------------------------------------------

CREATE TABLE tenants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    text NOT NULL,
  name                    text NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  benchmarking_enabled    boolean NOT NULL DEFAULT true,
  focus_tracking_enabled  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT tenants_slug_format    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 63),
  CONSTRAINT tenants_name_nonblank  CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT tenants_status_valid   CHECK (status IN ('active', 'suspended'))
);
CREATE UNIQUE INDEX tenants_slug_uq ON tenants (slug) WHERE deleted_at IS NULL;
CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- -----------------------------------------------------------------------------
-- users (students and staff; student profile fields are nullable for staff)
-- -----------------------------------------------------------------------------

CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  email                   text NOT NULL,
  email_verified_at       timestamptz,
  password_hash           text NOT NULL,
  role                    text NOT NULL DEFAULT 'STUDENT',
  status                  text NOT NULL DEFAULT 'active',
  display_name            text NOT NULL,
  -- student profile ------------------------------------------------------------
  primary_track_id        uuid,               -- FK added in 0002 (tracks does not exist yet)
  goal_text               text,
  target_rank             integer,
  daily_question_goal     integer,
  target_exam_date        date,
  onboarded_at            timestamptz,
  focus_tracking_opt_out  boolean NOT NULL DEFAULT false,
  -- security -------------------------------------------------------------------
  token_version           integer NOT NULL DEFAULT 0,  -- bump to invalidate every issued access token
  failed_login_count      integer NOT NULL DEFAULT 0,
  locked_until            timestamptz,
  last_login_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT users_tenant_id_id_uq        UNIQUE (tenant_id, id),
  CONSTRAINT users_email_format           CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  CONSTRAINT users_email_lowercase        CHECK (email = lower(email)),
  -- Plaintext can never be stored: only argon2id encoded hashes are accepted.
  CONSTRAINT users_password_hash_argon2id CHECK (password_hash LIKE '$argon2id$%' AND length(password_hash) BETWEEN 60 AND 255),
  CONSTRAINT users_role_valid             CHECK (role IN ('STUDENT', 'ADMIN', 'SUPER_ADMIN')),
  CONSTRAINT users_status_valid           CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_display_name_nonblank  CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT users_goal_text_length       CHECK (goal_text IS NULL OR length(goal_text) <= 200),
  CONSTRAINT users_target_rank_positive   CHECK (target_rank IS NULL OR target_rank > 0),
  CONSTRAINT users_daily_goal_range       CHECK (daily_question_goal IS NULL OR daily_question_goal BETWEEN 1 AND 1000),
  CONSTRAINT users_token_version_nonneg   CHECK (token_version >= 0),
  CONSTRAINT users_failed_login_nonneg    CHECK (failed_login_count >= 0)
);
CREATE UNIQUE INDEX users_tenant_email_uq ON users (tenant_id, email) WHERE deleted_at IS NULL;
CREATE INDEX users_tenant_role_idx ON users (tenant_id, role, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- -----------------------------------------------------------------------------
-- refresh_tokens: opaque rotating refresh tokens, stored as SHA-256 only.
-- Presenting a revoked token revokes the whole family (theft detection).
-- -----------------------------------------------------------------------------

CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  family_id       uuid NOT NULL,
  token_hash      bytea NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  replaced_by_id  uuid REFERENCES refresh_tokens (id),
  user_agent      text,
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT refresh_tokens_hash_len        CHECK (octet_length(token_hash) = 32),
  CONSTRAINT refresh_tokens_expiry_order    CHECK (expires_at > issued_at),
  CONSTRAINT refresh_tokens_reason_valid    CHECK (revoked_reason IS NULL OR revoked_reason IN
                                              ('rotated', 'logout', 'reuse_detected', 'admin', 'password_change')),
  CONSTRAINT refresh_tokens_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT refresh_tokens_user_agent_len  CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);
CREATE UNIQUE INDEX refresh_tokens_hash_uq ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_live_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- user_tokens: single-use hashed tokens (email verification, password reset)
-- -----------------------------------------------------------------------------

CREATE TABLE user_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  purpose      text NOT NULL,
  token_hash   bytea NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_tokens_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_tokens_purpose_valid CHECK (purpose IN ('email_verification', 'password_reset')),
  CONSTRAINT user_tokens_hash_len      CHECK (octet_length(token_hash) = 32),
  CONSTRAINT user_tokens_expiry_order  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX user_tokens_hash_uq ON user_tokens (token_hash);
CREATE INDEX user_tokens_user_open_idx ON user_tokens (user_id, purpose) WHERE consumed_at IS NULL;

-- -----------------------------------------------------------------------------
-- audit_log: append-only. No FK on actor/entity so history survives any deletion.
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants (id),   -- NULL only for platform-level events
  actor_user_id  uuid,                           -- NULL = system
  actor_role     text NOT NULL,
  action         text NOT NULL,                  -- e.g. engine_config.activated
  entity_type    text NOT NULL,
  entity_id      uuid,
  before         jsonb,
  after          jsonb,
  request_id     text,
  ip             inet,
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_actor_role_valid CHECK (actor_role IN ('STUDENT', 'ADMIN', 'SUPER_ADMIN', 'SYSTEM')),
  CONSTRAINT audit_log_system_actor     CHECK ((actor_role = 'SYSTEM') = (actor_user_id IS NULL)),
  CONSTRAINT audit_log_action_format    CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' AND length(action) <= 100),
  CONSTRAINT audit_log_entity_format    CHECK (entity_type ~ '^[a-z][a-z_]*$' AND length(entity_type) <= 64),
  CONSTRAINT audit_log_before_object    CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  CONSTRAINT audit_log_after_object     CHECK (after IS NULL OR jsonb_typeof(after) = 'object'),
  CONSTRAINT audit_log_request_id_len   CHECK (request_id IS NULL OR length(request_id) <= 128),
  CONSTRAINT audit_log_user_agent_len   CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);
CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC) WHERE actor_user_id IS NOT NULL;

CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation('append-only');
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation('append-only');

-- Helper for database-originated audit rows (used by engine_config triggers).
-- Resolves the actor's role; a NULL actor is recorded as SYSTEM.
CREATE FUNCTION app_write_audit(
  p_tenant_id uuid, p_actor_user_id uuid, p_action text,
  p_entity_type text, p_entity_id uuid, p_before jsonb, p_after jsonb
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_role text;
BEGIN
  IF p_actor_user_id IS NULL THEN
    v_role := 'SYSTEM';
  ELSE
    SELECT role INTO v_role FROM users WHERE id = p_actor_user_id;
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'audit actor % does not exist', p_actor_user_id USING ERRCODE = 'AP004';
    END IF;
  END IF;
  INSERT INTO audit_log (tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, before, after)
  VALUES (p_tenant_id, p_actor_user_id, v_role, p_action, p_entity_type, p_entity_id, p_before, p_after);
END $$;
