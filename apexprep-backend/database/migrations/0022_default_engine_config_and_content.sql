-- =============================================================================
-- 0022_default_engine_config_and_content
--
-- 1. Provisions the baseline adaptive-engine configuration (v1, active) for
--    'dev-sandbox' and any existing tenant missing an active configuration.
--    This resolves the deployment issue where ingestion PDF processing, practice,
--    explanations, and AI features fail with ENGINE_CONFIG_MISSING.
-- 2. Provisions the default track catalogue (Class 1-12, JEE Main, NEET, Olympiads).
-- 3. Provisions the baseline syllabus hierarchy (Physics, Chemistry, Mathematics,
--    Mechanics, Rotational Dynamics, Angular Momentum & Rolling) with published
--    theory and 15 practice questions (L1-L5).
-- 4. Provisions the baseline mock tests (JEE Simulation 1 & Physics Sectional).
-- 5. Provisions the default student user ('student@apexprep.dev').
--
-- Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING. Safe for all environments.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Baseline Active engine_config for dev-sandbox (and any unconfigured tenant)
-- -----------------------------------------------------------------------------

INSERT INTO engine_config (
  id, tenant_id, version, schema_version, params, change_note, is_active, activated_at
)
VALUES (
  'd8000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  1,
  1,
  $json${
    "provisional": true,
    "requirements_note": "Values marked in provisional_keys are NOT specified by the requirements; everything else follows the stated adaptive-engine requirements. Keys in safety_floor_keys are not tunable: a configuration that weakens one is rejected, not honoured.",
    "safety_floor_keys": ["explanation.require_attempt"],
    "provisional_keys": ["level_bands", "initial_b_by_level", "inactivity_decay.per_period_days",
                         "inactivity_decay.theta_points_per_period", "inactivity_decay.max_total_points",
                         "inactivity_decay.floor_theta", "near_duplicate.trigram_similarity",
                         "near_duplicate.exclude_days", "probable_guess.question_update",
                         "probe.updates_question_b", "exclusion_includes_skipped",
                         "benchmark.min_qualifying_students", "rag.top_k", "rag.widen_order",
                         "explanation.retrieval.vector_weight", "explanation.retrieval.min_chunks",
                         "explanation.retrieval.min_candidate_score",
                         "explanation.approval.mandatory_track_slug_patterns",
                         "explanation.approval.review_general_knowledge",
                         "ingestion.confidence.classification_min", "ingestion.confidence.mapping_min",
                         "ingestion.confidence.question_min", "ingestion.confidence.solution_min",
                         "ingestion.auto_approval.enabled", "ingestion.auto_approval.min_confidence",
                         "ingestion.auto_approval.mandatory_review_track_slug_patterns",
                         "ingestion.auto_approval.require_review_for_ocr",
                         "ingestion.approval_reversal_window_hours", "ingestion.ocr_min_page_chars"],
    "elo_scale": 400,
    "k_student": {"initial": 32, "initial_attempts": 20, "steady": 16,
                  "low_calibration_threshold": 10, "low_calibration_factor": 0.5},
    "k_question": {"uncalibrated": 24, "calibrated_after": 50, "steady": 8},
    "cold_start": {"level": 2, "seed_from_parent_topic": true},
    "level_bands": [
      {"level": 1, "theta_min": null, "theta_max": 900},
      {"level": 2, "theta_min": 900,  "theta_max": 1100},
      {"level": 3, "theta_min": 1100, "theta_max": 1300},
      {"level": 4, "theta_min": 1300, "theta_max": 1500},
      {"level": 5, "theta_min": 1500, "theta_max": null}
    ],
    "initial_b_by_level": {"1": 800, "2": 1000, "3": 1200, "4": 1400, "5": 1600},
    "target_success": 0.72,
    "placement": {"enabled": true, "question_count": 8},
    "promotion": {"consecutive_correct": 2, "within_expected_time_factor": 1.25, "window": 4, "correct_in_window": 3},
    "demotion": {"consecutive_incorrect": 2, "window": 5, "incorrect_in_window": 3},
    "l1_protection": {"block_demotion": true, "theta_floor": null},
    "l5_ceiling": {"block_promotion": true, "theta_cap": null},
    "probable_guess": {"requires_incorrect": true, "max_time_fraction_of_expected": 0.25,
                       "theta_update": "skip", "question_update": "skip",
                       "counts_towards_level": false, "pause_session_after": 3},
    "expected_time": {"recalibrate_after_attempts": 30, "exclude_probable_guesses": true,
                      "min_seconds": 5, "max_seconds": 7200},
    "probe": {"every_n": 5, "levels_above_target": 0.5, "updates_theta": true, "updates_question_b": true,
              "counts_towards_promotion": true, "counts_towards_demotion": false},
    "inactivity_decay": {"after_days": 21, "per_period_days": 7, "theta_points_per_period": 10,
                         "max_total_points": 150, "floor_theta": null},
    "exclusion_days": 30,
    "exclusion_includes_skipped": true,
    "near_duplicate": {"trigram_similarity": 0.85, "exclude_days": 30},
    "content_gap": {"min_eligible": 5, "widen_to_topic": true, "open_review_task": true},
    "benchmark": {"window_days": 90, "top_k": 10, "min_qualifying_students": 30},
    "rag": {"top_k": 5, "widen_order": ["subtopic", "topic", "chapter"]},
    "explanation": {
      "chunk": {"min_tokens": 500, "max_tokens": 800},
      "retrieval": {"vector_weight": 0.6, "min_chunks": 3, "min_candidate_score": 0.05},
      "grounding": {"notes_only_min": 0.75, "mostly_notes_min": 0.5},
      "approval": {"mandatory_track_slug_patterns": ["olympiad"], "review_general_knowledge": true},
      "reports": {"unpublish_threshold": 3},
      "require_attempt": true
    },
    "ingestion": {
      "confidence": {"classification_min": 0.7, "mapping_min": 0.6, "question_min": 0.7, "solution_min": 0.6},
      "auto_approval": {"enabled": true, "min_confidence": 0.9, "audit_sample_rate": 0.05,
                        "mandatory_review_difficulty_labels": [5],
                        "mandatory_review_track_slug_patterns": ["olympiad"],
                        "require_review_for_ocr": true},
      "approval_reversal_window_hours": 24,
      "ocr_min_page_chars": 40
    }
  }$json$::jsonb,
  'Baseline adaptive-engine configuration',
  true,
  now()
)
ON CONFLICT (id) DO NOTHING;

