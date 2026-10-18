-- =============================================================================
-- 0006_analytics
-- Anonymous nightly benchmark snapshots and generated student reports.
-- =============================================================================

-- Anonymous benchmark per sub-topic (optionally per difficulty level) over a
-- rolling window. No user ids, names or ranks are stored. Values are only kept
-- when the qualifying cohort meets the configured minimum; below it, the row
-- records that the snapshot was withheld and nothing else.
CREATE TABLE benchmark_snapshots (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL,
  subtopic_id              uuid NOT NULL,
  difficulty_label         smallint,          -- NULL = all levels
  snapshot_date            date NOT NULL,
  window_days              smallint NOT NULL,
  window_start             timestamptz NOT NULL,
  window_end               timestamptz NOT NULL,
  qualifying_students      integer NOT NULL,
  min_qualifying_students  integer NOT NULL,
  top_k                    smallint NOT NULL,
  is_published             boolean NOT NULL,
  top_accuracy             numeric(5, 4),
  top_median_time_ms       integer,
  engine_config_id         uuid NOT NULL,
  computed_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT benchmark_snapshots_subtopic_fk FOREIGN KEY (tenant_id, subtopic_id) REFERENCES subtopics (tenant_id, id),
  CONSTRAINT benchmark_snapshots_config_fk   FOREIGN KEY (tenant_id, engine_config_id) REFERENCES engine_config (tenant_id, id),
  CONSTRAINT benchmark_snapshots_uq UNIQUE NULLS NOT DISTINCT (tenant_id, subtopic_id, difficulty_label, snapshot_date),
  CONSTRAINT benchmark_snapshots_label_range   CHECK (difficulty_label IS NULL OR difficulty_label BETWEEN 1 AND 5),
  CONSTRAINT benchmark_snapshots_window        CHECK (window_days BETWEEN 1 AND 365 AND window_end > window_start),
  CONSTRAINT benchmark_snapshots_counts        CHECK (qualifying_students >= 0 AND min_qualifying_students >= 1 AND top_k >= 1),
  CONSTRAINT benchmark_snapshots_values_range  CHECK ((top_accuracy IS NULL OR top_accuracy BETWEEN 0 AND 1)
                                                      AND (top_median_time_ms IS NULL OR top_median_time_ms >= 0)),
  -- publication requires a large enough cohort (and at least top_k students)
  CONSTRAINT benchmark_snapshots_publish_threshold CHECK (NOT is_published
    OR (qualifying_students >= min_qualifying_students AND qualifying_students >= top_k)),
  CONSTRAINT benchmark_snapshots_published_values  CHECK (NOT is_published
    OR (top_accuracy IS NOT NULL AND top_median_time_ms IS NOT NULL)),
  -- nothing about an under-threshold cohort is retained
  CONSTRAINT benchmark_snapshots_withheld_empty    CHECK (is_published
    OR (top_accuracy IS NULL AND top_median_time_ms IS NULL))
);
CREATE INDEX benchmark_snapshots_lookup_idx ON benchmark_snapshots (tenant_id, subtopic_id, snapshot_date DESC)
  WHERE is_published;

-- Generated performance reports (GET /v1/me/reports). Student flags on faulty
-- questions are review_tasks(kind = 'student_report'), not rows here.
CREATE TABLE reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  kind           text NOT NULL,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  payload        jsonb,
  file_asset_id  uuid,
  error_message  text,
  generated_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT reports_user_fk  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT reports_file_fk  FOREIGN KEY (tenant_id, file_asset_id) REFERENCES content_assets (tenant_id, id),
  CONSTRAINT reports_kind_valid   CHECK (kind IN ('weekly', 'monthly', 'on_demand')),
  CONSTRAINT reports_status_valid CHECK (status IN ('pending', 'ready', 'failed')),
  CONSTRAINT reports_period_order CHECK (period_end >= period_start),
  CONSTRAINT reports_ready_state  CHECK ((status = 'ready') = (payload IS NOT NULL AND generated_at IS NOT NULL)),
  CONSTRAINT reports_failed_state CHECK ((status = 'failed') = (error_message IS NOT NULL)),
  CONSTRAINT reports_payload_object CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object')
);
CREATE UNIQUE INDEX reports_periodic_uq ON reports (tenant_id, user_id, kind, period_start, period_end)
  WHERE kind <> 'on_demand';
CREATE INDEX reports_user_idx ON reports (tenant_id, user_id, period_end DESC, id DESC);
CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();
