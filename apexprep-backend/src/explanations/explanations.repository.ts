import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { TrackIdentity } from '../common/learning/track-identity';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import {
  attempts,
  blockEmbeddings,
  contentBlocks,
  explanations,
  questions,
  reviewTasks,
  subtopics,
  type ExplanationRow,
  type ReviewTaskRow,
} from '../database/schema';
import type { ChunkSource } from './chunking';
import type { RetrievalScope } from './retrieval';

/** The question facts the explanation path needs, with its place in the syllabus. */
export interface QuestionForExplanation {
  id: string;
  version: number;
  type: string;
  stem: string;
  status: string;
  subtopicId: string;
  subtopicName: string;
  topicId: string;
  chapterId: string;
  /** The track, for the Olympiad mandatory-approval rule: `kind` decides it, not the slug. */
  track: TrackIdentity;
  expectedTimeSeconds: number;
}

/** A theory block that can ground an explanation, with the scores retrieval ranked it by. */
export interface ThreadedCandidate extends ChunkSource {
  scope: RetrievalScope;
  vectorScore: number | null;
  keywordScore: number;
  updatedAt: Date;
}

/**
 * All explanation data access, tenant-scoped.
 *
 * Retrieval is two queries per scope — a keyword query over `content_blocks.search_tsv`, and
 * a vector query over `block_embeddings` — fused above this layer. They are separate because
 * the vector one needs the pgvector extension, which an operator may not have installed:
 * `semanticAvailable()` probes for it once, and when it is absent retrieval runs on keywords
 * alone and says so in the stored diagnostics rather than pretending a vector search happened.
 */
