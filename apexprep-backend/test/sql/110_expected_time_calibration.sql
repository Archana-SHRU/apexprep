-- =============================================================================
-- §6.4: expected_time_seconds is admin-set at first, and replaced by the observed
-- median once calibration_n reaches the stated threshold of 30.
--
-- This file asserts the database-level behaviour of that statement: the median
-- itself, the threshold, which attempts count, the bounds, and the two properties
-- that make it safe to run inside the attempt transaction (no version bump, and
-- past attempts unchanged).
--
-- It mirrors PracticeRepository.recalibrateExpectedTime. The statement below is
-- kept identical to the one the repository issues, apart from the parameters:
-- if you change one, change both, or this file stops testing anything.
-- =============================================================================

BEGIN;

DO $do$
DECLARE
  t uuid; u uuid; sub uuid; q uuid; cfg uuid; sess uuid; itm uuid;
  admin_set int := 60;   -- what pg_temp.fx_question sets
  i int;
  times int[];
BEGIN
  t   := pg_temp.fx_tenant('exp-time-' || substr(md5(random()::text), 1, 8));
  u   := pg_temp.fx_user(t, 'student-' || substr(md5(random()::text), 1, 8) || '@example.test');
  sub := pg_temp.fx_subtopic(t);
  q   := pg_temp.fx_question(t, sub);
  cfg := pg_temp.fx_config(t);

  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = admin_set,
                     'a new question keeps the expected time an admin set');

  -- 29 graded attempts, each in its own session because a question is served at most
  -- once per session. Times 100s..128s, so the median of the first 29 is 114s.
  FOR i IN 1..29 LOOP
    sess := pg_temp.fx_session(t, u, sub, cfg);
    itm  := pg_temp.fx_item(t, sess, u, sub, q);
    EXECUTE pg_temp.attempt_sql(t, u, q, sub, sess, itm, cfg, 'expected-time-' || lpad(i::text, 3, '0'),
                                'correct', '1', '1500', ((99 + i) * 1000)::text);
    -- One live session per student per sub-topic, so each fixture session is closed behind us.
    UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = sess;
  END LOOP;
  UPDATE questions SET calibration_n = 29 WHERE id = q;

  -- ---------------------------------------------------------------- the threshold
  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = admin_set,
                     '29 attempts is below the stated threshold, so the admin value stands');

  -- The 30th attempt. Times are now 100..129, median = (114 + 115) / 2 = 114.5 -> 115.
  -- Exactly .5 on purpose: percentile_cont returns double precision, and round() on a float rounds
  -- half to even (114), not half away from zero (115). The statement casts to numeric so this is
  -- 115 on every platform; that cast is what this assertion pins down.
  sess := pg_temp.fx_session(t, u, sub, cfg);
  itm  := pg_temp.fx_item(t, sess, u, sub, q);
  EXECUTE pg_temp.attempt_sql(t, u, q, sub, sess, itm, cfg, 'expected-time-030', 'correct', '1', '1500', '129000');
  UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = sess;
  UPDATE questions SET calibration_n = 30 WHERE id = q;

  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 115,
                     'at 30 attempts the observed median replaces the admin estimate');

  -- ---------------------------------------------------------------- the median, not the mean
  -- One student who leaves the tab open for two hours. A mean would move by four minutes;
  -- the median moves by half a second, which is the whole reason §6.4 says median.
  sess := pg_temp.fx_session(t, u, sub, cfg);
  itm  := pg_temp.fx_item(t, sess, u, sub, q);
  EXECUTE pg_temp.attempt_sql(t, u, q, sub, sess, itm, cfg, 'expected-time-outlier', 'correct', '1', '1500', '7200000');
  UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = sess;
  UPDATE questions SET calibration_n = 31 WHERE id = q;
  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 115,
                     'a two-hour outlier moves the median by less than a second');
  PERFORM pg_temp.ok(
    (SELECT round(avg(total_time_ms) / 1000.0) FROM attempts WHERE question_id = q) > 300,
    'the mean of the same attempts is above five minutes, which is what the median avoids');

  -- ---------------------------------------------------------------- probable guesses
  -- Ten three-second guesses. Excluded, the median is unchanged; included, it collapses —
  -- and a collapsed expected time shortens the guess threshold, which is the feedback loop
  -- the exclusion exists to prevent.
  FOR i IN 1..10 LOOP
    sess := pg_temp.fx_session(t, u, sub, cfg);
    itm  := pg_temp.fx_item(t, sess, u, sub, q);
    EXECUTE format(
      'INSERT INTO attempts (tenant_id, user_id, question_id, question_version, subtopic_id, session_id, session_item_id,
         idempotency_key, response, outcome, score, ttfi_ms, total_time_ms, difficulty_b_at_attempt,
         difficulty_label_at_attempt, theta_before, expected_score, calibration_n_at_attempt,
         expected_time_seconds_at_attempt, engine_config_id, probable_guess)
       VALUES (%L, %L, %L, 1, %L, %L, %L, %L, ''{"option_keys": ["B"]}'', ''incorrect'', 0, 400, 3000, 1000, 2, 1000,
               0.72, 30, 115, %L, true)',
      t, u, q, sub, sess, itm, 'expected-time-guess-' || lpad(i::text, 3, '0'), cfg);
    UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = sess;
  END LOOP;

  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 115,
                     'ten guesses do not move the median, because guesses are excluded');

  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, false, 5, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) < 115,
                     'counting guesses would drag the median down: the exclusion is load-bearing');
  UPDATE questions SET expected_time_seconds = 115 WHERE id = q;  -- back to the honest value

  -- ---------------------------------------------------------------- ungraded answers
  -- A long-form answer waiting to be marked has outcome 'ungraded'. The student still spent that
  -- long on the question, which is exactly what is being measured, so it counts. (A *skip* records
  -- no attempt row at all — it lives on session_items.status — so there is nothing to exclude.)
  sess := pg_temp.fx_session(t, u, sub, cfg);
  itm  := pg_temp.fx_item(t, sess, u, sub, q);
  EXECUTE format(
    'INSERT INTO attempts (tenant_id, user_id, question_id, question_version, subtopic_id, session_id, session_item_id,
       idempotency_key, response, outcome, score, ttfi_ms, total_time_ms, difficulty_b_at_attempt,
       difficulty_label_at_attempt, theta_before, expected_score, calibration_n_at_attempt,
       expected_time_seconds_at_attempt, engine_config_id)
     VALUES (%L, %L, %L, 1, %L, %L, %L, ''expected-time-longform'', ''{"text": "a written answer"}'',
             ''ungraded'', NULL, 1500, 400000, 1000, 2, 1000, 0.72, 30, 115, %L)',
    t, u, q, sub, sess, itm, cfg);
  UPDATE sessions SET status = 'completed', ended_at = now() WHERE id = sess;
  -- 32 values now (100..129, the 7200 s outlier, and this 400 s answer): median 115.5 -> 116.
  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 116,
                     'an ungraded long-form answer counts towards the median');

  -- ---------------------------------------------------------------- the bounds
  -- The clamp is the same range the admin field is validated against
  -- (questions_expected_time_range, migration 0004), so calibration can never store a value
  -- an admin could not have typed — and never a value the CHECK would reject.
  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 200, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 200,
                     'the observed median is raised to the floor when it falls below it');
  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 30);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 30,
                     'the observed median is capped at the ceiling');

  -- ---------------------------------------------------------------- idempotence
  -- Called with the real bounds again, it returns to the observed median and then stays there:
  -- the second call writes no row at all, because the statement's own WHERE clause sees no change.
  PERFORM pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 7200);
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 116,
                     'a clamped value returns to the observed median once the bounds allow it');
  PERFORM pg_temp.ok(pg_temp.recalibrate_expected_time(t, q, 30, true, 5, 7200) IS NULL,
                     'recalibrating again reports no change, and updates no row');
  PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q) = 116,
                     'recalibrating twice with the same attempts changes nothing');

  -- ---------------------------------------------------------------- replay determinism
  -- The two properties the user required: calibration is not an edit, and an attempt already
  -- recorded is replayed against the value that was in force when it was answered.
  PERFORM pg_temp.ok((SELECT version FROM questions WHERE id = q) = 1,
                     'none of this bumped the question version, so cached explanations survive');
  PERFORM pg_temp.ok(
    (SELECT count(DISTINCT expected_time_seconds_at_attempt) FROM attempts
      WHERE question_id = q AND idempotency_key LIKE 'expected-time-0%') = 1,
    'every attempt still carries the expected time it was actually answered against');
  PERFORM pg_temp.ok(
    (SELECT expected_time_seconds_at_attempt FROM attempts WHERE question_id = q AND idempotency_key = 'expected-time-001') = 60,
    'the first attempt is still replayable against the original admin estimate');

  -- ---------------------------------------------------------------- tenant isolation
  DECLARE
    t2 uuid; sub2 uuid; q2 uuid;
  BEGIN
    t2   := pg_temp.fx_tenant('exp-time-other-' || substr(md5(random()::text), 1, 8));
    sub2 := pg_temp.fx_subtopic(t2);
    q2   := pg_temp.fx_question(t2, sub2);
    UPDATE questions SET calibration_n = 30 WHERE id = q2;
    -- The other organisation's question id, with this organisation's tenant id.
    PERFORM pg_temp.recalibrate_expected_time(t, q2, 30, true, 5, 7200);
    PERFORM pg_temp.ok((SELECT expected_time_seconds FROM questions WHERE id = q2) = 60,
                       'calibration cannot reach another organisation’s question');
  END;
END $do$;

ROLLBACK;