-- Also ensure any other tenant in the system has an active engine_config
INSERT INTO engine_config (id, tenant_id, version, schema_version, params, change_note, is_active, activated_at)
SELECT
  gen_random_uuid(),
  t.id,
  1,
  1,
  $json${
    "provisional": true,
    "requirements_note": "Baseline adaptive-engine parameters.",
    "safety_floor_keys": ["explanation.require_attempt"],
    "provisional_keys": ["level_bands", "initial_b_by_level", "inactivity_decay.per_period_days",
                         "inactivity_decay.theta_points_per_period", "inactivity_decay.max_total_points",
                         "inactivity_decay.floor_theta", "near_duplicate.trigram_similarity",
                         "near_duplicate.exclude_days", "probable_guess.question_update",
                         "probe.updates_question_b", "exclusion_includes_skipped",
                         "benchmark.min_qualifying_students", "rag.top_k", "rag.widen_order",
                         "explanation.retrieval.vector_weight", "explanation.retrieval.min_chunks",
                         "explanation.retrieval.min_candidate_score",
                         "explanation.approval.mandatory_track_slug_patterns",
                         "explanation.approval.review_general_knowledge",
                         "ingestion.confidence.classification_min", "ingestion.confidence.mapping_min",
                         "ingestion.confidence.question_min", "ingestion.confidence.solution_min",
                         "ingestion.auto_approval.enabled", "ingestion.auto_approval.min_confidence",
                         "ingestion.auto_approval.mandatory_review_track_slug_patterns",
                         "ingestion.auto_approval.require_review_for_ocr",
                         "ingestion.approval_reversal_window_hours", "ingestion.ocr_min_page_chars"],
    "elo_scale": 400,
    "k_student": {"initial": 32, "initial_attempts": 20, "steady": 16,
                  "low_calibration_threshold": 10, "low_calibration_factor": 0.5},
    "k_question": {"uncalibrated": 24, "calibrated_after": 50, "steady": 8},
    "cold_start": {"level": 2, "seed_from_parent_topic": true},
    "level_bands": [
      {"level": 1, "theta_min": null, "theta_max": 900},
      {"level": 2, "theta_min": 900,  "theta_max": 1100},
      {"level": 3, "theta_min": 1100, "theta_max": 1300},
      {"level": 4, "theta_min": 1300, "theta_max": 1500},
      {"level": 5, "theta_min": 1500, "theta_max": null}
    ],
    "initial_b_by_level": {"1": 800, "2": 1000, "3": 1200, "4": 1400, "5": 1600},
    "target_success": 0.72,
    "placement": {"enabled": true, "question_count": 8},
    "promotion": {"consecutive_correct": 2, "within_expected_time_factor": 1.25, "window": 4, "correct_in_window": 3},
    "demotion": {"consecutive_incorrect": 2, "window": 5, "incorrect_in_window": 3},
    "l1_protection": {"block_demotion": true, "theta_floor": null},
    "l5_ceiling": {"block_promotion": true, "theta_cap": null},
    "probable_guess": {"requires_incorrect": true, "max_time_fraction_of_expected": 0.25,
                       "theta_update": "skip", "question_update": "skip",
                       "counts_towards_level": false, "pause_session_after": 3},
    "expected_time": {"recalibrate_after_attempts": 30, "exclude_probable_guesses": true,
                      "min_seconds": 5, "max_seconds": 7200},
    "probe": {"every_n": 5, "levels_above_target": 0.5, "updates_theta": true, "updates_question_b": true,
              "counts_towards_promotion": true, "counts_towards_demotion": false},
    "inactivity_decay": {"after_days": 21, "per_period_days": 7, "theta_points_per_period": 10,
                         "max_total_points": 150, "floor_theta": null},
    "exclusion_days": 30,
    "exclusion_includes_skipped": true,
    "near_duplicate": {"trigram_similarity": 0.85, "exclude_days": 30},
    "content_gap": {"min_eligible": 5, "widen_to_topic": true, "open_review_task": true},
    "benchmark": {"window_days": 90, "top_k": 10, "min_qualifying_students": 30},
    "rag": {"top_k": 5, "widen_order": ["subtopic", "topic", "chapter"]},
    "explanation": {
      "chunk": {"min_tokens": 500, "max_tokens": 800},
      "retrieval": {"vector_weight": 0.6, "min_chunks": 3, "min_candidate_score": 0.05},
      "grounding": {"notes_only_min": 0.75, "mostly_notes_min": 0.5},
      "approval": {"mandatory_track_slug_patterns": ["olympiad"], "review_general_knowledge": true},
      "reports": {"unpublish_threshold": 3},
      "require_attempt": true
    },
    "ingestion": {
      "confidence": {"classification_min": 0.7, "mapping_min": 0.6, "question_min": 0.7, "solution_min": 0.6},
      "auto_approval": {"enabled": true, "min_confidence": 0.9, "audit_sample_rate": 0.05,
                        "mandatory_review_difficulty_labels": [5],
                        "mandatory_review_track_slug_patterns": ["olympiad"],
                        "require_review_for_ocr": true},
      "approval_reversal_window_hours": 24,
      "ocr_min_page_chars": 40
    }
  }$json$::jsonb,
  'Baseline adaptive-engine configuration',
  true,
  now()
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM engine_config ec WHERE ec.tenant_id = t.id AND ec.is_active = true
);

