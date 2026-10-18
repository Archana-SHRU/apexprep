-- =============================================================================
-- 0017_mock_tests
--
-- Mock test papers, sections, test items, timed sessions, and question responses.
-- Enables full-length and sectional test simulations with server-side timed countdown,
-- negative marking schemes (+4 / -1), and immutable test result storage.
-- =============================================================================

CREATE TABLE IF NOT EXISTS mock_tests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  track_id                uuid REFERENCES tracks (id) ON DELETE SET NULL,
  title                   text NOT NULL,
  description             text,
  kind                    text NOT NULL DEFAULT 'full_length' CHECK (kind IN ('full_length', 'sectional')),
  duration_minutes        integer NOT NULL DEFAULT 180 CHECK (duration_minutes > 0),
  total_marks             integer NOT NULL DEFAULT 300 CHECK (total_marks > 0),
  default_positive_marks  numeric(5, 2) NOT NULL DEFAULT 4.00,
  default_negative_marks  numeric(5, 2) NOT NULL DEFAULT 1.00,
  status                  text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  instructions            text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mock_tests_tenant_id_id_uq UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS mock_tests_tenant_status_idx ON mock_tests (tenant_id, status);

CREATE TABLE IF NOT EXISTS test_sections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id           uuid NOT NULL REFERENCES mock_tests (id) ON DELETE CASCADE,
  name              text NOT NULL,
  subject_id        uuid REFERENCES subjects (id) ON DELETE SET NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  duration_minutes  integer,
  instructions      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_sections_test_id_id_uq UNIQUE (test_id, id)
);

CREATE INDEX IF NOT EXISTS test_sections_test_sort_idx ON test_sections (test_id, sort_order);

CREATE TABLE IF NOT EXISTS test_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id         uuid NOT NULL REFERENCES mock_tests (id) ON DELETE CASCADE,
  section_id      uuid NOT NULL REFERENCES test_sections (id) ON DELETE CASCADE,
  question_id     uuid NOT NULL REFERENCES questions (id) ON DELETE RESTRICT,
  sort_order      integer NOT NULL DEFAULT 0,
  positive_marks  numeric(5, 2) NOT NULL DEFAULT 4.00,
  negative_marks  numeric(5, 2) NOT NULL DEFAULT 1.00,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_items_test_id_id_uq UNIQUE (test_id, id)
);

CREATE INDEX IF NOT EXISTS test_items_test_section_idx ON test_items (test_id, section_id, sort_order);

CREATE TABLE IF NOT EXISTS test_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  test_id             uuid NOT NULL REFERENCES mock_tests (id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned', 'timed_out')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz NOT NULL,
  submitted_at        timestamptz,
  total_score         numeric(8, 2) DEFAULT 0.00,
  max_score           integer DEFAULT 0,
  correct_count       integer DEFAULT 0,
  incorrect_count     integer DEFAULT 0,
  unattempted_count   integer DEFAULT 0,
  accuracy            numeric(5, 2) DEFAULT 0.00,
  time_spent_sec      integer DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_sessions_tenant_id_id_uq UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS test_sessions_user_test_idx ON test_sessions (tenant_id, user_id, test_id);

CREATE TABLE IF NOT EXISTS test_item_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_session_id uuid NOT NULL REFERENCES test_sessions (id) ON DELETE CASCADE,
  test_item_id    uuid NOT NULL REFERENCES test_items (id) ON DELETE CASCADE,
  question_id     uuid NOT NULL REFERENCES questions (id) ON DELETE RESTRICT,
  response        jsonb,
  status          text NOT NULL DEFAULT 'not_visited' CHECK (status IN ('not_visited', 'not_answered', 'answered', 'marked_for_review', 'answered_and_marked')),
  is_correct      boolean,
  score           numeric(5, 2),
  outcome         text CHECK (outcome IN ('correct', 'incorrect', 'partial', 'ungraded', 'unattempted')),
  time_spent_sec  integer DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_item_responses_session_item_uq UNIQUE (test_session_id, test_item_id)
);

CREATE INDEX IF NOT EXISTS test_item_responses_session_idx ON test_item_responses (test_session_id);
