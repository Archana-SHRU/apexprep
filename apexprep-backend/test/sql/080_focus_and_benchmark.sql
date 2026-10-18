-- Focus tracking honours the off switch and stores only whitelisted events.
-- Benchmarks keep nothing about cohorts below the minimum size.
BEGIN;

DO $$
DECLARE
  t      uuid := pg_temp.fx_tenant('focus');
  st     uuid := pg_temp.fx_subtopic(t);
  u      uuid := pg_temp.fx_user(t, 'student@focus.test');
  cfg    uuid := pg_temp.fx_config(t);
  s_on   uuid := pg_temp.fx_session(t, u, st, cfg, true);
  s_off  uuid;
  ev     text := 'INSERT INTO session_events (tenant_id, session_id, user_id, subtopic_id, client_event_id, event_type, occurred_at, duration_ms)
                  VALUES (%L, %L, %L, %L, %L, %L, now(), 1200)';
  cid    uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.expect_ok(format(ev, t, s_on, u, st, cid, 'visibility_hidden'), 'a tab-switch event is recorded when tracking is on');
  PERFORM pg_temp.expect_error(format(ev, t, s_on, u, st, cid, 'visibility_hidden'),
    '23505', 'retrying a batch cannot duplicate an event (client_event_id)');
  PERFORM pg_temp.expect_error(format(ev, t, s_on, u, st, gen_random_uuid(), 'keystroke'),
    '23514', 'non-whitelisted event types (e.g. keystrokes) are rejected');
  PERFORM pg_temp.expect_error('UPDATE session_events SET duration_ms = 0', 'AP001', 'focus events are append-only');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO session_events (tenant_id, session_id, user_id, subtopic_id, client_event_id, event_type, occurred_at)
     VALUES (%L, %L, %L, %L, gen_random_uuid(), ''idle_start'', now() + interval ''1 hour'')', t, s_on, u, st),
    '23514', 'events stamped far in the future are rejected');

  UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = s_on;
  s_off := pg_temp.fx_session(t, u, st, cfg, false);
  PERFORM pg_temp.expect_error(format(ev, t, s_off, u, st, gen_random_uuid(), 'visibility_hidden'),
    'AP003', 'no focus events can be stored when tracking is disabled for the session');

  -- benchmarks ---------------------------------------------------------------
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO benchmark_snapshots (tenant_id, subtopic_id, snapshot_date, window_days, window_start, window_end,
       qualifying_students, min_qualifying_students, top_k, is_published, top_accuracy, top_median_time_ms, engine_config_id)
     VALUES (%L, %L, current_date, 90, now() - interval ''90 days'', now(), 12, 30, 10, true, 0.91, 84000, %L)', t, st, cfg),
    '23514', 'a benchmark cannot be published below the minimum cohort size');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO benchmark_snapshots (tenant_id, subtopic_id, snapshot_date, window_days, window_start, window_end,
       qualifying_students, min_qualifying_students, top_k, is_published, top_accuracy, top_median_time_ms, engine_config_id)
     VALUES (%L, %L, current_date, 90, now() - interval ''90 days'', now(), 12, 30, 10, false, 0.91, NULL, %L)', t, st, cfg),
    '23514', 'a withheld snapshot retains no values');
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO benchmark_snapshots (tenant_id, subtopic_id, snapshot_date, window_days, window_start, window_end,
       qualifying_students, min_qualifying_students, top_k, is_published, top_accuracy, top_median_time_ms, engine_config_id)
     VALUES (%L, %L, current_date, 90, now() - interval ''90 days'', now(), 45, 30, 10, true, 0.91, 84000, %L)', t, st, cfg),
    'a benchmark over a qualifying cohort is published');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO benchmark_snapshots (tenant_id, subtopic_id, snapshot_date, window_days, window_start, window_end,
       qualifying_students, min_qualifying_students, top_k, is_published, engine_config_id)
     VALUES (%L, %L, current_date, 90, now() - interval ''90 days'', now(), 5, 30, 10, false, %L)', t, st, cfg),
    '23505', 'one snapshot per sub-topic, level and day');
  PERFORM pg_temp.ok((SELECT count(*) FROM information_schema.columns WHERE table_name = 'benchmark_snapshots'
                        AND column_name ~ '(user|student)_id') = 0,
    'benchmark snapshots have no column that could identify a student');
END $$;

ROLLBACK;
