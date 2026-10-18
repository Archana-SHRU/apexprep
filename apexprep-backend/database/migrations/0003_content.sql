-- =============================================================================
-- 0003_content
-- Uploaded files, ingestion jobs, extracted pages and classified content blocks.
-- Every block keeps (asset_id, source_page) for source traceability.
-- =============================================================================

CREATE TABLE content_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  kind               text NOT NULL,
  storage_key        text NOT NULL,          -- object-storage / local path key, never a URL with credentials
  original_filename  text,
  mime_type          text NOT NULL,
  byte_size          bigint NOT NULL,
  sha256             text NOT NULL,          -- lowercase hex; duplicate detection for source PDFs
  page_count         integer,
  parent_asset_id    uuid,                   -- figure/page image extracted from a source PDF
  source_page        integer,
  track_id           uuid,                   -- optional upload-form hints for syllabus tagging
  subject_id         uuid,
  uploaded_by        uuid,
  validation_status  text NOT NULL DEFAULT 'pending',
  validation_error   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT content_assets_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT content_assets_parent_fk   FOREIGN KEY (tenant_id, parent_asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT content_assets_track_fk    FOREIGN KEY (tenant_id, track_id) REFERENCES tracks (tenant_id, id),
  CONSTRAINT content_assets_subject_fk  FOREIGN KEY (tenant_id, subject_id) REFERENCES subjects (tenant_id, id),
  CONSTRAINT content_assets_uploader_fk FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users (tenant_id, id),
  CONSTRAINT content_assets_kind_valid  CHECK (kind IN ('source_pdf', 'page_image', 'figure', 'report_pdf')),
  -- SVG deliberately excluded (script-capable).
  CONSTRAINT content_assets_mime_valid  CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT content_assets_pdf_kinds   CHECK ((kind IN ('source_pdf', 'report_pdf')) = (mime_type = 'application/pdf')),
  CONSTRAINT content_assets_size_positive CHECK (byte_size > 0),
  CONSTRAINT content_assets_sha256_hex  CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_assets_pages_positive CHECK (page_count IS NULL OR page_count >= 1),
  CONSTRAINT content_assets_source_page CHECK (source_page IS NULL OR (source_page >= 1 AND parent_asset_id IS NOT NULL)),
  CONSTRAINT content_assets_derived_has_parent CHECK (kind NOT IN ('page_image', 'figure') OR parent_asset_id IS NOT NULL),
  CONSTRAINT content_assets_validation_valid CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  CONSTRAINT content_assets_invalid_has_error CHECK ((validation_status = 'invalid') = (validation_error IS NOT NULL)),
  CONSTRAINT content_assets_filename_len CHECK (original_filename IS NULL OR length(original_filename) <= 255),
  CONSTRAINT content_assets_storage_key_len CHECK (length(storage_key) BETWEEN 1 AND 512)
);
CREATE UNIQUE INDEX content_assets_storage_key_uq ON content_assets (storage_key);
-- SHA-256 duplicate check: the same source PDF cannot be uploaded twice into one tenant.
CREATE UNIQUE INDEX content_assets_source_sha_uq ON content_assets (tenant_id, sha256)
  WHERE kind = 'source_pdf' AND deleted_at IS NULL;
