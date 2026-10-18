-- =============================================================================
-- 0018_mock_test_hardening
--
-- Server-side timing and single-active-session guarantees for mock tests.
--
--   * test_sessions.active_item_id / active_since — which question the student currently has
--     open and since when (server clock). Time on a question is the server's own measurement of
--     how long that question was the open one, added up when the student moves on, submits or
--     the deadline passes. The client no longer decides how much time it spent.
--   * test_item_responses.time_spent_ms — millisecond precision for that accumulation.
--     `time_spent_sec` is kept and stays in step, so existing readers are unaffected.
--   * one in_progress session per student per test, enforced by a partial unique index.
--
-- Compatible with existing data: every change is additive, existing rows are backfilled, and the
-- only rows touched are older duplicate in_progress sessions, which are marked `abandoned`
-- (a value the status check already allows) so the unique index can be created. Nothing is deleted.
-- =============================================================================

ALTER TABLE test_sessions
  ADD COLUMN IF NOT EXISTS active_item_id uuid REFERENCES test_items (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS active_since   timestamptz;

ALTER TABLE test_item_responses
  ADD COLUMN IF NOT EXISTS time_spent_ms integer NOT NULL DEFAULT 0 CHECK (time_spent_ms >= 0);

-- Existing rows carried whole seconds only.
UPDATE test_item_responses
   SET time_spent_ms = LEAST(COALESCE(time_spent_sec, 0), 2000000) * 1000
 WHERE time_spent_ms = 0 AND COALESCE(time_spent_sec, 0) > 0;

-- Older duplicates of an open session (the race this migration closes) are set aside, not deleted:
-- the most recently started one per student and test stays the open attempt.
UPDATE test_sessions s
   SET status = 'abandoned', updated_at = now()
 WHERE s.status = 'in_progress'
   AND EXISTS (
     SELECT 1 FROM test_sessions n
      WHERE n.tenant_id = s.tenant_id AND n.user_id = s.user_id AND n.test_id = s.test_id
        AND n.status = 'in_progress'
        AND (n.started_at, n.id) > (s.started_at, s.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS test_sessions_one_open_uq
  ON test_sessions (tenant_id, user_id, test_id)
  WHERE status = 'in_progress';

-- Finding expired-but-unfinalized sessions (the sweep and the lazy finalizer both look for them).
CREATE INDEX IF NOT EXISTS test_sessions_open_deadline_idx
  ON test_sessions (ends_at)
  WHERE status = 'in_progress';