@Injectable()
export class ExplanationsRepository {
  private readonly logger = new Logger(ExplanationsRepository.name);
  private semantic: boolean | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Whether this server can run vector search at all (pgvector installed, table present). */
  async semanticAvailable(): Promise<boolean> {
    if (this.semantic !== null) return this.semantic;
    const result = await this.db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'vector'
      ) AND EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'block_embeddings'
      ) AS ok
    `);
    this.semantic = result.rows[0]?.ok === true;
    if (!this.semantic) {
      this.logger.warn('pgvector is not installed: theory retrieval will run on keyword search alone');
    }
    return this.semantic;
  }

  // ---------------------------------------------------------------- the question

  async questionForExplanation(tenantId: string, questionId: string, tx: Executor = this.db): Promise<QuestionForExplanation | undefined> {
    const result = await tx.execute<Record<string, string | number | null>>(sql`
      SELECT q.id, q.version, q.type, q.stem, q.status, q.primary_subtopic_id AS subtopic_id,
             st.name AS subtopic_name, st.topic_id, tp.chapter_id,
             tr.slug AS track_slug, tr.kind AS track_kind,
             q.expected_time_seconds
        FROM ${questions} q
        JOIN subtopics st ON st.tenant_id = q.tenant_id AND st.id = q.primary_subtopic_id
        JOIN topics    tp ON tp.tenant_id = q.tenant_id AND tp.id = st.topic_id
        JOIN chapters  ch ON ch.tenant_id = q.tenant_id AND ch.id = tp.chapter_id
        JOIN subjects  sb ON sb.tenant_id = q.tenant_id AND sb.id = ch.subject_id
        JOIN tracks    tr ON tr.tenant_id = q.tenant_id AND tr.id = sb.track_id
       WHERE q.tenant_id = ${tenantId} AND q.id = ${questionId} AND q.deleted_at IS NULL
       LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: String(row.id),
      version: Number(row.version),
      type: String(row.type),
      stem: String(row.stem),
      status: String(row.status),
      subtopicId: String(row.subtopic_id),
      subtopicName: String(row.subtopic_name),
      topicId: String(row.topic_id),
      chapterId: String(row.chapter_id),
      track: { slug: String(row.track_slug), kind: row.track_kind === null ? null : String(row.track_kind) },
      expectedTimeSeconds: Number(row.expected_time_seconds),
    };
  }

  /** The option keys of a question, so a distractor key can be checked before it is used. */
  async optionKeys(tenantId: string, questionId: string, tx: Executor = this.db): Promise<string[]> {
    const result = await tx.execute<{ option_key: string }>(sql`
      SELECT option_key FROM question_options
       WHERE tenant_id = ${tenantId} AND question_id = ${questionId} AND side = 'single'
       ORDER BY sort_order, option_key
    `);
    return result.rows.map((r) => r.option_key);
  }

  /**
   * The wrong option this student actually chose, if any, so a distractor variant is served
   * from their own recorded attempt rather than from a query parameter they could invent.
   */
  async lastWrongOption(tenantId: string, userId: string, questionId: string, tx: Executor = this.db): Promise<string | null> {
    const result = await tx.execute<{ option_key: string | null }>(sql`
      SELECT (a.response -> 'option_keys' ->> 0) AS option_key
        FROM ${attempts} a
       WHERE a.tenant_id = ${tenantId} AND a.user_id = ${userId} AND a.question_id = ${questionId}
         AND a.outcome = 'incorrect'
         AND jsonb_typeof(a.response -> 'option_keys') = 'array'
         AND jsonb_array_length(a.response -> 'option_keys') = 1
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 1
    `);
    return result.rows[0]?.option_key ?? null;
  }

  /** Whether this student has answered this question at all: the eligibility gate. */
  async hasAttempted(tenantId: string, userId: string, questionId: string, tx: Executor = this.db): Promise<boolean> {
    const result = await tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM ${attempts}
         WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND question_id = ${questionId}
      ) AS ok
    `);
    return result.rows[0]?.ok === true;
  }

  // ---------------------------------------------------------------- retrieval

  /**
   * Published theory at one level of the syllabus, ranked by keyword match against the
   * question text. `ts_rank_cd` is normalised (flag 32) so the score is already in [0,1].
   *
   * The scope is a **hard filter in SQL**, not a ranking hint: a sub-topic query can only
   * return that sub-topic's blocks, so semantically similar notes from another chapter cannot
   * leak in. `exclude` keeps a widened query from returning what the narrower one already had.
   *
   * The terms are **OR-ed**, and this matters: `plainto_tsquery` and `websearch_to_tsquery`
   * both AND them, which would require a note to contain every content word of the question —
   * "ring", "find", "final" and all — so a perfectly relevant block matches nothing and the
   * keyword half of the hybrid search never fires. `plainto_tsquery` still does the useful
   * work (stemming, stopwords, escaping), and its text form contains only lexemes joined by
   * `&`, so swapping those for `|` is a safe way to get recall. `ts_rank_cd` then ranks by how
   * densely the terms actually appear, which is what decides the order.
   */
  async keywordCandidates(
    tenantId: string,
    scope: { level: RetrievalScope; subtopicId: string; topicId: string; chapterId: string },
    queryText: string,
    limit: number,
    exclude: readonly string[],
    tx: Executor = this.db,
  ): Promise<ThreadedCandidate[]> {
    const filter =
      scope.level === 'subtopic'
        ? sql`cb.subtopic_id = ${scope.subtopicId}`
        : scope.level === 'topic'
          ? sql`st.topic_id = ${scope.topicId}`
          : sql`tp.chapter_id = ${scope.chapterId}`;
    const notIn = exclude.length > 0 ? sql`AND cb.id <> ALL(${sql.param(exclude)}::uuid[])` : sql``;

    const result = await tx.execute<{
      id: string;
      title: string | null;
      text: string;
      sort_order: number;
      score: string | number;
      updated_at: string | Date;
    }>(sql`
      WITH q AS (
        SELECT nullif(replace(plainto_tsquery('english', ${queryText})::text, '&', '|'), '')::tsquery AS query
      )
      SELECT cb.id, cb.title, coalesce(cb.normalized_text, cb.raw_text) AS text, cb.sort_order,
             ts_rank_cd(cb.search_tsv, q.query, 32) AS score,
             cb.updated_at
        FROM ${contentBlocks} cb
        CROSS JOIN q
        JOIN subtopics st ON st.tenant_id = cb.tenant_id AND st.id = cb.subtopic_id
        JOIN topics    tp ON tp.tenant_id = cb.tenant_id AND tp.id = st.topic_id
       WHERE cb.tenant_id = ${tenantId}
         AND cb.kind = 'theory' AND cb.status = 'published' AND cb.deleted_at IS NULL
         AND st.status = 'published' AND st.deleted_at IS NULL
         AND ${filter}
         ${notIn}
         AND q.query IS NOT NULL
         AND cb.search_tsv @@ q.query
       ORDER BY score DESC, cb.sort_order
       LIMIT ${limit}
    `);

    return result.rows.map((r) => ({
      blockId: r.id,
      title: r.title,
      text: r.text,
      sortOrder: r.sort_order,
      scope: scope.level,
      vectorScore: null,
      keywordScore: clamp(Number(r.score)),
      updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    }));
  }

  /**
   * The same hard-filtered scope, ranked by cosine similarity against the question's
   * embedding. Only called when `semanticAvailable()` is true.
   *
   * The cast and the `dims`/`model` filters match migration 0007's partial HNSW index, so the
   * query uses the index instead of scanning; `1 - cosine_distance` puts the score in [0,1].
   */
  async vectorCandidates(
    tenantId: string,
    scope: { level: RetrievalScope; subtopicId: string; topicId: string; chapterId: string },
    embedding: readonly number[],
    model: string,
    limit: number,
    tx: Executor = this.db,
  ): Promise<ThreadedCandidate[]> {
    const filter =
      scope.level === 'subtopic'
        ? sql`cb.subtopic_id = ${scope.subtopicId}`
        : scope.level === 'topic'
          ? sql`st.topic_id = ${scope.topicId}`
          : sql`tp.chapter_id = ${scope.chapterId}`;
    const literal = `[${embedding.join(',')}]`;
    const dims = embedding.length;
    const vectorType = vectorTypeOf(dims);

    const result = await tx.execute<{
      id: string;
      title: string | null;
      text: string;
      sort_order: number;
      similarity: string | number;
      updated_at: string | Date;
    }>(sql`
      SELECT cb.id, cb.title, coalesce(cb.normalized_text, cb.raw_text) AS text, cb.sort_order,
             1 - ((be.embedding::${vectorType}) <=> ${literal}::${vectorType}) AS similarity,
             cb.updated_at
        FROM ${blockEmbeddings} be
        JOIN ${contentBlocks} cb ON cb.tenant_id = be.tenant_id AND cb.id = be.block_id
        JOIN subtopics st ON st.tenant_id = cb.tenant_id AND st.id = cb.subtopic_id
        JOIN topics    tp ON tp.tenant_id = cb.tenant_id AND tp.id = st.topic_id
       WHERE be.tenant_id = ${tenantId} AND be.model = ${model} AND be.dims = ${dims}
         AND cb.kind = 'theory' AND cb.status = 'published' AND cb.deleted_at IS NULL
         AND st.status = 'published' AND st.deleted_at IS NULL
         AND ${filter}
       ORDER BY (be.embedding::${vectorType}) <=> ${literal}::${vectorType}
       LIMIT ${limit}
    `);

    return result.rows.map((r) => ({
      blockId: r.id,
      title: r.title,
      text: r.text,
      sortOrder: r.sort_order,
      scope: scope.level,
      vectorScore: clamp(Number(r.similarity)),
      keywordScore: 0,
      updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    }));
  }

  /** Published theory blocks of a sub-topic, for indexing embeddings. */
  async publishedTheoryBlocks(tenantId: string, subtopicId: string, tx: Executor = this.db): Promise<(ChunkSource & { contentHash: string })[]> {
    const rows = await tx
      .select({
        blockId: contentBlocks.id,
        title: contentBlocks.title,
        raw: contentBlocks.rawText,
        normalized: contentBlocks.normalizedText,
        sortOrder: contentBlocks.sortOrder,
        contentHash: contentBlocks.contentHash,
      })
      .from(contentBlocks)
      .where(
        and(
          eq(contentBlocks.tenantId, tenantId),
          eq(contentBlocks.subtopicId, subtopicId),
          eq(contentBlocks.kind, 'theory'),
          eq(contentBlocks.status, 'published'),
          isNull(contentBlocks.deletedAt),
        ),
      )
      .orderBy(contentBlocks.sortOrder);
    return rows.map((r) => ({
      blockId: r.blockId,
      title: r.title,
      text: r.normalized ?? r.raw,
      sortOrder: r.sortOrder,
      contentHash: r.contentHash,
    }));
  }

  /** The latest `updated_at` across a set of blocks: the theory side of cache freshness. */
  async blocksLastChangedAt(tenantId: string, blockIds: readonly string[], tx: Executor = this.db): Promise<Date | null> {
    if (blockIds.length === 0) return null;
    const result = await tx.execute<{ at: string | Date | null }>(sql`
      SELECT max(updated_at) AS at FROM ${contentBlocks}
       WHERE tenant_id = ${tenantId} AND id = ANY(${sql.param(blockIds)}::uuid[])
    `);
    const at = result.rows[0]?.at ?? null;
    return at === null ? null : at instanceof Date ? at : new Date(at);
  }

  /** Upserts one block's embedding, skipping the write when the text has not changed. */
  async saveEmbedding(
    values: { tenantId: string; blockId: string; model: string; dims: number; contentHash: string; vector: readonly number[] },
    tx: Executor = this.db,
  ): Promise<'inserted' | 'updated' | 'unchanged'> {
    const literal = `[${values.vector.join(',')}]`;
    const result = await tx.execute<{ action: string }>(sql`
      INSERT INTO ${blockEmbeddings} (tenant_id, block_id, model, dims, embedding, content_hash)
      VALUES (${values.tenantId}, ${values.blockId}, ${values.model}, ${values.dims}, ${literal}::vector, ${values.contentHash})
      ON CONFLICT (block_id, model) DO UPDATE
        SET embedding = EXCLUDED.embedding, dims = EXCLUDED.dims, content_hash = EXCLUDED.content_hash, created_at = now()
        WHERE ${blockEmbeddings}.content_hash <> EXCLUDED.content_hash
      RETURNING CASE WHEN created_at = now() THEN 'inserted' ELSE 'updated' END AS action
    `);
    return (result.rows[0]?.action as 'inserted' | 'updated' | undefined) ?? 'unchanged';
  }

  // ---------------------------------------------------------------- explanations

  /** The active explanation for a question version, optionally the variant for one option. */
  async findActive(
    tenantId: string,
    questionId: string,
    questionVersion: number,
    optionKey: string | null,
    tx: Executor = this.db,
  ): Promise<ExplanationRow | undefined> {
    const [row] = await tx
      .select()
      .from(explanations)
      .where(
        and(
          eq(explanations.tenantId, tenantId),
          eq(explanations.questionId, questionId),
          eq(explanations.questionVersion, questionVersion),
          optionKey === null ? isNull(explanations.optionKey) : eq(explanations.optionKey, optionKey),
          eq(explanations.status, 'active'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * The most recent blocked explanation for this question version and option, so a question
   * whose generation keeps failing validation is not regenerated on every request.
   */
  async findBlocked(
    tenantId: string,
    questionId: string,
    questionVersion: number,
    optionKey: string | null,
    tx: Executor = this.db,
  ): Promise<ExplanationRow | undefined> {
    const [row] = await tx
      .select()
      .from(explanations)
      .where(
        and(
          eq(explanations.tenantId, tenantId),
          eq(explanations.questionId, questionId),
          eq(explanations.questionVersion, questionVersion),
          optionKey === null ? isNull(explanations.optionKey) : eq(explanations.optionKey, optionKey),
          inArray(explanations.status, ['rejected', 'flagged']),
        ),
      )
      .orderBy(desc(explanations.generatedAt))
      .limit(1);
    return row;
  }

  /** One explanation by id, tenant-scoped. Used by the review endpoints. */
  async findById(tenantId: string, id: string, tx: Executor = this.db): Promise<ExplanationRow | undefined> {
    const [row] = await tx
      .select()
      .from(explanations)
      .where(and(eq(explanations.tenantId, tenantId), eq(explanations.id, id)))
      .limit(1);
    return row;
  }

  async insert(values: PgInsertValue<typeof explanations>, tx: Executor = this.db): Promise<ExplanationRow> {
    const [row] = await tx.insert(explanations).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    patch: PgUpdateSetSource<typeof explanations>,
    tx: Executor = this.db,
  ): Promise<ExplanationRow | undefined> {
    const [row] = await tx
      .update(explanations)
      .set(patch)
      .where(and(eq(explanations.tenantId, tenantId), eq(explanations.id, id)))
      .returning();
    return row;
  }

  /** Marks every active explanation of a question (all variants) with a new status. */
  async setStatusForQuestion(
    tenantId: string,
    questionId: string,
    status: 'superseded' | 'flagged',
    tx: Executor = this.db,
  ): Promise<ExplanationRow[]> {
    return tx
      .update(explanations)
      .set({ status })
      .where(and(eq(explanations.tenantId, tenantId), eq(explanations.questionId, questionId), eq(explanations.status, 'active')))
      .returning();
  }

  // ---------------------------------------------------------------- review and reports

  /** Distinct students who have reported this question. */
  async distinctReporters(tenantId: string, questionId: string, tx: Executor = this.db): Promise<number> {
    const result = await tx.execute<{ n: string }>(sql`
      SELECT count(DISTINCT reporter_user_id) AS n FROM ${reviewTasks}
       WHERE tenant_id = ${tenantId} AND question_id = ${questionId} AND kind = 'student_report'
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  async insertReviewTask(values: PgInsertValue<typeof reviewTasks>, tx: Executor = this.db): Promise<ReviewTaskRow> {
    const [row] = await tx.insert(reviewTasks).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  /**
   * Opens one explanation-review task per explanation, idempotently: a second call while a
   * task is still open is a no-op, so a repeatedly failing question does not flood the queue.
   */
  async openExplanationReview(
    values: { tenantId: string; questionId: string; explanationId: string; reason: string; priority: number; suggestion: Record<string, unknown> },
    tx: Executor = this.db,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO ${reviewTasks} (tenant_id, kind, status, priority, question_id, explanation_id, reason, suggestion)
      SELECT ${values.tenantId}, 'explanation_review', 'open', ${values.priority}, ${values.questionId}, ${values.explanationId},
             ${values.reason}, ${JSON.stringify(values.suggestion)}::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM ${reviewTasks}
          WHERE tenant_id = ${values.tenantId} AND explanation_id = ${values.explanationId}
            AND kind = 'explanation_review' AND status IN ('open', 'in_progress'))
    `);
  }

  /** A student's own report on a question, if they have one. */
  async findReport(tenantId: string, questionId: string, userId: string, tx: Executor = this.db): Promise<ReviewTaskRow | undefined> {
    const [row] = await tx
      .select()
      .from(reviewTasks)
      .where(
        and(
          eq(reviewTasks.tenantId, tenantId),
          eq(reviewTasks.questionId, questionId),
          eq(reviewTasks.reporterUserId, userId),
          eq(reviewTasks.kind, 'student_report'),
        ),
      )
      .orderBy(desc(reviewTasks.createdAt))
      .limit(1);
    return row;
  }

  /** The sub-topic's name, for the prompt. */
  async subtopicName(tenantId: string, subtopicId: string, tx: Executor = this.db): Promise<string | undefined> {
    const [row] = await tx
      .select({ name: subtopics.name })
      .from(subtopics)
      .where(and(eq(subtopics.tenantId, tenantId), eq(subtopics.id, subtopicId)))
      .limit(1);
    return row?.name;
  }
}

/** Ranks can drift a hair outside [0,1] through floating point; the engine expects a fraction. */
function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * `vector(N)` as SQL text, for the cast that migration 0007's partial HNSW indexes are built on.
 *
 * A type modifier cannot be a bind parameter in PostgreSQL — `vector($1)` is a syntax error — so
 * this is the one place in the codebase that has to compose SQL text rather than parameterise a
 * value. The dimension is therefore checked against the same range the migration's
 * `block_embeddings_dims_range` CHECK enforces, and anything else is refused rather than
 * interpolated: the string that reaches the query can only ever be an integer from 64 to 4000.
 */
function vectorTypeOf(dims: number): SQL {
  if (!Number.isInteger(dims) || dims < 64 || dims > 4000) {
    throw new Error(`refusing to build a vector cast for ${dims} dimensions: expected an integer between 64 and 4000`);
  }
  // eslint-disable-next-line no-restricted-syntax -- a type modifier cannot be parameterised; `dims` is a validated integer
  return sql.raw(`vector(${dims})`);
}
