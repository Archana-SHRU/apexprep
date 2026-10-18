-- =============================================================================
-- 0013_learning_contexts
--
-- WHY THIS MIGRATION IS NEEDED
--
-- ApexPrep is an AI Home Tutor over a general adaptive learning platform: school
-- learning from Class 1 onward, competitive exams, Olympiads, and programmes not
-- yet designed. JEE, NEET and the Olympiads are *examples* of learning tracks,
-- not the shape of the product.
--
-- The schema as it stands cannot express that, in exactly two places.
--
-- 1. A TRACK CANNOT SAY WHAT KIND OF LEARNING CONTEXT IT IS.
--
--    `tracks` carries `exam_year` and `exam_date` and nothing else about its
--    nature, so a Class 5 Mathematics track is indistinguishable from JEE except
--    by the words in its name. That is not merely untidy: the requirement that
--    Olympiad content needs human approval is implemented in Phases 6 and 7 by
--    matching the track *slug* against configured substrings, because nothing in
--    the schema marks a track as an Olympiad (docs/DECISIONS.md §B47). A track
--    renamed or slugged differently silently loses a safety rule.
--
--    The columns below let a track describe itself. Every one is NULLable with no
--    default, which is the point: existing tracks keep working unchanged and
--    uncategorised, and nothing is back-filled with a guess. `kind` uses exactly
--    the four categories the Phase 8 brief names (school, competitive exam,
--    Olympiad, other) and no invented ones; `exam_family`, `curriculum` and
--    `grade_label` are free text because inventing a controlled vocabulary of
--    boards, exams or curricula is precisely what the brief forbids.
--
--    `grade_ordinal` exists so school tracks can be *ordered* and filtered
--    (Class 5 before Class 6) without parsing a label. Its range is a sanity
--    bound, not a mapping: **no grade-to-difficulty rule is defined anywhere**,
--    because none is specified. L1-L5 keeps its existing meaning.
--
-- 2. A LEARNER CAN BELONG TO ONLY ONE TRACK.
--
--    `users.primary_track_id` is a single column, so "Class 10 Mathematics, JEE
--    Foundation and Olympiad Mathematics" cannot be represented at all.
--
--    `learner_tracks` is that relation. It is additive: `users.primary_track_id`
--    stays exactly where it is and keeps its meaning, every existing learner row
--    is untouched and still valid, and a learner with no enrolment row behaves
--    today as they did yesterday. Where both are present the application keeps
--    them consistent, and `learner_tracks_one_primary_uq` makes "at most one
--    primary" a database guarantee rather than an application habit.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
--   * It does not touch mastery. `ability_scores` is unique per
--     `(tenant_id, user_id, subtopic_id)`, and a sub-topic belongs to exactly one
--     topic → chapter → subject → track, so mastery is **already** scoped to one
--     track by construction and two tracks can never share an ability row. A
--     learner in three tracks has three independent sets of mastery, and no code
--     path can merge them. Shared foundational content across tracks is not
--     supported: the same concept in two tracks is two sub-topic rows with
--     independent mastery, which is explicit and deterministic.
--   * It does not add a learner *type*. A learner is a school learner, a
--     competitive learner or a mixed learner because of the tracks they are
--     enrolled in — it is derived, not declared, so it cannot contradict itself.
--   * It creates no Program abstraction. Track → Subject → Chapter → Topic →
--     Sub-topic already carries the meaning; a second hierarchy above it would be
--     a new concept for every existing query to ignore.
--   * It is not destructive: only `ADD COLUMN` and `CREATE TABLE`. Nothing is
--     renamed, dropped, narrowed or back-filled.
-- =============================================================================

-- ---------------------------------------------------------------- tracks

ALTER TABLE tracks
  ADD COLUMN kind            text,      -- what sort of learning context this is
  ADD COLUMN education_stage text,      -- free text, e.g. 'primary', 'secondary' — no vocabulary is specified
  ADD COLUMN grade_label     text,      -- what the learner calls it, e.g. 'Class 5'
  ADD COLUMN grade_ordinal   smallint,  -- for ordering and filtering only; NOT a difficulty mapping
  ADD COLUMN exam_family     text,      -- free text, e.g. 'JEE'; no exam list is invented here
  ADD COLUMN curriculum      text,      -- free text board/curriculum; no board list is invented here
  ADD COLUMN locale          text;      -- BCP-47-ish tag for the language the track is taught in

