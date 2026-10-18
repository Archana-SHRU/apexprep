-- Question answer shapes, publish validation, versioning, content and review rules.
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;   -- run the deferred publish validator at statement end

DO $$
DECLARE
  t     uuid := pg_temp.fx_tenant('qbank');
  t2    uuid := pg_temp.fx_tenant('qbank-other');
  st    uuid := pg_temp.fx_subtopic(t);
  st2   uuid := pg_temp.fx_subtopic(t);
  u     uuid := pg_temp.fx_user(t, 'student@qbank.test');
  q     uuid;
  mq    uuid;
  good  uuid := pg_temp.fx_question(t, st, 3);
  ins   text := format('INSERT INTO questions (tenant_id, primary_subtopic_id, type, stem, difficulty_label, difficulty_b,
                          expected_time_seconds, correct_numeric, numeric_tolerance, tolerance_mode) VALUES (%L, %L, ', t, st);
BEGIN
  -- answer-key shape ---------------------------------------------------------
  PERFORM pg_temp.expect_error(ins || '''numeric'', ''x'', 2, 1000, 60, 4.2, NULL, NULL)', '23514',
    'a numeric question needs a tolerance');
  PERFORM pg_temp.expect_error(ins || '''integer'', ''x'', 2, 1000, 60, 2.5, 0, ''absolute'')', '23514',
    'an integer question needs a whole-number answer');
  PERFORM pg_temp.expect_error(ins || '''single_correct'', ''x'', 2, 1000, 60, 3, 0, ''absolute'')', '23514',
    'an option-based question cannot carry a numeric answer');
  PERFORM pg_temp.expect_error(ins || '''single_correct'', ''x'', 6, 1000, 60, NULL, NULL, NULL)', '23514',
    'difficulty labels are limited to L1–L5');

  -- publish validation (AP002) -------------------------------------------------
  INSERT INTO questions (tenant_id, primary_subtopic_id, type, stem, difficulty_label, difficulty_b, expected_time_seconds)
  VALUES (t, st, 'single_correct', 'Two correct answers?', 2, 1000, 60) RETURNING id INTO q;
  INSERT INTO question_options (tenant_id, question_id, option_key, body, is_correct)
  VALUES (t, q, 'A', 'a', true), (t, q, 'B', 'b', true);
  PERFORM pg_temp.expect_error(format('UPDATE questions SET status = ''published'', published_at = now() WHERE id = %L', q),
    'AP002', 'single-correct with two correct options cannot be published');
  UPDATE question_options SET is_correct = false WHERE question_id = q AND option_key = 'B';
  PERFORM pg_temp.expect_ok(format('UPDATE questions SET status = ''published'', published_at = now() WHERE id = %L', q),
    'single-correct with exactly one correct option publishes');
  PERFORM pg_temp.expect_error(format('UPDATE question_options SET is_correct = false WHERE question_id = %L', q),
    'AP002', 'removing the only correct option of a published question is rejected');

  INSERT INTO questions (tenant_id, primary_subtopic_id, type, stem, difficulty_label, difficulty_b, expected_time_seconds, matrix_answer)
  VALUES (t, st, 'matrix_match', 'Match', 4, 1400, 120, '{"A": ["p"], "B": ["z"]}') RETURNING id INTO mq;
  INSERT INTO question_options (tenant_id, question_id, option_key, side, body) VALUES
    (t, mq, 'A', 'left', 'a'), (t, mq, 'B', 'left', 'b'), (t, mq, 'p', 'right', 'p'), (t, mq, 'q', 'right', 'q');
  PERFORM pg_temp.expect_error(format('UPDATE questions SET status = ''published'', published_at = now() WHERE id = %L', mq),
    'AP002', 'matrix answer values must be right-column items');
  UPDATE questions SET matrix_answer = '{"A": ["p"]}' WHERE id = mq;
  PERFORM pg_temp.expect_error(format('UPDATE questions SET status = ''published'', published_at = now() WHERE id = %L', mq),
    'AP002', 'every left-column item needs an answer');
  UPDATE questions SET matrix_answer = '{"A": ["p"], "B": ["p", "q"]}' WHERE id = mq;
  PERFORM pg_temp.expect_ok(format('UPDATE questions SET status = ''published'', published_at = now() WHERE id = %L', mq),
    'a complete matrix-match question publishes');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO question_options (tenant_id, question_id, option_key, side, body, is_correct) VALUES (%L, %L, ''r'', ''right'', ''r'', true)', t, mq),
    '23514', 'matrix columns never carry an is_correct flag');

  -- versioning -----------------------------------------------------------------
  PERFORM pg_temp.ok((SELECT version FROM questions WHERE id = good) = 1, 'a freshly published question is version 1');
  UPDATE questions SET difficulty_b = difficulty_b + 12.5, calibration_n = calibration_n + 1 WHERE id = good;
  PERFORM pg_temp.ok((SELECT version FROM questions WHERE id = good) = 1, 'engine calibration does not bump the version');
  -- S6.4 replaces expected_time_seconds with the observed median. That is calibration, not an edit:
  -- if it bumped the version it would invalidate every cached explanation for the question and make
  -- the 30th attempt on a popular question an AI bill.
  UPDATE questions SET expected_time_seconds = expected_time_seconds + 30 WHERE id = good;
  PERFORM pg_temp.ok((SELECT version FROM questions WHERE id = good) = 1,
                     'recalibrating the expected time does not bump the version');
  UPDATE questions SET stem = 'Edited stem' WHERE id = good;
  PERFORM pg_temp.ok((SELECT version FROM questions WHERE id = good) = 2, 'editing the stem bumps the version');
  UPDATE question_options SET body = 'Edited option' WHERE question_id = good AND option_key = 'B';
  PERFORM pg_temp.ok((SELECT version FROM questions WHERE id = good) = 3, 'editing an option of a published question bumps the version');

  -- secondary sub-topics -------------------------------------------------------
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO question_secondary_subtopics (tenant_id, question_id, subtopic_id) VALUES (%L, %L, %L)', t, good, st),
    'AP004', 'the primary sub-topic cannot also be a secondary one');
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO question_secondary_subtopics (tenant_id, question_id, subtopic_id) VALUES (%L, %L, %L)', t, good, st2),
    'a different sub-topic can be secondary');

  -- official solutions & explanations -----------------------------------------
  INSERT INTO official_solutions (tenant_id, question_id, body, status, approved_at) VALUES (t, good, 'Solution 1', 'approved', now());
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO official_solutions (tenant_id, question_id, body, status, approved_at) VALUES (%L, %L, ''Solution 2'', ''approved'', now())', t, good),
    '23505', 'a question has at most one approved official solution');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content)
     VALUES (%L, %L, 3, ''rag_grounded'', ''gemini'', ''m'', ''{}'')', t, good),
    '23514', 'a RAG explanation must record grounding score, sources and scope');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, content) VALUES (%L, %L, 3, ''general_ai'', ''{}'')', t, good),
    '23514', 'an AI explanation must record provider and model');

  -- Distractor variants (migration 0011) ---------------------------------------
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content)
     VALUES (%L, %L, 3, ''general_ai'', ''gemini'', ''m'', ''{}'')', t, good),
    'the question-level explanation is the one with no option key');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content)
     VALUES (%L, %L, 3, ''general_ai'', ''gemini'', ''m'', ''{}'')', t, good),
    '23505', 'a question version has at most one active question-level explanation');
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content, option_key)
     VALUES (%L, %L, 3, ''general_ai'', ''gemini'', ''m'', ''{}'', ''B'')', t, good),
    'a distractor variant coexists with the question-level explanation');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content, option_key)
     VALUES (%L, %L, 3, ''general_ai'', ''gemini'', ''m'', ''{}'', ''B'')', t, good),
    '23505', 'but only one active variant per option');
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content, option_key)
     VALUES (%L, %L, 3, ''general_ai'', ''gemini'', ''m'', ''{}'', ''C'')', t, good),
    'a different option gets its own variant');
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content, option_key, status)
     VALUES (%L, %L, 3, ''general_ai'', ''gemini'', ''m'', ''{}'', ''B'', ''superseded'')', t, good),
    'a superseded variant is kept alongside the active one, never deleted');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, provider, model, content, option_key)
     VALUES (%L, %L, 4, ''general_ai'', ''gemini'', ''m'', ''{}'', ''not an option key'')', t, good),
    '23514', 'an option key is 1-4 letters or digits');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO explanations (tenant_id, question_id, question_version, source_tier, official_solution_id, content, option_key)
     SELECT %L, %L, 4, ''official_solution'', id, ''{}'', ''B'' FROM official_solutions WHERE question_id = %L', t, good, good),
    '23514', 'an official solution is never a distractor variant');
  PERFORM pg_temp.ok(
    (SELECT count(*) = 4 FROM explanations WHERE tenant_id = t AND question_id = good),
    'every explanation written above is still there: nothing is deleted to make room');

  -- content blocks --------------------------------------------------------------
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_blocks (tenant_id, kind, raw_text, content_hash, status) VALUES (%L, ''ambiguous'', ''?'', %L, ''approved'')',
    t, repeat('a', 64)),
    '23514', 'an ambiguous block cannot be approved before reclassification');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_blocks (tenant_id, kind, raw_text, content_hash, status, published_at) VALUES (%L, ''theory'', ''x'', %L, ''published'', now())',
    t, repeat('a', 64)),
    '23514', 'a published block must be tagged to a sub-topic');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_blocks (tenant_id, kind, raw_text, content_hash, source_page) VALUES (%L, ''theory'', ''x'', %L, 3)',
    t, repeat('a', 64)),
    '23514', 'a source page is only valid together with its source asset');

  -- SHA-256 duplicate check on uploads ---------------------------------------
  INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256)
  VALUES (t, 'source_pdf', 'k/1.pdf', 'application/pdf', 1024, repeat('b', 64));
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256)
     VALUES (%L, ''source_pdf'', ''k/2.pdf'', ''application/pdf'', 1024, %L)', t, repeat('b', 64)),
    '23505', 'the same PDF cannot be uploaded twice into one tenant');
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256)
     VALUES (%L, ''source_pdf'', ''k/3.pdf'', ''application/pdf'', 1024, %L)', t2, repeat('b', 64)),
    'another tenant may upload the same PDF');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256)
     VALUES (%L, ''figure'', ''k/4.svg'', ''image/svg+xml'', 10, %L)', t, repeat('c', 64)),
    '23514', 'SVG uploads are rejected');

  -- review queue ----------------------------------------------------------------
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, question_id, reporter_user_id) VALUES (%L, ''student_report'', %L, %L)', t, good, u),
    '23514', 'a student report needs a reason from the allowed list');
  INSERT INTO review_tasks (tenant_id, kind, question_id, reporter_user_id, reason) VALUES (t, 'student_report', good, u, 'typo');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, question_id, reporter_user_id, reason) VALUES (%L, ''student_report'', %L, %L, ''unclear'')', t, good, u),
    '23505', 'a student can have only one open report per question');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, status) VALUES (%L, ''question_review'', ''open'')', t),
    '23514', 'a review task must point at something');
END $$;

ROLLBACK;
