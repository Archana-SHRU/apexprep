-- =============================================================================
-- 0002_syllabus
-- Track → Subject → Chapter → Topic → Sub-topic (strict tree, tenant-owned).
-- Sub-topic is the atomic learning and mastery unit.
-- =============================================================================

CREATE TABLE tracks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  slug         text NOT NULL,
  name         text NOT NULL,
  short_name   text,
  description  text,
  exam_year    smallint,
  exam_date    date,
  sort_order   integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT tracks_tenant_id_id_uq     UNIQUE (tenant_id, id),
  CONSTRAINT tracks_slug_format         CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT tracks_name_nonblank       CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT tracks_short_name_length   CHECK (short_name IS NULL OR length(short_name) BETWEEN 1 AND 20),
  CONSTRAINT tracks_description_length  CHECK (description IS NULL OR length(description) <= 2000),
  CONSTRAINT tracks_exam_year_range     CHECK (exam_year IS NULL OR exam_year BETWEEN 2000 AND 2100),
  CONSTRAINT tracks_sort_order_nonneg   CHECK (sort_order >= 0),
  CONSTRAINT tracks_status_valid        CHECK (status IN ('draft', 'published', 'archived'))
);
CREATE UNIQUE INDEX tracks_slug_uq ON tracks (tenant_id, slug) WHERE deleted_at IS NULL;
CREATE TRIGGER tracks_set_updated_at BEFORE UPDATE ON tracks
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE subjects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  track_id     uuid NOT NULL,
  slug         text NOT NULL,
  name         text NOT NULL,
  color_hex    text,          -- display metadata used by the UI
  sort_order   integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT subjects_tenant_id_id_uq   UNIQUE (tenant_id, id),
  CONSTRAINT subjects_track_fk          FOREIGN KEY (tenant_id, track_id) REFERENCES tracks (tenant_id, id),
  CONSTRAINT subjects_slug_format       CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT subjects_name_nonblank     CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT subjects_color_hex_format  CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT subjects_sort_order_nonneg CHECK (sort_order >= 0),
  CONSTRAINT subjects_status_valid      CHECK (status IN ('draft', 'published', 'archived'))
);
CREATE UNIQUE INDEX subjects_slug_uq ON subjects (track_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX subjects_track_idx ON subjects (tenant_id, track_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER subjects_set_updated_at BEFORE UPDATE ON subjects
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE chapters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  subject_id     uuid NOT NULL,
  slug           text NOT NULL,
  name           text NOT NULL,
  weightage_pct  numeric(5, 2),   -- display metadata: approximate exam weightage
  sort_order     integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'draft',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT chapters_tenant_id_id_uq   UNIQUE (tenant_id, id),
  CONSTRAINT chapters_subject_fk        FOREIGN KEY (tenant_id, subject_id) REFERENCES subjects (tenant_id, id),
  CONSTRAINT chapters_slug_format       CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT chapters_name_nonblank     CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT chapters_weightage_range   CHECK (weightage_pct IS NULL OR weightage_pct BETWEEN 0 AND 100),
  CONSTRAINT chapters_sort_order_nonneg CHECK (sort_order >= 0),
  CONSTRAINT chapters_status_valid      CHECK (status IN ('draft', 'published', 'archived'))
);
CREATE UNIQUE INDEX chapters_slug_uq ON chapters (subject_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX chapters_subject_idx ON chapters (tenant_id, subject_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER chapters_set_updated_at BEFORE UPDATE ON chapters
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE topics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  chapter_id   uuid NOT NULL,
  slug         text NOT NULL,
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT topics_tenant_id_id_uq   UNIQUE (tenant_id, id),
  CONSTRAINT topics_chapter_fk        FOREIGN KEY (tenant_id, chapter_id) REFERENCES chapters (tenant_id, id),
  CONSTRAINT topics_slug_format       CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT topics_name_nonblank     CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT topics_sort_order_nonneg CHECK (sort_order >= 0),
  CONSTRAINT topics_status_valid      CHECK (status IN ('draft', 'published', 'archived'))
);
CREATE UNIQUE INDEX topics_slug_uq ON topics (chapter_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX topics_chapter_idx ON topics (tenant_id, chapter_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER topics_set_updated_at BEFORE UPDATE ON topics
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE subtopics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  topic_id     uuid NOT NULL,
  slug         text NOT NULL,
  name         text NOT NULL,
  description  text,
  sort_order   integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT subtopics_tenant_id_id_uq    UNIQUE (tenant_id, id),
  CONSTRAINT subtopics_topic_fk           FOREIGN KEY (tenant_id, topic_id) REFERENCES topics (tenant_id, id),
  CONSTRAINT subtopics_slug_format        CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT subtopics_name_nonblank      CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT subtopics_description_length CHECK (description IS NULL OR length(description) <= 4000),
  CONSTRAINT subtopics_sort_order_nonneg  CHECK (sort_order >= 0),
  CONSTRAINT subtopics_status_valid       CHECK (status IN ('draft', 'published', 'archived'))
);
CREATE UNIQUE INDEX subtopics_slug_uq ON subtopics (topic_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX subtopics_topic_idx ON subtopics (tenant_id, topic_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER subtopics_set_updated_at BEFORE UPDATE ON subtopics
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- Student's chosen track (deferred from 0001).
ALTER TABLE users
  ADD CONSTRAINT users_primary_track_fk FOREIGN KEY (tenant_id, primary_track_id)
  REFERENCES tracks (tenant_id, id);

-- Ancestry of every sub-topic in one row. Used by analytics rollups and by RAG
-- retrieval when widening from sub-topic to topic to chapter.
CREATE VIEW subtopic_paths AS
SELECT st.tenant_id,
       st.id  AS subtopic_id,
       tp.id  AS topic_id,
       ch.id  AS chapter_id,
       sj.id  AS subject_id,
       tr.id  AS track_id,
       (st.deleted_at IS NULL AND tp.deleted_at IS NULL AND ch.deleted_at IS NULL
        AND sj.deleted_at IS NULL AND tr.deleted_at IS NULL) AS is_live
FROM subtopics st
JOIN topics   tp ON tp.tenant_id = st.tenant_id AND tp.id = st.topic_id
JOIN chapters ch ON ch.tenant_id = tp.tenant_id AND ch.id = tp.chapter_id
JOIN subjects sj ON sj.tenant_id = ch.tenant_id AND sj.id = ch.subject_id
JOIN tracks   tr ON tr.tenant_id = sj.tenant_id AND tr.id = sj.track_id;