-- The four categories named by the Phase 8 brief, and NULL for a track that has
-- not been categorised — which is every track that existed before this migration.
ALTER TABLE tracks
  ADD CONSTRAINT tracks_kind_valid
  CHECK (kind IS NULL OR kind IN ('school', 'competitive_exam', 'olympiad', 'other'));

ALTER TABLE tracks
  ADD CONSTRAINT tracks_education_stage_length
  CHECK (education_stage IS NULL OR length(btrim(education_stage)) BETWEEN 1 AND 40);

ALTER TABLE tracks
  ADD CONSTRAINT tracks_grade_label_length
  CHECK (grade_label IS NULL OR length(btrim(grade_label)) BETWEEN 1 AND 40);

-- A sanity bound wide enough for any school system's numbering. It says nothing
-- about difficulty, and nothing reads it as a difficulty.
ALTER TABLE tracks
  ADD CONSTRAINT tracks_grade_ordinal_range
  CHECK (grade_ordinal IS NULL OR grade_ordinal BETWEEN 1 AND 20);

ALTER TABLE tracks
  ADD CONSTRAINT tracks_exam_family_length
  CHECK (exam_family IS NULL OR length(btrim(exam_family)) BETWEEN 1 AND 40);

ALTER TABLE tracks
  ADD CONSTRAINT tracks_curriculum_length
  CHECK (curriculum IS NULL OR length(btrim(curriculum)) BETWEEN 1 AND 40);

ALTER TABLE tracks
  ADD CONSTRAINT tracks_locale_format
  CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');

-- A grade belongs to a track that is about a grade. Stated as an implication so a
-- NULL can never satisfy it by accident (a NULL CHECK passes in SQL).
ALTER TABLE tracks
  ADD CONSTRAINT tracks_grade_needs_school_kind
  CHECK (grade_ordinal IS NULL OR kind = 'school');

-- Listing the school tracks of an organisation in grade order, and finding the
-- tracks of one exam family — the two queries the metadata exists to serve.
CREATE INDEX tracks_kind_grade_idx ON tracks (tenant_id, kind, grade_ordinal, sort_order)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- learner_tracks

CREATE TABLE learner_tracks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  track_id     uuid NOT NULL,
  -- The learner's own view of this enrolment. `is_primary` is what
  -- `users.primary_track_id` has always meant, now expressible alongside others.
  is_primary   boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active',
  goal_text    text,
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_tracks_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- Composite tenant foreign keys, as everywhere else: an enrolment can never
  -- point at another organisation's learner or another organisation's track.
  CONSTRAINT learner_tracks_user_fk  FOREIGN KEY (tenant_id, user_id)  REFERENCES users  (tenant_id, id),
  CONSTRAINT learner_tracks_track_fk FOREIGN KEY (tenant_id, track_id) REFERENCES tracks (tenant_id, id),
  CONSTRAINT learner_tracks_status_valid CHECK (status IN ('active', 'left')),
  CONSTRAINT learner_tracks_goal_length  CHECK (goal_text IS NULL OR length(goal_text) <= 200),
  -- Leaving is recorded, not deleted, so a learner's history survives.
  CONSTRAINT learner_tracks_left_pair CHECK ((status = 'left') = (left_at IS NOT NULL)),
  CONSTRAINT learner_tracks_time_order CHECK (left_at IS NULL OR left_at >= enrolled_at),
  -- A learner who has left a track is not primary in it.
  CONSTRAINT learner_tracks_primary_active CHECK (NOT is_primary OR status = 'active')
);

-- One enrolment per learner per track: re-enrolling reactivates the row it
-- already has rather than accumulating a second history.
CREATE UNIQUE INDEX learner_tracks_user_track_uq ON learner_tracks (tenant_id, user_id, track_id);

-- At most one primary track per learner, enforced by the database.
CREATE UNIQUE INDEX learner_tracks_one_primary_uq ON learner_tracks (tenant_id, user_id)
  WHERE is_primary;

-- "Which tracks is this learner in?" — the read the learner's home screen makes.
CREATE INDEX learner_tracks_user_idx ON learner_tracks (tenant_id, user_id, status, enrolled_at DESC);

-- "Who is enrolled in this track?" — for an admin looking at a track's cohort.
CREATE INDEX learner_tracks_track_idx ON learner_tracks (tenant_id, track_id, status);

CREATE TRIGGER learner_tracks_set_updated_at BEFORE UPDATE ON learner_tracks
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
