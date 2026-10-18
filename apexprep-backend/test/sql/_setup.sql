-- =============================================================================
-- Loaded into the same session before every test file (see scripts/run-sql-tests.ts).
-- Defines session-local (pg_temp) assertion helpers and fixtures only; creates
-- no permanent objects. Test files wrap their work in BEGIN … ROLLBACK.
-- =============================================================================

SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL %', label;
  END IF;
  RAISE NOTICE 'ok   %', label;
END $$;

-- Runs stmt in a subtransaction and asserts it fails with expected_state.
CREATE OR REPLACE FUNCTION pg_temp.expect_error(stmt text, expected_state text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_state THEN
      RAISE NOTICE 'ok   %', label;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL %: expected SQLSTATE %, got % (%)', label, expected_state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL %: expected SQLSTATE %, but the statement succeeded', label, expected_state;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(stmt text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'ok   %', label;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FAIL %: % (%)', label, SQLERRM, SQLSTATE;
END $$;

-- ---------------------------------------------------------------- fixtures

CREATE OR REPLACE FUNCTION pg_temp.fx_tenant(p_slug text) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO tenants (slug, name) VALUES (p_slug, 'Test tenant ' || p_slug) RETURNING id
$$;

-- A syntactically valid argon2id encoding (not a real password hash).
CREATE OR REPLACE FUNCTION pg_temp.fx_hash() RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$ZmFrZWhhc2hmb3J0ZXN0c29ubHlub3RyZWFsMTIzNDU2Nzg'
$f$;

CREATE OR REPLACE FUNCTION pg_temp.fx_user(p_tenant uuid, p_email text, p_role text DEFAULT 'STUDENT') RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO users (tenant_id, email, password_hash, role, display_name)
  VALUES (p_tenant, p_email, pg_temp.fx_hash(), p_role, 'Test user') RETURNING id
$$;

-- Track → Subject → Chapter → Topic → Sub-topic; returns the sub-topic id.
CREATE OR REPLACE FUNCTION pg_temp.fx_subtopic(p_tenant uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_sfx text := substr(md5(random()::text), 1, 8);
  v_track uuid; v_subject uuid; v_chapter uuid; v_topic uuid; v_sub uuid;
BEGIN
  INSERT INTO tracks (tenant_id, slug, name) VALUES (p_tenant, 'track-' || v_sfx, 'Track') RETURNING id INTO v_track;
  INSERT INTO subjects (tenant_id, track_id, slug, name) VALUES (p_tenant, v_track, 'subject-' || v_sfx, 'Subject') RETURNING id INTO v_subject;
  INSERT INTO chapters (tenant_id, subject_id, slug, name) VALUES (p_tenant, v_subject, 'chapter-' || v_sfx, 'Chapter') RETURNING id INTO v_chapter;
  INSERT INTO topics (tenant_id, chapter_id, slug, name) VALUES (p_tenant, v_chapter, 'topic-' || v_sfx, 'Topic') RETURNING id INTO v_topic;
  INSERT INTO subtopics (tenant_id, topic_id, slug, name) VALUES (p_tenant, v_topic, 'subtopic-' || v_sfx, 'Sub-topic') RETURNING id INTO v_sub;
  RETURN v_sub;
END $$;

-- Published single-correct question with options A (correct) … D.
CREATE OR REPLACE FUNCTION pg_temp.fx_question(p_tenant uuid, p_subtopic uuid, p_level int DEFAULT 2) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_q uuid;
BEGIN
  INSERT INTO questions (tenant_id, primary_subtopic_id, type, stem, difficulty_label, difficulty_b, expected_time_seconds)
  VALUES (p_tenant, p_subtopic, 'single_correct', 'Fixture question ' || gen_random_uuid(), p_level, 800 + 200 * (p_level - 1), 60)
  RETURNING id INTO v_q;
  INSERT INTO question_options (tenant_id, question_id, option_key, body, is_correct, sort_order) VALUES
    (p_tenant, v_q, 'A', 'right', true, 0), (p_tenant, v_q, 'B', 'wrong 1', false, 1),
    (p_tenant, v_q, 'C', 'wrong 2', false, 2), (p_tenant, v_q, 'D', 'wrong 3', false, 3);
  UPDATE questions SET status = 'published', published_at = now() WHERE id = v_q;
  RETURN v_q;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.fx_config(p_tenant uuid, p_actor uuid DEFAULT NULL) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO engine_config (tenant_id, version, params, change_note, created_by, is_active, activated_at, activated_by)
  VALUES (p_tenant,
          (SELECT coalesce(max(version), 0) + 1 FROM engine_config WHERE tenant_id = p_tenant),
          '{"elo_scale": 400}', 'fixture', p_actor, true, now(), p_actor)
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION pg_temp.fx_session(p_tenant uuid, p_user uuid, p_subtopic uuid, p_config uuid,
                                              p_focus boolean DEFAULT true) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO sessions (tenant_id, user_id, subtopic_id, engine_config_id, focus_tracking_enabled)
  VALUES (p_tenant, p_user, p_subtopic, p_config, p_focus) RETURNING id
$$;

CREATE OR REPLACE FUNCTION pg_temp.fx_item(p_tenant uuid, p_session uuid, p_user uuid, p_subtopic uuid,
                                           p_question uuid, p_position int DEFAULT 1) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO session_items (tenant_id, session_id, user_id, subtopic_id, question_id, position, selection_reason,
                             difficulty_b_at_serve, theta_at_serve)
  VALUES (p_tenant, p_session, p_user, p_subtopic, p_question, p_position, 'adaptive', 1000, 1000) RETURNING id
$$;

-- SQL text for an attempt insert, so tests can vary one field at a time.
CREATE OR REPLACE FUNCTION pg_temp.attempt_sql(p_tenant uuid, p_user uuid, p_question uuid, p_subtopic uuid,
    p_session uuid, p_item uuid, p_config uuid, p_key text,
    p_outcome text DEFAULT 'correct', p_score text DEFAULT '1', p_ttfi text DEFAULT '1500', p_total text DEFAULT '30000',
    p_calibration_n text DEFAULT '50', p_expected_time text DEFAULT '60')
RETURNS text LANGUAGE sql AS $$
  SELECT format(
    'INSERT INTO attempts (tenant_id, user_id, question_id, question_version, subtopic_id, session_id, session_item_id,
       idempotency_key, response, outcome, score, ttfi_ms, total_time_ms, difficulty_b_at_attempt,
       difficulty_label_at_attempt, theta_before, expected_score, calibration_n_at_attempt,
       expected_time_seconds_at_attempt, engine_config_id)
     VALUES (%L, %L, %L, 1, %L, %L, %L, %L, ''{"option_keys": ["A"]}'', %L, %s, %s, %s, 1000, 2, 1000, 0.72, %s, %s, %L)',
    p_tenant, p_user, p_question, p_subtopic, p_session, p_item, p_key, p_outcome, p_score, p_ttfi, p_total,
    p_calibration_n, p_expected_time, p_config)
$$;

-- §6.4 expected-time recalibration, as PracticeRepository.recalibrateExpectedTime issues it.
-- Kept identical to that statement apart from its parameters: if you change one, change both.
CREATE OR REPLACE FUNCTION pg_temp.recalibrate_expected_time(
  p_tenant uuid, p_question uuid, p_min_attempts int, p_exclude_guesses boolean,
  p_min_seconds int, p_max_seconds int) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_seconds int;
BEGIN
  WITH observed AS (
    SELECT count(*) AS sample_n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a.total_time_ms) AS median_ms
      FROM attempts a
     WHERE a.tenant_id = p_tenant
       AND a.question_id = p_question
       AND a.total_time_ms IS NOT NULL
       AND (NOT p_exclude_guesses OR a.probable_guess = false)
  ), proposed AS (
    SELECT least(greatest(round((median_ms / 1000.0)::numeric)::int, p_min_seconds), p_max_seconds) AS seconds,
           sample_n, median_ms
      FROM observed
  )
  UPDATE questions q
     SET expected_time_seconds = proposed.seconds
    FROM proposed
   WHERE q.tenant_id = p_tenant
     AND q.id = p_question
     AND q.calibration_n >= p_min_attempts
     AND proposed.median_ms IS NOT NULL
     AND proposed.sample_n > 0
     AND q.expected_time_seconds <> proposed.seconds
  RETURNING q.expected_time_seconds INTO v_seconds;
  RETURN v_seconds;
END $$;