-- -----------------------------------------------------------------------------
-- 2. Tracks & Learning Contexts
-- -----------------------------------------------------------------------------

UPDATE tracks
   SET kind = 'competitive_exam', exam_family = 'JEE', education_stage = 'senior_secondary', locale = 'en-IN', sort_order = 202
 WHERE id = 'd1000000-0000-4000-8000-000000000001'
   AND (kind IS NULL OR sort_order = 0);

-- School tracks: Class 1 – 12
INSERT INTO tracks (id, tenant_id, slug, name, short_name, kind, education_stage, grade_label, grade_ordinal,
                    locale, sort_order, status)
SELECT ('d1000000-0000-4000-8000-000000000' || (100 + g)::text)::uuid,
       'd0000000-0000-4000-8000-000000000001',
       'class-' || g, 'Class ' || g, 'Class ' || g,
       'school', 'school', 'Class ' || g, g,
       'en-IN', 100 + g, 'published'
FROM generate_series(1, 12) AS g
ON CONFLICT (id) DO NOTHING;

-- Competitive exams
INSERT INTO tracks (id, tenant_id, slug, name, short_name, description, kind, education_stage, exam_family,
                    locale, sort_order, status) VALUES
  ('d1000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000001',
   'jee-main', 'JEE Main', 'JEE Main', 'Physics, Chemistry and Mathematics for engineering admission.',
   'competitive_exam', 'senior_secondary', 'JEE', 'en-IN', 201, 'published'),
  ('d1000000-0000-4000-8000-000000000203', 'd0000000-0000-4000-8000-000000000001',
   'neet', 'NEET', 'NEET', 'Physics, Chemistry and Biology for medical admission.',
   'competitive_exam', 'senior_secondary', 'NEET', 'en-IN', 203, 'published')
ON CONFLICT (id) DO NOTHING;

-- Olympiads
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

-- -----------------------------------------------------------------------------
-- 3. Syllabus Hierarchy (Subjects, Chapters, Topics, Subtopics)
-- -----------------------------------------------------------------------------

