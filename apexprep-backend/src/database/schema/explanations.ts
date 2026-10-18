import { integer, jsonb, numeric, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/**
 * Mirror of the explanation tables: `explanations` (migration 0004, + `option_key` from 0011)
 * and `block_embeddings` (migration 0007, which needs the pgvector extension).
 *
 * `block_embeddings.embedding` is deliberately **not** mirrored as a column: Drizzle has no
 * `vector` type, and the value only ever moves through raw `sql` templates that cast it
 * (`embedding::vector(N)`), so mirroring it as text would invite writing it the wrong way.
 * The schema-drift test knows to exclude it.
 */

export const EXPLANATION_TIERS = ['official_solution', 'rag_grounded', 'general_ai'] as const;
export const EXPLANATION_STATUSES = ['active', 'superseded', 'flagged', 'rejected'] as const;
export const RETRIEVAL_SCOPES = ['subtopic', 'topic', 'chapter'] as const;

export type ExplanationTier = (typeof EXPLANATION_TIERS)[number];
export type ExplanationStatusValue = (typeof EXPLANATION_STATUSES)[number];
export type RetrievalScopeValue = (typeof RETRIEVAL_SCOPES)[number];

/**
 * What is stored in `explanations.content`. The student-facing projection is built from this
 * in the service; the raw row also carries the provenance the student never sees.
 */
export interface ExplanationContent {
  summary: string;
  steps: string[];
  keyConcept: string | null;
  commonMistake: string | null;
  /** The answer the explanation argued for, kept so the answer-match check is auditable. */
  finalAnswer: Record<string, unknown> | null;
  /** Internal retrieval and validation trace. Never projected to a student. */
  diagnostics?: Record<string, unknown>;
}

export const explanations = pgTable('explanations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  questionId: uuid('question_id').notNull(),
  questionVersion: integer('question_version').notNull(),
  sourceTier: text('source_tier', { enum: EXPLANATION_TIERS }).notNull(),
  officialSolutionId: uuid('official_solution_id'),
  provider: text('provider'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  groundingScore: numeric('grounding_score', { precision: 4, scale: 3, mode: 'number' }),
  groundingBlockIds: uuid('grounding_block_ids').array().notNull().default([]),
  retrievalScope: text('retrieval_scope', { enum: RETRIEVAL_SCOPES }),
  content: jsonb('content').$type<ExplanationContent>().notNull(),
  status: text('status', { enum: EXPLANATION_STATUSES }).notNull().default('active'),
  generatedAt: tstz('generated_at').notNull().defaultNow(),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: tstz('reviewed_at'),
  /** NULL = the explanation for the question itself; otherwise the distractor it also covers. */
  optionKey: text('option_key'),
  ...timestamps,
});

export const blockEmbeddings = pgTable('block_embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  blockId: uuid('block_id').notNull(),
  model: text('model').notNull(),
  dims: smallint('dims').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export type ExplanationRow = typeof explanations.$inferSelect;
export type BlockEmbeddingRow = typeof blockEmbeddings.$inferSelect;
