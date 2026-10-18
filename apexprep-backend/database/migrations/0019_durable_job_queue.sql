-- =============================================================================
-- 0019_durable_job_queue
--
-- Lets ingestion jobs be claimed, leased and recovered through PostgreSQL alone — no Redis, no broker.
--
--   * locked_by / locked_until — which worker holds a job and until when. A worker renews the lease while it
--     works; a lease that lapses means the worker died, and another worker may take the job over.
--   * max_attempts — how many times a job may be started before it is failed for good (a job that kills its
--     worker every time must not loop forever).
--   * next_attempt_at — when a queued job may next be claimed (reserved for backoff after a transient failure).
--
-- Additive only: every column is nullable or defaulted, no row is rewritten, and nothing is deleted. Existing
-- jobs keep their status; a job stranded mid-stage by an earlier crash has no lease (`locked_until IS NULL`),
-- which the worker treats as recoverable.
-- =============================================================================

ALTER TABLE ingestion_jobs
  ADD COLUMN IF NOT EXISTS locked_by       text,
  ADD COLUMN IF NOT EXISTS locked_until    timestamptz,
  ADD COLUMN IF NOT EXISTS max_attempts    smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- The worker's two questions: "what is waiting?" and "whose lease has lapsed?".
CREATE INDEX IF NOT EXISTS ingestion_jobs_claimable_idx
  ON ingestion_jobs (created_at)
  WHERE status IN ('queued', 'extracting', 'ocr', 'segmenting', 'classifying', 'tagging', 'normalizing', 'matching', 'deduplicating');
