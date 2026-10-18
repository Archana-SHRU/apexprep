-- Composite (tenant_id, id) foreign keys make cross-tenant references impossible.
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  a        uuid := pg_temp.fx_tenant('iso-a');
  b        uuid := pg_temp.fx_tenant('iso-b');
  st_a     uuid := pg_temp.fx_subtopic(a);
  st_b     uuid := pg_temp.fx_subtopic(b);
  user_a   uuid := pg_temp.fx_user(a, 'student@iso.test');
  user_b   uuid := pg_temp.fx_user(b, 'student@iso.test');   -- same email, other tenant: allowed
  q_a      uuid := pg_temp.fx_question(a, st_a);
  q_b      uuid := pg_temp.fx_question(b, st_b);
  cfg_a    uuid := pg_temp.fx_config(a);
  cfg_b    uuid := pg_temp.fx_config(b);
  track_a  uuid := (SELECT id FROM tracks WHERE tenant_id = a LIMIT 1);
  sess_b   uuid;
BEGIN
  PERFORM pg_temp.ok(user_a <> user_b, 'the same email can exist once per tenant');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO subjects (tenant_id, track_id, slug, name) VALUES (%L, %L, ''x'', ''X'')', b, track_a),
    '23503', 'subject in tenant B cannot hang off a track of tenant A');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO questions (tenant_id, primary_subtopic_id, type, stem, difficulty_label, difficulty_b, expected_time_seconds)
     VALUES (%L, %L, ''single_correct'', ''x'', 1, 800, 60)', b, st_a),
    '23503', 'question in tenant B cannot reference a sub-topic of tenant A');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO sessions (tenant_id, user_id, subtopic_id, engine_config_id, focus_tracking_enabled)
     VALUES (%L, %L, %L, %L, true)', b, user_a, st_b, cfg_b),
    '23503', 'session in tenant B cannot belong to a user of tenant A');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO sessions (tenant_id, user_id, subtopic_id, engine_config_id, focus_tracking_enabled)
     VALUES (%L, %L, %L, %L, true)', b, user_b, st_b, cfg_a),
    '23503', 'session in tenant B cannot use the engine config of tenant A');

  sess_b := pg_temp.fx_session(b, user_b, st_b, cfg_b);
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO session_items (tenant_id, session_id, user_id, subtopic_id, question_id, position, selection_reason,
       difficulty_b_at_serve, theta_at_serve) VALUES (%L, %L, %L, %L, %L, 1, ''adaptive'', 1000, 1000)',
    b, sess_b, user_b, st_b, q_a),
    '23503', 'tenant B cannot be served a question of tenant A');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO question_options (tenant_id, question_id, option_key, body) VALUES (%L, %L, ''E'', ''x'')', b, q_a),
    '23503', 'tenant B cannot add an option to a question of tenant A');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, question_id, reporter_user_id, reason)
     VALUES (%L, ''student_report'', %L, %L, ''typo'')', b, q_a, user_b),
    '23503', 'tenant B cannot file a report against a question of tenant A');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO users (tenant_id, email, password_hash, display_name) VALUES (%L, ''student@iso.test'', %L, ''Dup'')',
    a, pg_temp.fx_hash()),
    '23505', 'email is unique within a tenant');
END $$;

ROLLBACK;
