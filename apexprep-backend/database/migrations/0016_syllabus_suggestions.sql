-- =============================================================================
-- 0016_syllabus_suggestions
--
-- WHY THIS MIGRATION IS NEEDED
--
-- Ingestion could only file content under sub-topics that already existed and
-- were published, so an admin had to build the whole Chapter → Topic →
-- Sub-topic tree by hand before an upload produced anything publishable. The
-- pipeline now reads the hierarchy the PDF itself prints (numbered and
-- "Chapter N" headings) and matches it against the uploaded subject's existing
-- tree. Where a level is missing it needs somewhere to put a *proposal* that a
-- person can approve or reject — and that place must not be the syllabus tables:
--
--   * A draft chapter/topic/sub-topic row is still a syllabus node. It would
--     appear in the admin tree, collide on slugs, survive a rejection and be
--     re-created by every re-run of the job. A suggestion is not a node.
--   * `review_tasks.suggestion` is free-form JSON per task; it cannot be shared
--     by several blocks, deduplicated across uploads, or carry the node ids a
--     human decision produced.
--
-- So a suggestion is its own row, and the blocks it covers are a join table.
-- Nodes are created only when an admin approves the suggestion.
--
-- `ingestion_jobs.hierarchy` records what detection found for the whole upload
-- (method, counts, and whether the structure was too weak to trust), so the
-- admin screens can say "Hierarchy needs review" instead of guessing.
--
-- NOT DESTRUCTIVE: two new tables and one new nullable column. Nothing is
-- renamed, dropped, narrowed or back-filled.
-- =============================================================================

ALTER TABLE ingestion_jobs ADD COLUMN hierarchy jsonb;
ALTER TABLE ingestion_jobs
  ADD CONSTRAINT ingestion_jobs_hierarchy_object CHECK (hierarchy IS NULL OR jsonb_typeof(hierarchy) = 'object');

CREATE TABLE syllabus_suggestions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  -- The upload that first proposed it. Later uploads proposing the same path
  -- link their blocks to this row instead of opening a second one.
  job_id                uuid NOT NULL,
  track_id              uuid NOT NULL,
  subject_id            uuid NOT NULL,
  -- Names exactly as the PDF printed them (or as the approving admin edited
  -- them). NULL means the PDF gave no evidence for that level: it is left
  -- unresolved rather than invented.
  chapter_name          text,
  topic_name            text,
  subtopic_name         text,
  -- Normalised names: the identity of a suggestion, used to avoid duplicates.
  -- Empty string for an unresolved level.
  chapter_key           text NOT NULL,
  topic_key             text NOT NULL,
  subtopic_key          text NOT NULL,
  existing_chapter_id   uuid,
  existing_topic_id     uuid,
  existing_subtopic_id  uuid,
  confidence            numeric(4,3) NOT NULL,
  -- The heading lines, pages and match scores behind each level. Heading text
  -- only; never block bodies.
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
  mapping_reason        text NOT NULL,
  status                text NOT NULL DEFAULT 'pending',
  created_chapter_id    uuid,
  created_topic_id      uuid,
  created_subtopic_id   uuid,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  rejection_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT syllabus_suggestions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT syllabus_suggestions_tenant_fk   FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT syllabus_suggestions_job_fk      FOREIGN KEY (tenant_id, job_id) REFERENCES ingestion_jobs (tenant_id, id),
  CONSTRAINT syllabus_suggestions_track_fk    FOREIGN KEY (tenant_id, track_id) REFERENCES tracks (tenant_id, id),
  CONSTRAINT syllabus_suggestions_subject_fk  FOREIGN KEY (tenant_id, subject_id) REFERENCES subjects (tenant_id, id),
  CONSTRAINT syllabus_suggestions_ex_chapter_fk  FOREIGN KEY (tenant_id, existing_chapter_id) REFERENCES chapters (tenant_id, id),
  CONSTRAINT syllabus_suggestions_ex_topic_fk    FOREIGN KEY (tenant_id, existing_topic_id) REFERENCES topics (tenant_id, id),
  CONSTRAINT syllabus_suggestions_ex_subtopic_fk FOREIGN KEY (tenant_id, existing_subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT syllabus_suggestions_new_chapter_fk  FOREIGN KEY (tenant_id, created_chapter_id) REFERENCES chapters (tenant_id, id),
  CONSTRAINT syllabus_suggestions_new_topic_fk    FOREIGN KEY (tenant_id, created_topic_id) REFERENCES topics (tenant_id, id),
  CONSTRAINT syllabus_suggestions_new_subtopic_fk FOREIGN KEY (tenant_id, created_subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT syllabus_suggestions_reviewer_fk FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users (tenant_id, id),
  CONSTRAINT syllabus_suggestions_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT syllabus_suggestions_confidence_range CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT syllabus_suggestions_names_length CHECK (
    (chapter_name IS NULL OR length(btrim(chapter_name)) BETWEEN 1 AND 200) AND
    (topic_name IS NULL OR length(btrim(topic_name)) BETWEEN 1 AND 200) AND
    (subtopic_name IS NULL OR length(btrim(subtopic_name)) BETWEEN 1 AND 200)),
  -- Something was detected: a suggestion with no level at all is not a suggestion.
  CONSTRAINT syllabus_suggestions_has_a_level CHECK (num_nonnulls(chapter_name, topic_name, subtopic_name) >= 1),
  CONSTRAINT syllabus_suggestions_evidence_object CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT syllabus_suggestions_reason_length CHECK (length(mapping_reason) <= 2000),
  CONSTRAINT syllabus_suggestions_rejection_length CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 2000),
  -- A decision names who made it and when; a pending row has neither.
  CONSTRAINT syllabus_suggestions_reviewed CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CONSTRAINT syllabus_suggestions_rejection_only_rejected CHECK (rejection_reason IS NULL OR status = 'rejected'),
  -- An approved suggestion ends with a sub-topic: reused or created.
  CONSTRAINT syllabus_suggestions_approved_has_subtopic CHECK (
    status <> 'approved' OR num_nonnulls(existing_subtopic_id, created_subtopic_id) = 1)
);

-- One open proposal per path per subject: a second upload of the same chapter
-- joins the pending suggestion rather than opening a duplicate.
CREATE UNIQUE INDEX syllabus_suggestions_pending_path_uq
  ON syllabus_suggestions (tenant_id, subject_id, chapter_key, topic_key, subtopic_key)
  WHERE status = 'pending';
CREATE INDEX syllabus_suggestions_job_idx ON syllabus_suggestions (tenant_id, job_id, status);

CREATE TRIGGER syllabus_suggestions_set_updated_at BEFORE UPDATE ON syllabus_suggestions
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE syllabus_suggestion_blocks (
  tenant_id         uuid NOT NULL,
  suggestion_id     uuid NOT NULL,
  content_block_id  uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, content_block_id),
  CONSTRAINT syllabus_suggestion_blocks_suggestion_fk FOREIGN KEY (tenant_id, suggestion_id)
    REFERENCES syllabus_suggestions (tenant_id, id) ON DELETE CASCADE,
  -- A re-run of the pipeline replaces the blocks it wrote; their links go with them.
  CONSTRAINT syllabus_suggestion_blocks_block_fk FOREIGN KEY (tenant_id, content_block_id)
    REFERENCES content_blocks (tenant_id, id) ON DELETE CASCADE
);
-- A block waits on one proposed path at a time.
CREATE UNIQUE INDEX syllabus_suggestion_blocks_block_uq ON syllabus_suggestion_blocks (tenant_id, content_block_id);
