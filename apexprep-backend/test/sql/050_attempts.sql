-- Attempts are immutable, idempotent per client key, and must match what was served.
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  t      uuid := pg_temp.fx_tenant('attempts');
  st     uuid := pg_temp.fx_subtopic(t);
  u      uuid := pg_temp.fx_user(t, 'one@attempts.test');
  u2     uuid := pg_temp.fx_user(t, 'two@attempts.test');
  q1     uuid := pg_temp.fx_question(t, st, 2);
  q2     uuid := pg_temp.fx_question(t, st, 3);
  cfg    uuid := pg_temp.fx_config(t);
  s      uuid := pg_temp.fx_session(t, u, st, cfg);
  s2     uuid := pg_temp.fx_session(t, u2, st, cfg);
  i1     uuid := pg_temp.fx_item(t, s, u, st, q1, 1);
  i2     uuid := pg_temp.fx_item(t, s, u, st, q2, 2);
  i3     uuid;
BEGIN
  PERFORM pg_temp.expect_ok(pg_temp.attempt_sql(t, u, q1, st, s, i1, cfg, 'key-0001-aaaa'), 'a valid attempt is stored');

  PERFORM pg_temp.expect_error('UPDATE attempts SET score = 0, outcome = ''incorrect''', 'AP001', 'attempts cannot be updated');
  PERFORM pg_temp.expect_error('DELETE FROM attempts', 'AP001', 'attempts cannot be deleted');
  PERFORM pg_temp.expect_error('TRUNCATE attempts CASCADE', 'AP001', 'attempts cannot be truncated');

  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0001-aaaa'),
    '23505', 'reusing an idempotency key for the same student is rejected');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q1, st, s, i1, cfg, 'key-0002-bbbb'),
    '23505', 'a served item accepts only one attempt');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q1, st, s, i2, cfg, 'key-0003-cccc'),
    '23503', 'the attempt''s question must be the one served in that item');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u2, q2, st, s, i2, cfg, 'key-0004-dddd'),
    '23503', 'another student cannot answer inside this student''s session');

  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0005-eeee', 'correct', '0'),
    '23514', 'outcome and score must agree (correct ⇒ S = 1)');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0006-ffff', 'ungraded', '0'),
    '23514', 'an ungraded attempt carries no score');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0008-hhhh', 'correct', 'NULL'),
    '23514', 'a graded outcome cannot have a NULL score');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0009-iiii', 'partial', '1'),
    '23514', 'partial credit must be strictly between 0 and 1');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0007-gggg', 'correct', '1', '40000', '30000'),
    '23514', 'time to first interaction cannot exceed total time');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'bad key!'),
    '23514', 'idempotency keys are validated');

  -- Migration 0010: the two engine inputs the row snapshots so the update can be replayed.
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0010-jjjj', 'correct', '1', '1500', '30000', '-1'),
    '23514', 'a negative calibration count is rejected');
  PERFORM pg_temp.expect_error(pg_temp.attempt_sql(t, u, q2, st, s, i2, cfg, 'key-0011-kkkk', 'correct', '1', '1500', '30000', '50', '0'),
    '23514', 'the snapshotted expected time must be a real solving time');
  PERFORM pg_temp.ok(
    (SELECT calibration_n_at_attempt = 50 AND expected_time_seconds_at_attempt = 60 FROM attempts WHERE idempotency_key = 'key-0001-aaaa' AND user_id = u),
    'the engine inputs are stored alongside theta_before and difficulty_b_at_attempt');

  PERFORM pg_temp.expect_ok(pg_temp.attempt_sql(t, u2, q1, st, s2, pg_temp.fx_item(t, s2, u2, st, q1, 1), cfg, 'key-0001-aaaa'),
    'a different student may use the same idempotency key');

  -- An abandoned item never turns into an incorrect attempt: it simply has none.
  UPDATE session_items SET status = 'abandoned' WHERE id = i2;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM attempts WHERE session_item_id = i2),
    'an abandoned served item produces no attempt');
  PERFORM pg_temp.expect_error(format('UPDATE session_items SET status = ''answered'' WHERE id = %L', i2),
    '23514', 'an item cannot be marked answered without answered_at');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO sessions (tenant_id, user_id, subtopic_id, engine_config_id, focus_tracking_enabled) VALUES (%L, %L, %L, %L, true)',
    t, u, st, cfg),
    '23505', 'a student has at most one active session per sub-topic');

  i3 := pg_temp.fx_item(t, s, u, st, pg_temp.fx_question(t, st, 4), 3);
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO session_items (tenant_id, session_id, user_id, subtopic_id, question_id, position, selection_reason,
       difficulty_b_at_serve, theta_at_serve) VALUES (%L, %L, %L, %L, %L, 4, ''adaptive'', 1000, 1000)', t, s, u, st, q1),
    '23505', 'a question is served at most once per session');
  PERFORM pg_temp.ok((SELECT count(*) FROM attempts WHERE tenant_id = t) = 2, 'exactly the two valid attempts were stored');
END $$;

ROLLBACK;