CREATE INDEX content_assets_parent_idx ON content_assets (parent_asset_id) WHERE parent_asset_id IS NOT NULL;
CREATE TRIGGER content_assets_set_updated_at BEFORE UPDATE ON content_assets
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE ingestion_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  asset_id          uuid NOT NULL,
  requested_by      uuid,
  status            text NOT NULL DEFAULT 'queued',
  progress_pct      smallint NOT NULL DEFAULT 0,
  attempt_count     smallint NOT NULL DEFAULT 0,
  queue_job_id      text,
  pages_total       integer NOT NULL DEFAULT 0,
  pages_ocr         integer NOT NULL DEFAULT 0,
  blocks_theory     integer NOT NULL DEFAULT 0,
  blocks_question   integer NOT NULL DEFAULT 0,
  blocks_solution   integer NOT NULL DEFAULT 0,
  blocks_ambiguous  integer NOT NULL DEFAULT 0,
  error_code        text,
  error_message     text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_jobs_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT ingestion_jobs_asset_fk     FOREIGN KEY (tenant_id, asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT ingestion_jobs_requester_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  CONSTRAINT ingestion_jobs_status_valid CHECK (status IN (
    'queued', 'extracting', 'ocr', 'segmenting', 'classifying', 'tagging', 'normalizing',
    'matching', 'deduplicating', 'awaiting_review', 'publishing', 'published', 'failed', 'cancelled')),
  CONSTRAINT ingestion_jobs_progress_range CHECK (progress_pct BETWEEN 0 AND 100),
  CONSTRAINT ingestion_jobs_counts_nonneg  CHECK (attempt_count >= 0 AND pages_total >= 0 AND pages_ocr >= 0
    AND blocks_theory >= 0 AND blocks_question >= 0 AND blocks_solution >= 0 AND blocks_ambiguous >= 0),
  CONSTRAINT ingestion_jobs_ocr_le_total   CHECK (pages_ocr <= pages_total),
  CONSTRAINT ingestion_jobs_failed_has_error CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT ingestion_jobs_terminal_finished CHECK ((status IN ('published', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT ingestion_jobs_time_order     CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CONSTRAINT ingestion_jobs_published_full CHECK (status <> 'published' OR progress_pct = 100)
);
CREATE INDEX ingestion_jobs_status_idx ON ingestion_jobs (tenant_id, status, created_at DESC);
CREATE INDEX ingestion_jobs_asset_idx ON ingestion_jobs (tenant_id, asset_id);
CREATE TRIGGER ingestion_jobs_set_updated_at BEFORE UPDATE ON ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE extracted_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  job_id          uuid NOT NULL,
  asset_id        uuid NOT NULL,
  page_number     integer NOT NULL,
  method          text NOT NULL,
  text_content    text NOT NULL DEFAULT '',
  char_count      integer GENERATED ALWAYS AS (length(text_content)) STORED,
  ocr_confidence  numeric(4, 3),
  image_asset_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extracted_pages_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT extracted_pages_job_fk   FOREIGN KEY (tenant_id, job_id) REFERENCES ingestion_jobs (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT extracted_pages_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT extracted_pages_image_fk FOREIGN KEY (tenant_id, image_asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT extracted_pages_job_page_uq UNIQUE (job_id, page_number),
  CONSTRAINT extracted_pages_page_positive CHECK (page_number >= 1),
  CONSTRAINT extracted_pages_method_valid  CHECK (method IN ('text_layer', 'ocr')),
  CONSTRAINT extracted_pages_confidence    CHECK (ocr_confidence IS NULL OR ocr_confidence BETWEEN 0 AND 1),
  CONSTRAINT extracted_pages_confidence_ocr_only CHECK (method = 'ocr' OR ocr_confidence IS NULL)
);
CREATE TRIGGER extracted_pages_set_updated_at BEFORE UPDATE ON extracted_pages
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE content_blocks (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL,
  job_id                     uuid,     -- NULL for manually authored blocks
  page_id                    uuid,
  asset_id                   uuid,     -- source document
  source_page                integer,
  bbox                       jsonb,    -- {x, y, w, h} in page units
  kind                       text NOT NULL,
  format                     text NOT NULL DEFAULT 'paragraph',
  title                      text,
  raw_text                   text NOT NULL,
  normalized_text            text,
  content_json               jsonb,
  content_hash               text NOT NULL,   -- sha256 hex of the normalised text (computed by the app)
  classification_confidence  numeric(4, 3),
  classified_by              text,
  subtopic_id                uuid,
  tagging_confidence         numeric(4, 3),
  sort_order                 integer NOT NULL DEFAULT 0,
  status                     text NOT NULL DEFAULT 'extracted',
  merged_into_id             uuid,
  split_from_id              uuid,
  reviewed_by                uuid,
  reviewed_at                timestamptz,
  published_at               timestamptz,
  search_tsv                 tsvector GENERATED ALWAYS AS
                               (to_tsvector('english'::regconfig, coalesce(normalized_text, raw_text))) STORED,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  deleted_at                 timestamptz,
  CONSTRAINT content_blocks_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT content_blocks_job_fk      FOREIGN KEY (tenant_id, job_id) REFERENCES ingestion_jobs (tenant_id, id),
  CONSTRAINT content_blocks_page_fk     FOREIGN KEY (tenant_id, page_id) REFERENCES extracted_pages (tenant_id, id),
  CONSTRAINT content_blocks_asset_fk    FOREIGN KEY (tenant_id, asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT content_blocks_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT content_blocks_merged_fk   FOREIGN KEY (tenant_id, merged_into_id) REFERENCES content_blocks (tenant_id, id),
  CONSTRAINT content_blocks_split_fk    FOREIGN KEY (tenant_id, split_from_id) REFERENCES content_blocks (tenant_id, id),
  CONSTRAINT content_blocks_reviewer_fk FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users (tenant_id, id),
  CONSTRAINT content_blocks_kind_valid   CHECK (kind IN ('theory', 'question', 'solution', 'ambiguous')),
  CONSTRAINT content_blocks_format_valid CHECK (format IN ('heading', 'paragraph', 'formula', 'callout', 'list', 'table', 'figure', 'example')),
  CONSTRAINT content_blocks_status_valid CHECK (status IN ('extracted', 'needs_review', 'approved', 'rejected', 'published', 'superseded')),
  CONSTRAINT content_blocks_classified_by_valid CHECK (classified_by IS NULL OR classified_by IN ('model', 'rule', 'human')),
  -- traceability: a block either cites its source page or is manually authored (neither)
  CONSTRAINT content_blocks_source_pair  CHECK ((asset_id IS NULL) = (source_page IS NULL)),
  CONSTRAINT content_blocks_page_positive CHECK (source_page IS NULL OR source_page >= 1),
  CONSTRAINT content_blocks_extracted_has_source CHECK (job_id IS NULL OR asset_id IS NOT NULL),
  CONSTRAINT content_blocks_bbox_object  CHECK (bbox IS NULL OR jsonb_typeof(bbox) = 'object'),
  CONSTRAINT content_blocks_json_shape   CHECK (content_json IS NULL OR jsonb_typeof(content_json) IN ('object', 'array')),
  CONSTRAINT content_blocks_text_length  CHECK (length(raw_text) BETWEEN 1 AND 100000),
  CONSTRAINT content_blocks_title_length CHECK (title IS NULL OR length(title) <= 300),
  CONSTRAINT content_blocks_hash_hex     CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_blocks_confidences  CHECK ((classification_confidence IS NULL OR classification_confidence BETWEEN 0 AND 1)
                                           AND (tagging_confidence IS NULL OR tagging_confidence BETWEEN 0 AND 1)),
  CONSTRAINT content_blocks_sort_nonneg  CHECK (sort_order >= 0),
  -- an ambiguous block must be reclassified before it can be approved or published
  CONSTRAINT content_blocks_ambiguous_unapproved CHECK (kind <> 'ambiguous' OR status NOT IN ('approved', 'published')),
  CONSTRAINT content_blocks_published_tagged CHECK (status <> 'published' OR (subtopic_id IS NOT NULL AND published_at IS NOT NULL)),
  CONSTRAINT content_blocks_reviewed_pair CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CONSTRAINT content_blocks_not_self_merged CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CONSTRAINT content_blocks_merged_superseded CHECK (merged_into_id IS NULL OR status = 'superseded')
);
CREATE INDEX content_blocks_theory_idx ON content_blocks (tenant_id, subtopic_id, sort_order)
  WHERE kind = 'theory' AND status = 'published' AND deleted_at IS NULL;
CREATE INDEX content_blocks_review_idx ON content_blocks (tenant_id, status, kind) WHERE deleted_at IS NULL;
CREATE INDEX content_blocks_job_page_idx ON content_blocks (job_id, source_page, sort_order) WHERE job_id IS NOT NULL;
CREATE INDEX content_blocks_hash_idx ON content_blocks (tenant_id, content_hash);
CREATE INDEX content_blocks_search_idx ON content_blocks USING gin (search_tsv);
CREATE TRIGGER content_blocks_set_updated_at BEFORE UPDATE ON content_blocks
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
