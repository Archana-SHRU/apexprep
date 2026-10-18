-- Checks the development seed when it is loaded (the SQL test runner loads it first).
BEGIN;

DO $$
DECLARE
  dev uuid := 'd0000000-0000-4000-8000-000000000001';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = dev) THEN
    RAISE NOTICE 'skip dev seed not loaded';
    RETURN;
  END IF;

  PERFORM pg_temp.ok((SELECT name FROM tenants WHERE id = dev) LIKE '%DEV ONLY%', 'the seed tenant is labelled development-only');
  -- One complete path: the JEE track. The rest of the track catalogue is metadata only; its content
  -- comes through the ingestion pipeline, never from the seed (database/seeds/dev/002_dev_learning_contexts.sql).
  PERFORM pg_temp.ok((SELECT count(*) FROM subtopic_paths WHERE tenant_id = dev AND is_live) = 1,
    'one complete Track → Subject → Chapter → Topic → Sub-topic path, on the JEE track');
  PERFORM pg_temp.ok(
    (SELECT bool_and(n = 3) AND count(*) = 5 FROM (
       SELECT q.difficulty_label, count(*) AS n
         FROM questions q JOIN subtopic_paths p ON p.tenant_id = q.tenant_id AND p.subtopic_id = q.primary_subtopic_id
        WHERE q.tenant_id = dev AND q.status = 'published' AND p.is_live
          AND p.track_id = 'd1000000-0000-4000-8000-000000000001'
        GROUP BY q.difficulty_label) s),
    'three published questions at each level L1–L5 on the exam track');
  PERFORM pg_temp.ok((SELECT count(DISTINCT type) FROM questions WHERE tenant_id = dev) = 7,
    'every question type is represented');
  PERFORM pg_temp.ok((SELECT bool_and(version = 1) FROM questions WHERE tenant_id = dev),
    'seeded questions are at version 1');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM questions q WHERE q.tenant_id = dev
       AND NOT EXISTS (SELECT 1 FROM official_solutions s WHERE s.question_id = q.id AND s.status = 'approved')) = 0,
    'every seeded question has an approved official solution');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM content_blocks
      WHERE tenant_id = dev AND kind = 'theory' AND status = 'published'
        AND subtopic_id = 'd5000000-0000-4000-8000-000000000001') = 6,
    'the sub-topic has published theory');

  -- ---------------------------------------------------------------- Phase 8: learning contexts
  PERFORM pg_temp.ok(
    (SELECT kind = 'competitive_exam' AND exam_family = 'JEE' FROM tracks WHERE id = 'd1000000-0000-4000-8000-000000000001'),
    'the exam track says what kind of learning context it is');
  -- The track catalogue of the product scope: Class 1–12, the competitive exams, the Olympiads.
  PERFORM pg_temp.ok(
    (SELECT count(*) = 12
            AND bool_and(education_stage = 'school' AND grade_label = 'Class ' || grade_ordinal AND name = grade_label)
            AND min(grade_ordinal) = 1 AND max(grade_ordinal) = 12 AND count(DISTINCT grade_ordinal) = 12
       FROM tracks WHERE tenant_id = dev AND kind = 'school' AND status = 'published' AND deleted_at IS NULL),
    'one published school track per class, Class 1 to Class 12, each carrying its grade');
  PERFORM pg_temp.ok(
    (SELECT array_agg(name || ':' || exam_family ORDER BY sort_order) = ARRAY['JEE Main:JEE', 'JEE Advanced:JEE', 'NEET:NEET']
       FROM tracks WHERE tenant_id = dev AND kind = 'competitive_exam' AND status = 'published' AND deleted_at IS NULL),
    'JEE Main, JEE Advanced and NEET are competitive-exam tracks with their exam family');
  PERFORM pg_temp.ok(
    (SELECT count(*) = 4 AND bool_and(slug LIKE '%olympiad%')
       FROM tracks WHERE tenant_id = dev AND kind = 'olympiad' AND status = 'published' AND deleted_at IS NULL),
    'each Olympiad is its own track, marked by kind and matched by the slug fallback too');
  -- The catalogue is metadata: the seed invents no syllabus for it.
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM subjects s JOIN tracks t ON t.id = s.track_id
      WHERE t.tenant_id = dev AND t.deleted_at IS NULL AND s.deleted_at IS NULL
        AND t.id <> 'd1000000-0000-4000-8000-000000000001') = 0,
    'no subjects, questions or theory are seeded for the catalogue tracks');
  -- The Phase 8 "Class 5 Mathematics" fixture is not part of the catalogue.
  PERFORM pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM tracks WHERE tenant_id = dev AND slug = 'class-5-mathematics' AND deleted_at IS NULL),
    'the retired Class 5 Mathematics fixture is not a live track');
  -- No enrolment rows are seeded: 0013 back-fills nothing and the seed invents no learner's choices.
  PERFORM pg_temp.ok((SELECT count(*) FROM learner_tracks WHERE tenant_id = dev) = 0,
    'the seed enrols nobody: an enrolment is a learner’s own decision');
  PERFORM pg_temp.ok((SELECT (params ->> 'provisional')::boolean FROM engine_config WHERE tenant_id = dev AND is_active),
    'the active engine config is flagged provisional');
  PERFORM pg_temp.ok((SELECT (params ->> 'target_success')::numeric FROM engine_config WHERE tenant_id = dev AND is_active) = 0.72,
    'target success is 0.72');
  PERFORM pg_temp.ok(
    (SELECT bool_and(q.difficulty_b = (c.params -> 'initial_b_by_level' ->> q.difficulty_label::text)::numeric)
       FROM questions q JOIN engine_config c ON c.tenant_id = q.tenant_id AND c.is_active WHERE q.tenant_id = dev),
    'initial difficulty_b matches initial_b_by_level in the config');
END $$;

ROLLBACK;
