-- Structural guarantees that apply to the whole schema.
BEGIN;

SELECT pg_temp.ok(
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY (ARRAY[
    'tenants', 'users', 'tracks', 'subjects', 'chapters', 'topics', 'subtopics', 'content_assets',
    'ingestion_jobs', 'extracted_pages', 'content_blocks', 'questions', 'question_options',
    'official_solutions', 'explanations', 'review_tasks', 'attempts', 'ability_scores', 'sessions',
    'session_events', 'benchmark_snapshots', 'reports', 'engine_config', 'audit_log'])) = 24,
  'all 24 required non-vector tables exist');

SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
  OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'block_embeddings'),
  'block_embeddings exists wherever the pgvector extension is installed');

SELECT pg_temp.ok(
  (SELECT count(*) FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND t.table_name NOT IN ('tenants', 'audit_log', 'schema_migrations')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                         AND c.column_name = 'tenant_id' AND c.is_nullable = 'NO')) = 0,
  'every tenant-owned table has a NOT NULL tenant_id');

SELECT pg_temp.ok(
  (SELECT count(*) FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'id' AND c.data_type <> 'uuid') = 0,
  'every id column is a uuid');

SELECT pg_temp.ok(
  (SELECT count(*) FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'updated_at'
      AND NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class cl ON cl.oid = tg.tgrelid
                       WHERE cl.relname = c.table_name AND tg.tgname = c.table_name || '_set_updated_at')) = 0,
  'every updated_at column is maintained by a trigger');

SELECT pg_temp.ok(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('attempts', 'audit_log')
      AND column_name IN ('updated_at', 'deleted_at')) = 0,
  'immutable tables carry no updated_at / deleted_at columns');

SELECT pg_temp.ok(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'attempts'
      AND column_name IN ('difficulty_b_at_attempt', 'question_version', 'engine_config_id', 'ttfi_ms',
                          'total_time_ms', 'answer_changes', 'device_type', 'probable_guess', 'is_probe')) = 9,
  'attempts store difficulty_b, version, config and timing at answer time');

SELECT pg_temp.ok(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session_events'
      AND data_type IN ('json', 'jsonb', 'text') AND column_name NOT IN ('event_type')) = 0,
  'session_events has no free-form payload column (only the typed event_type)');

ROLLBACK;
