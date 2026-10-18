-- =============================================================================
-- 0007_pgvector
-- Embeddings for RAG over published theory. Requires the pgvector extension
-- (the pgvector/pgvector:pg16 image in docker-compose.yml provides it).
--
-- The column is an un-dimensioned `vector` with a `dims` check, and ANN indexes
-- are partial per dimension, on `embedding::vector(N)`. Switching AI provider
-- (e.g. 768-d → 1536-d) therefore means adding one index and re-embedding —
-- not a destructive column change. Queries must use the same cast expression
-- and filter on `dims` and `model` to hit the index.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE block_embeddings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  block_id      uuid NOT NULL,
  model         text NOT NULL,
  dims          smallint NOT NULL,
  embedding     vector NOT NULL,
  content_hash  text NOT NULL,     -- hash of the exact text embedded; unchanged hash = skip re-embedding
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT block_embeddings_block_fk FOREIGN KEY (tenant_id, block_id)
    REFERENCES content_blocks (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT block_embeddings_block_model_uq UNIQUE (block_id, model),
  CONSTRAINT block_embeddings_model_length CHECK (length(model) BETWEEN 1 AND 100),
  CONSTRAINT block_embeddings_dims_range   CHECK (dims BETWEEN 64 AND 4000),
  CONSTRAINT block_embeddings_dims_match   CHECK (vector_dims(embedding) = dims),
  CONSTRAINT block_embeddings_hash_hex     CHECK (content_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX block_embeddings_tenant_model_idx ON block_embeddings (tenant_id, model);

-- ANN index for 768-dimension models (default embedding size in .env.example).
-- Add one partial index per additional dimension actually in use.
CREATE INDEX block_embeddings_hnsw_768 ON block_embeddings
  USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WHERE dims = 768;