INSERT INTO subjects (id, tenant_id, track_id, slug, name, color_hex, sort_order, status) VALUES
  ('d2000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'physics', 'Physics', '#4361EE', 0, 'published'),
  ('d2000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'chemistry', 'Chemistry', '#E056FD', 1, 'published'),
  ('d2000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'mathematics', 'Mathematics', '#2ECC71', 2, 'published'),
  -- JEE Main subjects
  ('d2000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000201', 'physics', 'Physics', '#4361EE', 1, 'published'),
  ('d2000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000201', 'chemistry', 'Chemistry', '#E056FD', 2, 'published'),
  ('d2000000-0000-4000-8000-000000000203', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000201', 'mathematics', 'Mathematics', '#2ECC71', 3, 'published'),
  -- NEET subjects
  ('d2000000-0000-4000-8000-000000000204', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000203', 'physics', 'Physics', '#4361EE', 1, 'published'),
  ('d2000000-0000-4000-8000-000000000205', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000203', 'chemistry', 'Chemistry', '#E056FD', 2, 'published'),
  ('d2000000-0000-4000-8000-000000000206', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000203', 'biology', 'Biology', '#10B981', 3, 'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO chapters (id, tenant_id, subject_id, slug, name, weightage_pct, sort_order, status) VALUES
  ('d3000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd2000000-0000-4000-8000-000000000001', 'mechanics', 'Mechanics', 24.00, 0, 'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO topics (id, tenant_id, chapter_id, slug, name, sort_order, status) VALUES
  ('d4000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd3000000-0000-4000-8000-000000000001', 'rotational-dynamics', 'Rotational Dynamics', 0, 'published')
ON CONFLICT (id) DO NOTHING;

INSERT INTO subtopics (id, tenant_id, topic_id, slug, name, description, sort_order, status) VALUES
  ('d5000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd4000000-0000-4000-8000-000000000001', 'angular-momentum-and-rolling', 'Angular Momentum & Rolling',
   'Angular momentum, its conservation, and rolling with and without slipping.', 0, 'published')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Published Theory Blocks
-- -----------------------------------------------------------------------------

INSERT INTO content_blocks (id, tenant_id, kind, format, title, raw_text, normalized_text, content_json, content_hash,
                            classified_by, subtopic_id, sort_order, status, published_at)
SELECT b.id::uuid, 'd0000000-0000-4000-8000-000000000001', 'theory', b.format, b.title, b.txt, b.txt, b.cjson::jsonb,
       encode(sha256(convert_to(b.txt, 'UTF8')), 'hex'), 'human', 'd5000000-0000-4000-8000-000000000001', b.ord, 'published', now()
FROM (VALUES
  ('d7000000-0000-4000-8000-000000000001', 'paragraph', NULL, 0, NULL,
   'Rolling without slipping ties translation to rotation: the point of contact is instantaneously at rest, so the centre-of-mass speed is v = ωR and its acceleration is a = αR.'),
  ('d7000000-0000-4000-8000-000000000002', 'formula', 'Core relations', 1, NULL,
   'L = Iω;   τ_ext = dL/dt;   I_P = I_cm + Md²  (parallel-axis theorem)'),
  ('d7000000-0000-4000-8000-000000000003', 'paragraph', NULL, 2, NULL,
   'The kinetic energy of a rolling body splits into translational and rotational parts: K = ½Mv² + ½I_cm ω² = ½Mv²(1 + k²/R²), where k is the radius of gyration about the central axis.'),
  ('d7000000-0000-4000-8000-000000000004', 'callout', 'Choosing the axis', 3, NULL,
   'When a body slides before it starts rolling, friction acts at the contact point. Taking angular momentum about that point removes friction''s torque, so angular momentum about the contact point is conserved through the slipping phase.'),
  ('d7000000-0000-4000-8000-000000000005', 'list', 'Moments of inertia about the central axis', 4,
   '{"items": ["Thin ring: MR²", "Uniform disc or solid cylinder: ½MR²", "Uniform solid sphere: ⅖MR²", "Thin spherical shell: ⅔MR²"]}',
   'Thin ring: MR². Uniform disc or solid cylinder: ½MR². Uniform solid sphere: ⅖MR². Thin spherical shell: ⅔MR².'),
  ('d7000000-0000-4000-8000-000000000006', 'callout', 'Common pitfall', 5, NULL,
   'Conserving angular momentum about the centre of mass while the body is still slipping. Friction exerts a torque about the centre, so angular momentum about the centre is not conserved during that phase.')
) AS b(id, format, title, ord, cjson, txt)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. Questions (L1–L5)
-- -----------------------------------------------------------------------------

INSERT INTO questions (id, tenant_id, primary_subtopic_id, type, stem, correct_numeric, numeric_tolerance, tolerance_mode,
                       matrix_answer, difficulty_label, difficulty_b, expected_time_seconds, hints, status)
SELECT q.id::uuid, 'd0000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', q.qtype, q.stem,
       q.num, q.tol, q.tmode, q.matrix::jsonb, q.lvl, q.b, q.secs, q.hints::text[], 'draft'
FROM (VALUES
  ('d6000000-0000-4000-8000-000000000001', 'single_correct', 1, 800.00, 45, NULL::numeric, NULL::numeric, NULL, NULL,
   'A thin ring of mass M and radius R rotates about the axis through its centre, perpendicular to its plane. What is its moment of inertia about this axis?',
   '{"Every element of mass is at the same distance R from the axis."}'),
  ('d6000000-0000-4000-8000-000000000002', 'single_correct', 1, 800.00, 40, NULL, NULL, NULL, NULL,
   'A flywheel with moment of inertia 2 kg·m² rotates at 3 rad/s about its axis. What is the magnitude of its angular momentum?',
   '{"Use L = Iω."}'),
  ('d6000000-0000-4000-8000-000000000003', 'integer', 1, 800.00, 45, 2, 0, 'absolute', NULL,
   'A disc with moment of inertia 4 kg·m² about its axis starts from rest under a constant torque of 8 N·m about that axis. What is its angular acceleration, in rad/s²?',
   '{"Rotational analogue of F = ma: τ = Iα."}'),
  ('d6000000-0000-4000-8000-000000000004', 'single_correct', 2, 1000.00, 75, NULL, NULL, NULL, NULL,
   'A uniform solid sphere rolls without slipping on a horizontal floor. What fraction of its total kinetic energy is rotational?',
   '{"Write both energy terms in terms of v using ω = v/R."}'),
  ('d6000000-0000-4000-8000-000000000005', 'numeric', 2, 1000.00, 90, 9, 0.01, 'absolute', NULL,
   'A uniform solid cylinder of mass 3 kg rolls without slipping with a centre-of-mass speed of 2 m/s. What is its total kinetic energy, in joules?',
   '{"K = ½Mv²(1 + k²/R²) with k²/R² = ½ for a solid cylinder."}'),
  ('d6000000-0000-4000-8000-000000000006', 'assertion_reason', 2, 1000.00, 60, NULL, NULL, NULL, NULL,
   'Assertion (A): A figure skater spinning with her arms outstretched speeds up when she pulls her arms in. Reason (R): With no external torque about the spin axis, angular momentum is conserved, and pulling the arms in reduces the moment of inertia.',
   '{}'),
  ('d6000000-0000-4000-8000-000000000007', 'single_correct', 3, 1200.00, 120, NULL, NULL, NULL, NULL,
   'A uniform solid sphere is released from rest at the top of a rough incline of vertical height h and rolls down without slipping. What is the speed of its centre of mass at the bottom?',
   '{"Static friction does no work in rolling without slipping, so mechanical energy is conserved."}'),
  ('d6000000-0000-4000-8000-000000000008', 'multi_correct', 3, 1200.00, 120, NULL, NULL, NULL, NULL,
   'A uniform disc rolls without slipping at constant velocity v on a level surface. The only forces that can act are gravity, the normal force and friction from the surface. Which of the following statements are correct?',
   '{"Constant velocity means zero net force and zero net torque."}'),
  ('d6000000-0000-4000-8000-000000000009', 'integer', 3, 1200.00, 90, 5, 0, 'absolute', NULL,
   'Disc P (moment of inertia 0.5 kg·m²) spins at 20 rad/s on a fixed frictionless axle. Disc Q (moment of inertia 1.5 kg·m²), initially at rest, is dropped onto P along the same axle, and the two discs then rotate together. What is their common angular speed, in rad/s?',
   '{"No external torque acts about the axle during the coupling."}'),
  ('d6000000-0000-4000-8000-000000000010', 'single_correct', 4, 1400.00, 180, NULL, NULL, NULL, NULL,
   'A uniform solid sphere of mass M and radius R is placed on a rough horizontal surface with centre-of-mass velocity v₀ and no initial rotation. What is the speed of its centre of mass once it begins to roll without slipping?',
   '{"Take angular momentum about the contact point: friction has no torque about it.", "I_P = I_cm + MR² for the contact point."}'),
  ('d6000000-0000-4000-8000-000000000011', 'numeric', 4, 1400.00, 180, 4, 0.01, 'absolute', NULL,
   'A uniform solid cylinder is launched along a rough horizontal floor with a centre-of-mass speed of 6 m/s and no spin. What is its centre-of-mass speed, in m/s, once it rolls without slipping?',
   '{"Angular momentum about the contact point is conserved while the cylinder slips."}'),
  ('d6000000-0000-4000-8000-000000000012', 'matrix_match', 4, 1400.00, 150, NULL, NULL, NULL,
   '{"A": ["q"], "B": ["s"], "C": ["p"], "D": ["r"]}',
   'Each body in Column I rolls without slipping. Match it with the ratio of its rotational kinetic energy to its translational kinetic energy in Column II.',
   '{"The ratio equals I_cm / (MR²)."}'),
  ('d6000000-0000-4000-8000-000000000013', 'single_correct', 5, 1600.00, 240, NULL, NULL, NULL, NULL,
   'A uniform rod of length L hangs vertically from a frictionless pivot at its upper end. A short horizontal impulse is delivered at a distance x below the pivot. For which value of x is the impulsive reaction at the pivot zero?',
   '{"With zero pivot impulse, the applied impulse alone sets both the linear and the angular momentum."}'),
  ('d6000000-0000-4000-8000-000000000014', 'numeric', 5, 1600.00, 240, 1.4, 0.01, 'absolute', NULL,
   'A billiard ball (uniform solid sphere of radius R) at rest is struck by a cue with a short horizontal impulse whose line of action lies in the vertical plane through the centre, at height h above the table. For what value of h/R does the ball roll without slipping immediately, with no friction needed?',
   '{"Match the linear impulse J = Mv with the angular impulse about the centre, J·d = I_cm·ω, and impose v = ωR."}'),
  ('d6000000-0000-4000-8000-000000000015', 'long_form', 5, 1600.00, 600, NULL, NULL, NULL, NULL,
   'A body of radius R and radius of gyration k about its central axis rolls without slipping down a rough incline of angle θ. Show that its centre-of-mass acceleration is a = g sin θ / (1 + k²/R²). Hence find the minimum coefficient of static friction required for it to roll without slipping.',
   '{}')
) AS q(id, qtype, lvl, b, secs, num, tol, tmode, matrix, stem, hints)
ON CONFLICT (id) DO NOTHING;

INSERT INTO question_options (tenant_id, question_id, option_key, side, body, is_correct, sort_order)
SELECT 'd0000000-0000-4000-8000-000000000001', o.qid::uuid, o.k, o.side, o.body, o.ok, o.ord
FROM (VALUES
  ('d6000000-0000-4000-8000-000000000001', 'A', 'single', 'MR²/2',     false, 0),
  ('d6000000-0000-4000-8000-000000000001', 'B', 'single', 'MR²',       true,  1),
  ('d6000000-0000-4000-8000-000000000001', 'C', 'single', '2MR²/5',    false, 2),
  ('d6000000-0000-4000-8000-000000000001', 'D', 'single', '3MR²/2',    false, 3),
  ('d6000000-0000-4000-8000-000000000002', 'A', 'single', '1.5 kg·m²/s', false, 0),
  ('d6000000-0000-4000-8000-000000000002', 'B', 'single', '5 kg·m²/s',   false, 1),
  ('d6000000-0000-4000-8000-000000000002', 'C', 'single', '6 kg·m²/s',   true,  2),
  ('d6000000-0000-4000-8000-000000000002', 'D', 'single', '18 kg·m²/s',  false, 3),
  ('d6000000-0000-4000-8000-000000000004', 'A', 'single', '2/7', true,  0),
  ('d6000000-0000-4000-8000-000000000004', 'B', 'single', '2/5', false, 1),
  ('d6000000-0000-4000-8000-000000000004', 'C', 'single', '1/3', false, 2),
  ('d6000000-0000-4000-8000-000000000004', 'D', 'single', '5/7', false, 3),
  ('d6000000-0000-4000-8000-000000000006', 'A', 'single', 'Both A and R are true, and R is the correct explanation of A.', true, 0),
  ('d6000000-0000-4000-8000-000000000006', 'B', 'single', 'Both A and R are true, but R is not the correct explanation of A.', false, 1),
  ('d6000000-0000-4000-8000-000000000006', 'C', 'single', 'A is true, but R is false.', false, 2),
  ('d6000000-0000-4000-8000-000000000006', 'D', 'single', 'A is false, but R is true.', false, 3),
  ('d6000000-0000-4000-8000-000000000007', 'A', 'single', '√(2gh)',    false, 0),
  ('d6000000-0000-4000-8000-000000000007', 'B', 'single', '√(10gh/7)', true,  1),
  ('d6000000-0000-4000-8000-000000000007', 'C', 'single', '√(4gh/3)',  false, 2),
  ('d6000000-0000-4000-8000-000000000007', 'D', 'single', '√(gh)',     false, 3),
  ('d6000000-0000-4000-8000-000000000008', 'A', 'single', 'The instantaneous velocity of the contact point is zero.', true,  0),
  ('d6000000-0000-4000-8000-000000000008', 'B', 'single', 'The friction force on the disc is zero.',                  true,  1),
  ('d6000000-0000-4000-8000-000000000008', 'C', 'single', 'The topmost point of the disc moves with speed 2v.',       true,  2),
  ('d6000000-0000-4000-8000-000000000008', 'D', 'single', 'All of the disc''s kinetic energy is translational.',      false, 3),
  ('d6000000-0000-4000-8000-000000000010', 'A', 'single', '5v₀/7', true,  0),
  ('d6000000-0000-4000-8000-000000000010', 'B', 'single', '2v₀/7', false, 1),
  ('d6000000-0000-4000-8000-000000000010', 'C', 'single', '3v₀/5', false, 2),
  ('d6000000-0000-4000-8000-000000000010', 'D', 'single', 'v₀/2',  false, 3),
  ('d6000000-0000-4000-8000-000000000012', 'A', 'left',  'Thin ring',            false, 0),
  ('d6000000-0000-4000-8000-000000000012', 'B', 'left',  'Uniform disc',         false, 1),
  ('d6000000-0000-4000-8000-000000000012', 'C', 'left',  'Uniform solid sphere', false, 2),
  ('d6000000-0000-4000-8000-000000000012', 'D', 'left',  'Thin spherical shell', false, 3),
  ('d6000000-0000-4000-8000-000000000012', 'p', 'right', '2/5', false, 0),
  ('d6000000-0000-4000-8000-000000000012', 'q', 'right', '1',   false, 1),
  ('d6000000-0000-4000-8000-000000000012', 'r', 'right', '2/3', false, 2),
  ('d6000000-0000-4000-8000-000000000012', 's', 'right', '1/2', false, 3),
  ('d6000000-0000-4000-8000-000000000013', 'A', 'single', '2L/3', true,  0),
  ('d6000000-0000-4000-8000-000000000013', 'B', 'single', 'L/2',  false, 1),
  ('d6000000-0000-4000-8000-000000000013', 'C', 'single', '3L/4', false, 2),
  ('d6000000-0000-4000-8000-000000000013', 'D', 'single', 'L',    false, 3)
) AS o(qid, k, side, body, ok, ord)
ON CONFLICT (question_id, side, option_key) DO NOTHING;

UPDATE questions SET status = 'published', published_at = now()
 WHERE tenant_id = 'd0000000-0000-4000-8000-000000000001' AND status = 'draft'
   AND id::text LIKE 'd6000000-0000-4000-8000-0000000000%';

INSERT INTO official_solutions (id, tenant_id, question_id, body, final_answer_text, status, approved_at)
SELECT ('d9000000-0000-4000-8000-0000000000' || right(s.qid, 2))::uuid, 'd0000000-0000-4000-8000-000000000001',
       s.qid::uuid, s.body, s.ans, 'approved', now()
FROM (VALUES
  ('d6000000-0000-4000-8000-000000000001', 'All the mass sits at distance R from the axis, so I = ΣmR² = MR².', 'MR²'),
  ('d6000000-0000-4000-8000-000000000002', 'L = Iω = 2 × 3 = 6 kg·m²/s.', '6 kg·m²/s'),
  ('d6000000-0000-4000-8000-000000000003', 'τ = Iα, so α = τ/I = 8/4 = 2 rad/s².', '2'),
  ('d6000000-0000-4000-8000-000000000004', 'K_rot = ½(⅖MR²)(v/R)² = ⅕Mv² and K_total = ½Mv²(1 + ⅖) = (7/10)Mv². Ratio = (1/5)/(7/10) = 2/7.', '2/7'),
  ('d6000000-0000-4000-8000-000000000005', 'K = ½Mv²(1 + ½) = ½ × 3 × 2² × 1.5 = 9 J.', '9'),
  ('d6000000-0000-4000-8000-000000000006', 'Both statements are true. With no external torque about the spin axis, L = Iω is constant; pulling the arms in lowers I, so ω rises. R explains A.', 'Option A'),
  ('d6000000-0000-4000-8000-000000000007', 'Friction does no work when rolling without slipping. Mgh = ½Mv²(1 + ⅖) = (7/10)Mv², so v = √(10gh/7).', '√(10gh/7)'),
  ('d6000000-0000-4000-8000-000000000008', 'Rolling without slipping makes the contact point instantaneously at rest (A) and the top move at v + ωR = 2v (C). Constant velocity on a level surface needs zero net force, so friction is zero (B). Rotational energy is non-zero, so D is false.', 'A, B, C'),
  ('d6000000-0000-4000-8000-000000000009', 'Angular momentum about the axle is conserved: 0.5 × 20 = (0.5 + 1.5)ω, so ω = 10/2 = 5 rad/s.', '5'),
  ('d6000000-0000-4000-8000-000000000010', 'About the contact point friction has no torque, so angular momentum is conserved: Mv₀R = I_P ω = (⅖MR² + MR²)(v/R) = (7/5)MRv. Hence v = 5v₀/7.', '5v₀/7'),
  ('d6000000-0000-4000-8000-000000000011', 'About the contact point: Mv₀R = (½MR² + MR²)(v/R) = (3/2)MRv, so v = 2v₀/3 = 2 × 6/3 = 4 m/s.', '4'),
  ('d6000000-0000-4000-8000-000000000012', 'For rolling without slipping K_rot/K_trans = I_cm/(MR²): ring 1 (q), disc ½ (s), solid sphere ⅖ (p), spherical shell ⅔ (r).', 'A–q, B–s, C–p, D–r'),
  ('d6000000-0000-4000-8000-000000000013', 'With no pivot impulse: J = Mv_cm = Mω(L/2) and Jx = I_pivot ω = (ML²/3)ω. Dividing, x = (L²/3)/(L/2) = 2L/3 (the centre of percussion).', '2L/3'),
  ('d6000000-0000-4000-8000-000000000014', 'For an impulse J at height d above the centre: J = Mv and Jd = I_cm ω = ⅖MR²ω. Rolling requires v = ωR, so d = 2R/5 and h = R + d = 7R/5, i.e. h/R = 1.4.', '1.4'),
  ('d6000000-0000-4000-8000-000000000015', 'Along the incline: Mg sin θ − f = Ma. About the centre: fR = Iα = Mk²(a/R), so f = Mk²a/R². Substituting: a = g sin θ / (1 + k²/R²). Rolling needs f ≤ μN = μMg cos θ, so μ ≥ (k²/R²)·a/(g cos θ) = tan θ · k²/(R² + k²).', 'a = g sin θ/(1 + k²/R²); μ_min = tan θ · k²/(R² + k²)')
) AS s(qid, body, ans)
ON CONFLICT (id) DO NOTHING;

UPDATE official_solutions
   SET body_json = '{"rubric": [
     {"criterion": "Newton''s second law along the incline including friction", "marks": 1},
     {"criterion": "Torque equation about the centre with α = a/R", "marks": 1},
     {"criterion": "Eliminates f to reach a = g sin θ / (1 + k²/R²)", "marks": 1},
     {"criterion": "Applies f ≤ μN with N = Mg cos θ", "marks": 1},
     {"criterion": "States μ_min = tan θ · k²/(R² + k²)", "marks": 1}]}'::jsonb
 WHERE id = 'd9000000-0000-4000-8000-000000000015' AND body_json IS NULL;

-- -----------------------------------------------------------------------------
-- 6. Mock Tests
-- -----------------------------------------------------------------------------

INSERT INTO mock_tests (
  id, tenant_id, track_id, title, description, kind, duration_minutes, total_marks,
  default_positive_marks, default_negative_marks, status, instructions
) VALUES
  (
    'da000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    'JEE Advanced Simulation Test 1',
    'Full-length 3-hour exam simulation covering high-yield Physics topics with authentic JEE marking scheme.',
    'full_length',
    180,
    60,
    4.00,
    1.00,
    'published',
    'This test contains 15 questions across 3 sections. Each correct answer carries +4 marks, and each incorrect answer deducts 1 mark.'
  ),
  (
    'da000000-0000-4000-8000-000000000002',
    'd0000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    'Physics Sectional: Rotational Dynamics',
    'High-intensity 45-minute sectional drill on Angular Momentum, Rolling, and Torque balance.',
    'sectional',
    45,
    20,
    4.00,
    1.00,
    'published',
    'This sectional test contains 5 questions. Carefully verify your calculations before submitting.'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO test_sections (id, test_id, name, subject_id, sort_order, duration_minutes, instructions) VALUES
  ('db000000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001', 'Section 1: Single & Multi-Correct', 'd2000000-0000-4000-8000-000000000001', 0, 60, 'Single option and multiple options correct types.'),
  ('db000000-0000-4000-8000-000000000002', 'da000000-0000-4000-8000-000000000001', 'Section 2: Numeric & Matrix Match', 'd2000000-0000-4000-8000-000000000001', 1, 60, 'Integer, decimal numeric, and matrix matching.'),
  ('db000000-0000-4000-8000-000000000003', 'da000000-0000-4000-8000-000000000001', 'Section 3: Conceptual & Assertion-Reason', 'd2000000-0000-4000-8000-000000000001', 2, 60, 'Assertion reason and reasoning problems.'),
  ('db000000-0000-4000-8000-000000000004', 'da000000-0000-4000-8000-000000000002', 'Rotational Dynamics Core', 'd2000000-0000-4000-8000-000000000001', 0, 45, 'Sectional challenge.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO test_items (id, test_id, section_id, question_id, sort_order, positive_marks, negative_marks) VALUES
  ('dc000000-0000-4000-8000-000000000001', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 0, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000002', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000002', 1, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000003', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000003', 2, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000004', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000004', 3, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000005', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000005', 4, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000006', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000006', 0, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000007', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000007', 1, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000008', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000008', 2, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000009', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000009', 3, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000010', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000010', 4, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000011', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000003', 'd6000000-0000-4000-8000-000000000011', 0, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000012', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000003', 'd6000000-0000-4000-8000-000000000012', 1, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000013', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000003', 'd6000000-0000-4000-8000-000000000013', 2, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000014', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000003', 'd6000000-0000-4000-8000-000000000014', 3, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000015', 'da000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000003', 'd6000000-0000-4000-8000-000000000015', 4, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000016', 'da000000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000004', 'd6000000-0000-4000-8000-000000000001', 0, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000017', 'da000000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000004', 'd6000000-0000-4000-8000-000000000002', 1, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000018', 'da000000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000004', 'd6000000-0000-4000-8000-000000000003', 2, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000019', 'da000000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000004', 'd6000000-0000-4000-8000-000000000004', 3, 4.00, 1.00),
  ('dc000000-0000-4000-8000-000000000020', 'da000000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000004', 'd6000000-0000-4000-8000-000000000005', 4, 4.00, 1.00)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7. Demo Student Account
-- -----------------------------------------------------------------------------

INSERT INTO users (
  id, tenant_id, email, password_hash, role, display_name, email_verified_at,
  primary_track_id, daily_question_goal, onboarded_at, status
)
VALUES (
  'a0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001',
  'student@apexprep.dev',
  '$argon2id$v=19$m=19456,t=2,p=1$BvvfTxbtBgpOylI55hM1YA$BNpBbzey2ko3tEW+qWDZ/QNDtY7vpZkbiG/54kcp7Bk',
  'STUDENT',
  'Demo Student',
  now(),
  'd1000000-0000-4000-8000-000000000001',
  50,
  now(),
  'active'
)
ON CONFLICT (tenant_id, email) WHERE deleted_at IS NULL
DO UPDATE SET
  role = 'STUDENT',
  password_hash = EXCLUDED.password_hash,
  primary_track_id = 'd1000000-0000-4000-8000-000000000001',
  onboarded_at = coalesce(users.onboarded_at, now()),
  status = 'active';

-- Link Demo Student enrolment in learner_tracks
INSERT INTO learner_tracks (id, tenant_id, user_id, track_id, is_primary, status)
VALUES (
  'c0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000001',
  true,
  'active'
)
ON CONFLICT (id) DO NOTHING;

