-- =============================================================================
-- 0012_ingestion_job_review_tasks
--
-- WHY THIS MIGRATION IS NEEDED
--
-- Phase 7 requires that a page the pipeline cannot read is never silently
-- dropped: a scanned page with no usable text layer, and no OCR provider able to
-- read it, has to reach a person. The only thing that reaches a person in this
-- system is a `review_tasks` row.
--
-- Such a task has nothing to point at except the job. The page produced no
-- content block (there was no text to segment), no question, no explanation, and
-- no sub-topic — that is precisely the problem being reported. But
-- migration 0004 wrote
--
--   CONSTRAINT review_tasks_has_target
--     CHECK (num_nonnulls(content_block_id, question_id, explanation_id, subtopic_id) >= 1)
--
-- so the insert is refused and the page is lost with it.
--
-- The alternatives were both worse. Attaching the task to some other block on the
-- page is a lie about which content is in question, and a blank page has no other
-- block anyway. Inventing a placeholder `content_blocks` row means writing text
-- into the content tables that the source document does not contain, which is the
-- one thing ingestion must never do.
--
-- WHAT THIS CHANGES
--
-- `job_id` becomes an acceptable target. That keeps the guarantee the constraint
-- exists for — a task must name something a reviewer can act on — because an
-- ingestion job is actionable: the reviewer looks at the source document and
-- re-uploads a better scan. It is a strict loosening: every row that satisfied
-- the old constraint satisfies the new one, so no existing data can conflict and
-- the change is safe to apply to a live database.
--
-- Nothing else about `review_tasks` changes, and no Phase 1-6 behaviour depends
-- on the old form: every task those phases create names a block, question,
-- explanation or sub-topic, and still does.
-- =============================================================================

ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_has_target;

ALTER TABLE review_tasks
  ADD CONSTRAINT review_tasks_has_target
  CHECK (num_nonnulls(content_block_id, question_id, explanation_id, subtopic_id, job_id) >= 1);

-- Finding the open tasks of one job is how the admin API reports what a reviewer
-- still has to do with an upload, and it is now also how a page-level task is
-- found at all.
CREATE INDEX IF NOT EXISTS review_tasks_job_open_idx
  ON review_tasks (tenant_id, job_id, priority, created_at)
  WHERE status IN ('open', 'in_progress');
