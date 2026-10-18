-- Content ingestion: what the database itself guarantees about uploads, jobs, extracted
-- pages and review tasks — independently of the application that writes them.
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  t     uuid := pg_temp.fx_tenant('ingest');
  t2    uuid := pg_temp.fx_tenant('ingest-other');
  st    uuid := pg_temp.fx_subtopic(t);
  u     uuid := pg_temp.fx_user(t, 'admin@ingest.test', 'ADMIN');
  q     uuid := pg_temp.fx_question(t, st, 3);
  sha   text := repeat('ab', 32);
  a1    uuid;
  j1    uuid;
  j2    uuid;
  b1    uuid;
  p1    uuid;
BEGIN
  -- content_assets: the duplicate key is per tenant ---------------------------
  INSERT INTO content_assets (tenant_id, kind, storage_key, original_filename, mime_type, byte_size, sha256, page_count, uploaded_by)
  VALUES (t, 'source_pdf', 'tenants/a/source_pdf/2026/09/one.pdf', 'one.pdf', 'application/pdf', 1024, sha, 4, u)
  RETURNING id INTO a1;

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256)
       VALUES (%L, ''source_pdf'', ''tenants/a/source_pdf/2026/09/two.pdf'', ''application/pdf'', 1024, %L)', t, sha),
    '23505', 'the same PDF cannot be uploaded twice to one organisation');

  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256)
       VALUES (%L, ''source_pdf'', ''tenants/b/source_pdf/2026/09/one.pdf'', ''application/pdf'', 1024, %L)', t2, sha),
    'two organisations may hold the same PDF');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256)
       VALUES (%L, ''source_pdf'', ''tenants/a/source_pdf/2026/09/one.pdf'', ''application/pdf'', 1024, %L)', t2, repeat('cd', 32)),
    '23505', 'a storage key is unique across the whole store, not per organisation');

  -- A soft-deleted asset releases its SHA, so a document can be re-uploaded after removal.
  UPDATE content_assets SET deleted_at = now() WHERE id = a1;
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO content_assets (tenant_id, kind, storage_key, mime_type, byte_size, sha256, page_count, uploaded_by)
       VALUES (%L, ''source_pdf'', ''tenants/a/source_pdf/2026/09/again.pdf'', ''application/pdf'', 1024, %L, 4, %L)', t, sha, u),
    'a deleted asset releases its SHA-256 for re-upload');
  DELETE FROM content_assets WHERE tenant_id = t AND storage_key = 'tenants/a/source_pdf/2026/09/again.pdf';
  UPDATE content_assets SET deleted_at = NULL WHERE id = a1;

  -- ingestion_jobs: stages, progress and the terminal states -------------------
  INSERT INTO ingestion_jobs (tenant_id, asset_id, requested_by, pages_total) VALUES (t, a1, u, 4) RETURNING id INTO j1;
  PERFORM pg_temp.ok((SELECT status = 'queued' AND progress_pct = 0 AND attempt_count = 0 FROM ingestion_jobs WHERE id = j1),
    'a new job starts queued at zero progress');

  PERFORM pg_temp.expect_error(format('UPDATE ingestion_jobs SET status = ''embedding'' WHERE id = %L', j1),
    '23514', 'a job cannot be put into a stage the schema does not define');
  PERFORM pg_temp.expect_error(format('UPDATE ingestion_jobs SET progress_pct = 101 WHERE id = %L', j1),
    '23514', 'progress cannot exceed 100');
  PERFORM pg_temp.expect_error(format('UPDATE ingestion_jobs SET pages_ocr = 9 WHERE id = %L', j1),
    '23514', 'more pages cannot be OCR''d than the document has');

  -- A failure must carry a code, and a code must mean a failure.
  PERFORM pg_temp.expect_error(format('UPDATE ingestion_jobs SET status = ''failed'', finished_at = now() WHERE id = %L', j1),
    '23514', 'a failed job must record why it failed');
  PERFORM pg_temp.expect_error(format('UPDATE ingestion_jobs SET error_code = ''asset_unreadable'' WHERE id = %L', j1),
    '23514', 'an error code cannot be set on a job that has not failed');
  PERFORM pg_temp.expect_ok(format(
    'UPDATE ingestion_jobs SET status = ''failed'', error_code = ''asset_unreadable'', error_message = ''gone'', finished_at = now() WHERE id = %L', j1),
    'a failed job records its code, its message and when it stopped');

  -- Only a terminal state is finished, and a published job is fully processed.
  PERFORM pg_temp.expect_error(format(
    'UPDATE ingestion_jobs SET status = ''awaiting_review'', error_code = NULL, error_message = NULL WHERE id = %L', j1),
    '23514', 'a job awaiting review is not finished, so it cannot keep a finished timestamp');
  PERFORM pg_temp.expect_ok(format(
    'UPDATE ingestion_jobs SET status = ''awaiting_review'', error_code = NULL, error_message = NULL, finished_at = NULL,
            progress_pct = 95 WHERE id = %L', j1),
    'a job can return to a stage after a failure is cleared');
  PERFORM pg_temp.expect_error(format(
    'UPDATE ingestion_jobs SET status = ''published'', progress_pct = 95, finished_at = now() WHERE id = %L', j1),
    '23514', 'a published job must be at 100 per cent');

  -- Tenant isolation is structural: a job cannot point at another organisation's asset.
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO ingestion_jobs (tenant_id, asset_id) VALUES (%L, %L)', t2, a1),
    '23503', 'a job cannot reference another organisation''s asset');

  -- extracted_pages: one row per page, with a computed character count ---------
  INSERT INTO ingestion_jobs (tenant_id, asset_id, requested_by, pages_total) VALUES (t, a1, u, 2) RETURNING id INTO j2;
  INSERT INTO extracted_pages (tenant_id, job_id, asset_id, page_number, method, text_content)
  VALUES (t, j2, a1, 1, 'text_layer', 'Angular momentum is conserved.') RETURNING id INTO p1;
  PERFORM pg_temp.ok((SELECT char_count = 30 FROM extracted_pages WHERE id = p1),
    'the character count is computed by the database, not supplied');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO extracted_pages (tenant_id, job_id, asset_id, page_number, method, text_content)
       VALUES (%L, %L, %L, 1, ''ocr'', ''again'')', t, j2, a1),
    '23505', 'a job records each page once, so a re-run replaces rather than duplicates');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO extracted_pages (tenant_id, job_id, asset_id, page_number, method, text_content)
       VALUES (%L, %L, %L, 2, ''guessed'', ''x'')', t, j2, a1),
    '23514', 'a page is read from the text layer or by OCR, and nothing else');

  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO extracted_pages (tenant_id, job_id, asset_id, page_number, method, text_content, ocr_confidence)
       VALUES (%L, %L, %L, 2, ''ocr'', ''scanned text'', 0.812)', t, j2, a1),
    'an OCR page records its own confidence');

  -- content_blocks: provenance and the ambiguous rule -------------------------
  INSERT INTO content_blocks (tenant_id, job_id, asset_id, source_page, kind, format, raw_text, normalized_text,
                              content_hash, classified_by, classification_confidence, subtopic_id, sort_order, status)
  VALUES (t, j2, a1, 1, 'question', 'paragraph', 'Find the angular momentum.', 'Find the angular momentum.',
          repeat('0', 64), 'rule', 0.95, st, 0, 'extracted')
  RETURNING id INTO b1;

  PERFORM pg_temp.expect_error(format(
    'UPDATE content_blocks SET kind = ''ambiguous'', status = ''approved'' WHERE id = %L', b1),
    '23514', 'an ambiguous block cannot be approved without being reclassified first');

  PERFORM pg_temp.expect_ok(format('UPDATE content_blocks SET status = ''needs_review'' WHERE id = %L', b1),
    'a block can be sent to review');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_blocks (tenant_id, job_id, asset_id, source_page, kind, raw_text, content_hash)
       VALUES (%L, %L, %L, 1, ''theory'', ''x'', %L)', t2, j2, a1, repeat('1', 64)),
    '23503', 'a block cannot belong to one organisation and another organisation''s job');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_blocks (tenant_id, job_id, kind, raw_text, content_hash) VALUES (%L, %L, ''theory'', ''x'', %L)',
    t, j2, repeat('1', 64)),
    '23514', 'a block from a job must say which asset it came from');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO content_blocks (tenant_id, job_id, asset_id, kind, raw_text, content_hash)
       VALUES (%L, %L, %L, ''theory'', ''x'', %L)', t, j2, a1, repeat('2', 64)),
    '23514', 'a block from an asset must say which page of it, so provenance is never partial');

  -- review_tasks: what a task may point at ------------------------------------
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, reason) VALUES (%L, ''theory_review'', ''nothing to act on'')', t),
    '23514', 'a task with no target at all is refused');

  -- Migration 0012: a page that could not be read has only its job to name.
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO review_tasks (tenant_id, kind, priority, job_id, reason)
       VALUES (%L, ''theory_review'', 2, %L, ''page 2 could not be read and no OCR provider is configured'')', t, j2),
    'a task may name only the job, for a page that produced no block');

  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO review_tasks (tenant_id, kind, priority, job_id, content_block_id, reason)
       VALUES (%L, ''question_review'', 1, %L, %L, ''the question is incomplete'')', t, j2, b1),
    'a task naming a block is unchanged by that');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, job_id, reason) VALUES (%L, ''content_gap'', %L, ''no sub-topic'')', t, j2),
    '23514', 'a content_gap task still has to name the sub-topic that is short of questions');

  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO review_tasks (tenant_id, kind, job_id, content_block_id, duplicate_of_question_id, reason)
       VALUES (%L, ''duplicate_candidate'', %L, %L, %L, ''looks like an existing question'')', t, j2, b1, q),
    'a duplicate task names both the new block and the existing question');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, job_id, content_block_id, status, reason)
       VALUES (%L, ''theory_review'', %L, %L, ''resolved'', ''done'')', t, j2, b1),
    '23514', 'a resolved task must record when it was resolved');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO review_tasks (tenant_id, kind, job_id, content_block_id, reporter_user_id, reason)
       VALUES (%L, ''theory_review'', %L, %L, %L, ''x'')', t, j2, b1, u),
    '23514', 'only a student report carries a reporter');

  PERFORM pg_temp.ok(
    (SELECT count(*) FROM review_tasks WHERE tenant_id = t AND job_id = j2 AND status = 'open') = 3,
    'the open tasks of a job are countable, which is what the admin API reports');
END $$;

ROLLBACK;
