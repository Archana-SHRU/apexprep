-- =============================================================================
-- 002_dev_learning_contexts
--
-- Development seed, part 2: the learning-context metadata from migration 0013, and
-- the **track catalogue** of the approved product scope — school learning from
-- Class 1 to Class 12, the competitive exams, and the individual Olympiads.
--
-- WHAT THIS IS, AND WHAT IT IS NOT
--
-- Every track below is *metadata*: a name, a `kind`, and the grade or exam family
-- that says what it is. None of them is given a subject, chapter, question or line
-- of theory here. A Class 1–12 syllabus written into a seed file would be thousands
-- of rows of invented schoolwork that looks authoritative and that no teacher has
-- checked. Real content arrives through the ingestion pipeline and the syllabus
-- admin API, attached to these tracks, from documents a person uploads and reviews.
-- Until then a learner can choose one of these tracks and the app shows its honest
-- "nothing published yet" states.
--
-- The only complete syllabus path in the development seed is the JEE Advanced one in
-- 001, which the adaptive engine, practice and explanation tests run against.
--
-- The catalogue lives in the seed rather than a migration because tracks belong to an
-- organisation: a migration cannot know which tenants exist. A real organisation gets
-- its tracks from its administrator through `POST /v1/admin/tracks`, which accepts
-- exactly these fields.
--
-- The metadata vocabulary (migration 0013, no new columns):
--   school            kind = 'school',           education_stage = 'school', grade_label = 'Class N', grade_ordinal = N
--   competitive exam  kind = 'competitive_exam', exam_family = 'JEE' | 'NEET'
--   Olympiad          kind = 'olympiad' — the authoritative Olympiad safety signal
--                     (DECISIONS.md B60); slugs also contain 'olympiad', so the
--                     configured slug-pattern fallback agrees with it.
-- No curriculum/board is set on the school tracks: the product scope names none, and
-- inventing one here is exactly what 0013 declined to do.
--
-- Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING, so re-running is safe and an
-- administrator's later edits to these rows are never overwritten.
-- =============================================================================

-- The same guard 001 carries: this file writes development content, so it must never run against a
-- database the runner has not explicitly unlocked.
DO $$
BEGIN
  IF current_setting('apexprep.allow_dev_seed', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'dev seed refused: run it through `npm run db:seed` (NODE_ENV must not be production)';
  END IF;
END $$;

-- ---------------------------------------------------------------- existing track
-- The JEE track predates migration 0013, so its learning context is NULL. Filling it
-- in here is what an admin would do for a real track, and it is only safe because this
-- is the development seed and the track is one we own. Nothing is back-filled in a
-- migration: see the header of 0013.
UPDATE tracks
   SET kind = 'competitive_exam', exam_family = 'JEE', education_stage = 'senior_secondary', locale = 'en-IN'
 WHERE id = 'd1000000-0000-4000-8000-000000000001'
   AND kind IS NULL;

-- Place it after JEE Main within the competitive group. Only while it still has the
-- sort order 001 gave it, so an order an admin has chosen is left alone.
UPDATE tracks SET sort_order = 202
 WHERE id = 'd1000000-0000-4000-8000-000000000001'
   AND sort_order = 0;

-- ---------------------------------------------------------------- retired Phase 8 fixture
-- Earlier versions of this file seeded "Class 5 Mathematics": a two-question school track
-- that existed only to prove the platform was not exam-specific. It is not the school
-- product, and it is replaced by the Class 1–12 tracks below; the end-to-end proof now
-- lives in test/e2e/generalisation.e2e-spec.ts, which builds its own school track.
--
-- A development database seeded before this change still has it, so it is retired here
-- the way the platform retires any track: archived and soft-deleted. Its sub-topics stop
-- being live (subtopic_paths.is_live), so its fixture questions and theory become
-- unreachable, and nothing is hard-deleted — attempts and audit history stay intact.
UPDATE tracks
   SET status = 'archived', deleted_at = now()
 WHERE id = 'd1000000-0000-4000-8000-000000000002'
   AND slug = 'class-5-mathematics'
   AND deleted_at IS NULL;

-- ---------------------------------------------------------------- school: Class 1 – Class 12
-- grade_ordinal orders the classes and nothing else; it is not a difficulty (0013, B66).
INSERT INTO tracks (id, tenant_id, slug, name, short_name, kind, education_stage, grade_label, grade_ordinal,
                    locale, sort_order, status)
SELECT ('d1000000-0000-4000-8000-000000000' || (100 + g)::text)::uuid,
       'd0000000-0000-4000-8000-000000000001',
       'class-' || g, 'Class ' || g, 'Class ' || g,
       'school', 'school', 'Class ' || g, g,
       'en-IN', 100 + g, 'published'
FROM generate_series(1, 12) AS g
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- competitive exams
-- JEE Advanced is the track seeded by 001 (d1…0001); JEE Main and NEET join it.
INSERT INTO tracks (id, tenant_id, slug, name, short_name, description, kind, education_stage, exam_family,
                    locale, sort_order, status) VALUES
  ('d1000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000001',
   'jee-main', 'JEE Main', 'JEE Main', 'Physics, Chemistry and Mathematics for engineering admission.',
   'competitive_exam', 'senior_secondary', 'JEE', 'en-IN', 201, 'published'),
  ('d1000000-0000-4000-8000-000000000203', 'd0000000-0000-4000-8000-000000000001',
   'neet', 'NEET', 'NEET', 'Physics, Chemistry and Biology for medical admission.',
   'competitive_exam', 'senior_secondary', 'NEET', 'en-IN', 203, 'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO subjects (id, tenant_id, track_id, slug, name, color_hex, sort_order, status) VALUES
  ('d2000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000201', 'physics', 'Physics', '#4361EE', 1, 'published'),
  ('d2000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000201', 'chemistry', 'Chemistry', '#E056FD', 2, 'published'),
  ('d2000000-0000-4000-8000-000000000203', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000201', 'mathematics', 'Mathematics', '#2ECC71', 3, 'published'),
  ('d2000000-0000-4000-8000-000000000204', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000203', 'physics', 'Physics', '#4361EE', 1, 'published'),
  ('d2000000-0000-4000-8000-000000000205', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000203', 'chemistry', 'Chemistry', '#E056FD', 2, 'published'),
  ('d2000000-0000-4000-8000-000000000206', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000203', 'biology', 'Biology', '#10B981', 3, 'published')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- Olympiads
-- One track per Olympiad, as the product has always modelled them: the four in the
-- platform's content scope (README). More are added as tracks, not as code.
INSERT INTO tracks (id, tenant_id, slug, name, short_name, kind, locale, sort_order, status) VALUES
  ('d1000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000001',
   'physics-olympiad', 'Physics Olympiad', 'Physics', 'olympiad', 'en-IN', 301, 'published'),
  ('d1000000-0000-4000-8000-000000000302', 'd0000000-0000-4000-8000-000000000001',
   'chemistry-olympiad', 'Chemistry Olympiad', 'Chemistry', 'olympiad', 'en-IN', 302, 'published'),
  ('d1000000-0000-4000-8000-000000000303', 'd0000000-0000-4000-8000-000000000001',
   'mathematics-olympiad', 'Mathematics Olympiad', 'Mathematics', 'olympiad', 'en-IN', 303, 'published'),
  ('d1000000-0000-4000-8000-000000000304', 'd0000000-0000-4000-8000-000000000001',
   'astronomy-olympiad', 'Astronomy Olympiad', 'Astronomy', 'olympiad', 'en-IN', 304, 'published')
ON CONFLICT (id) DO NOTHING;
