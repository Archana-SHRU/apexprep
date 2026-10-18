import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import {
  chapters,
  contentAssets,
  contentBlocks,
  extractedPages,
  ingestionJobs,
  questions,
  reviewTasks,
  subjects,
  subtopics,
  topics,
  tracks,
  type ContentAssetRow,
  type ContentBlockRow,
  type ExtractedPageRow,
  type IngestionJobRow,
  type ReviewTaskKind,
  type ReviewTaskRow,
} from '../database/schema';
import type { TrackIdentity } from '../common/learning/track-identity';
import type { SyllabusCandidate } from './mapping';

/** What the pipeline supplies when it opens a review task; the tenant, job and status are fixed for it. */
export interface ReviewTaskDraft {
  kind: ReviewTaskKind;
  /** 1 is highest. 1 for a contradiction, 2 for something missing, 3 for low confidence, 4 for an audit sample. */
  priority: number;
  reason: string;
  contentBlockId?: string | null;
  questionId?: string | null;
  subtopicId?: string | null;
  duplicateOfQuestionId?: string | null;
  suggestion?: Record<string, unknown> | null;
}

/**
 * All ingestion data access, tenant-scoped.
 *
 * Every read is keyed on `tenant_id`, and the composite foreign keys mean a row can never point at
 * another organisation's row even if a service forgot to. Stage writes are written to be
 * **idempotent**: a retried job replaces what that stage produced rather than adding to it, which
 * is what makes the pipeline safe to re-run after a failure.
 */
@Injectable()
export class IngestionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // ---------------------------------------------------------------- assets

  async insertAsset(values: PgInsertValue<typeof contentAssets>, tx: Executor = this.db): Promise<ContentAssetRow> {
    const [row] = await tx.insert(contentAssets).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async findAsset(tenantId: string, id: string, tx: Executor = this.db): Promise<ContentAssetRow | undefined> {
    const [row] = await tx
      .select()
      .from(contentAssets)
      .where(and(eq(contentAssets.tenantId, tenantId), eq(contentAssets.id, id), isNull(contentAssets.deletedAt)))
      .limit(1);
    return row;
  }

  /** The duplicate check the requirements ask for, reading the same index that enforces it. */
  async findAssetBySha(tenantId: string, sha256: string, tx: Executor = this.db): Promise<ContentAssetRow | undefined> {
    const [row] = await tx
      .select()
      .from(contentAssets)
      .where(
        and(
          eq(contentAssets.tenantId, tenantId),
          eq(contentAssets.sha256, sha256),
          eq(contentAssets.kind, 'source_pdf'),
          isNull(contentAssets.deletedAt),
        ),
      )
      .limit(1);
    return row;
  }

  async updateAsset(tenantId: string, id: string, patch: PgUpdateSetSource<typeof contentAssets>, tx: Executor = this.db): Promise<void> {
    await tx
      .update(contentAssets)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(contentAssets.tenantId, tenantId), eq(contentAssets.id, id), isNull(contentAssets.deletedAt)));
  }

  // ---------------------------------------------------------------- jobs

  async insertJob(values: PgInsertValue<typeof ingestionJobs>, tx: Executor = this.db): Promise<IngestionJobRow> {
    const [row] = await tx.insert(ingestionJobs).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async findJob(tenantId: string, id: string, tx: Executor = this.db, lock = false): Promise<IngestionJobRow | undefined> {
    const query = tx
      .select()
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.tenantId, tenantId), eq(ingestionJobs.id, id)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  async listJobs(
    tenantId: string,
    filter: { status?: string; limit: number; before?: Date },
    tx: Executor = this.db,
  ): Promise<IngestionJobRow[]> {
    const where: (SQL | undefined)[] = [eq(ingestionJobs.tenantId, tenantId)];
    if (filter.status) where.push(eq(ingestionJobs.status, filter.status as IngestionJobRow['status']));
    if (filter.before) where.push(lt(ingestionJobs.createdAt, filter.before));
    return tx
      .select()
      .from(ingestionJobs)
      .where(and(...where))
      .orderBy(desc(ingestionJobs.createdAt), desc(ingestionJobs.id))
      .limit(filter.limit);
  }

  async updateJob(
    tenantId: string,
    id: string,
    patch: PgUpdateSetSource<typeof ingestionJobs>,
    tx: Executor = this.db,
  ): Promise<IngestionJobRow | undefined> {
    const [row] = await tx
      .update(ingestionJobs)
      .set(patch)
      .where(and(eq(ingestionJobs.tenantId, tenantId), eq(ingestionJobs.id, id)))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------- pages

  /** Replaces this job's pages. Idempotent: a re-run produces the same set, not a second one. */
  async replacePages(tenantId: string, jobId: string, values: PgInsertValue<typeof extractedPages>[], tx: Executor): Promise<void> {
    await tx.delete(extractedPages).where(and(eq(extractedPages.tenantId, tenantId), eq(extractedPages.jobId, jobId)));
    if (values.length > 0) await tx.insert(extractedPages).values(values);
  }

  async pagesOfJob(tenantId: string, jobId: string, tx: Executor = this.db): Promise<ExtractedPageRow[]> {
    return tx
      .select()
      .from(extractedPages)
      .where(and(eq(extractedPages.tenantId, tenantId), eq(extractedPages.jobId, jobId)))
      .orderBy(asc(extractedPages.pageNumber));
  }

  // ---------------------------------------------------------------- blocks

  /**
   * Replaces the blocks this job produced, keeping any a human has already touched.
   *
   * A reviewer's edit, reclassification, merge or split must survive a re-run of the pipeline —
   * losing it would be the worst kind of data loss here. So blocks that are still exactly as the
   * machine left them (`extracted` or `needs_review`, never reviewed, not merged or split) are
   * replaced, and everything else is left alone.
   */
  async replaceMachineBlocks(tenantId: string, jobId: string, values: PgInsertValue<typeof contentBlocks>[], tx: Executor): Promise<ContentBlockRow[]> {
    await tx
      .delete(contentBlocks)
      .where(
        and(
          eq(contentBlocks.tenantId, tenantId),
          eq(contentBlocks.jobId, jobId),
          inArray(contentBlocks.status, ['extracted', 'needs_review']),
          isNull(contentBlocks.reviewedBy),
          isNull(contentBlocks.mergedIntoId),
          isNull(contentBlocks.splitFromId),
        ),
      );

    // Whatever survived the delete is a person's work, and some of it is the same content this run
    // is about to write again. Re-inserting that would hand the reviewer a second copy of a block
    // they have already dealt with, which is not data loss but is still a re-run undoing review.
    // A block is recognised by its content hash, and `sourceContentHash` remembers the hash the
    // machine produced before a reviewer edited the text, so an edited block is matched too.
    const kept = await tx
      .select({ contentHash: contentBlocks.contentHash, contentJson: contentBlocks.contentJson })
      .from(contentBlocks)
      .where(and(eq(contentBlocks.tenantId, tenantId), eq(contentBlocks.jobId, jobId), isNull(contentBlocks.deletedAt)));
    const alreadyReviewed = new Set<string>();
    for (const row of kept) {
      alreadyReviewed.add(row.contentHash);
      const original = (row.contentJson as { sourceContentHash?: unknown } | null)?.sourceContentHash;
      if (typeof original === 'string') alreadyReviewed.add(original);
    }

    const fresh = values.filter((value) => {
      const hash = (value as { contentHash?: unknown }).contentHash;
      return typeof hash !== 'string' || !alreadyReviewed.has(hash);
    });
    if (fresh.length === 0) return [];
    return tx.insert(contentBlocks).values(fresh).returning();
  }

  async findBlock(tenantId: string, id: string, tx: Executor = this.db, lock = false): Promise<ContentBlockRow | undefined> {
    const query = tx
      .select()
      .from(contentBlocks)
      .where(and(eq(contentBlocks.tenantId, tenantId), eq(contentBlocks.id, id), isNull(contentBlocks.deletedAt)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  async blocksOfJob(tenantId: string, jobId: string, tx: Executor = this.db): Promise<ContentBlockRow[]> {
    return tx
      .select()
      .from(contentBlocks)
      .where(and(eq(contentBlocks.tenantId, tenantId), eq(contentBlocks.jobId, jobId), isNull(contentBlocks.deletedAt)))
      .orderBy(asc(contentBlocks.sourcePage), asc(contentBlocks.sortOrder));
  }

  /**
   * How long a publication claim is honoured before another caller may take the block over. Far longer than
   * publishing takes, so a live publication is never interrupted; short enough that one that died is not stuck.
   */
  static readonly PUBLICATION_CLAIM_MINUTES = 10;

  /**
   * Claims a block for publication, atomically — without touching what students see.
   *
   * The claim is a marker in `content_json.publishing`, written by a conditional UPDATE: it matches only a block
   * that is not published and has no live claim, so two concurrent publish calls cannot both win, and whichever
   * runs second matches no row. A plain read-then-write could not give that guarantee, and what it costs when it
   * fails is two published questions created from one block.
   *
   * The block's *status* is deliberately unchanged until `finishPublication`. Setting `published` first (as this
   * once did) made the block claim to be published while its question did not yet exist, and a crash in between
   * left a block that said "published" with nothing behind it. A claim whose caller died simply expires — and taking
   * it over keeps what the dead caller had recorded (the question it created), so that can be finished or removed.
   *
   * Returns the row when this caller won the claim, `undefined` when the block is published or being published.
   */
  async claimForPublication(tenantId: string, id: string, by: string, tx: Executor = this.db): Promise<ContentBlockRow | undefined> {
    const marker = JSON.stringify({ by, at: new Date().toISOString() });
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE content_blocks
         SET content_json = jsonb_set(coalesce(content_json, '{}'::jsonb), '{publishing}',
                                      (coalesce(content_json -> 'publishing', '{}'::jsonb) - 'by' - 'at') || ${marker}::jsonb)
       WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL AND status <> 'published'
         AND (content_json -> 'publishing' IS NULL
              OR (content_json -> 'publishing' ->> 'at')::timestamptz < now() - make_interval(mins => ${IngestionRepository.PUBLICATION_CLAIM_MINUTES}))
      RETURNING id`);
    if (rows.rows.length === 0) return undefined;
    return this.findBlock(tenantId, id, tx);
  }

  /** Notes what an in-flight publication has already created, so a retry after a crash can finish or clean up. */
  async notePublicationProgress(tenantId: string, id: string, progress: Record<string, unknown>, tx: Executor = this.db): Promise<void> {
    await tx.execute(sql`
      UPDATE content_blocks
         SET content_json = jsonb_set(coalesce(content_json, '{}'::jsonb), '{publishing}',
                                      coalesce(content_json -> 'publishing', '{}'::jsonb) || ${JSON.stringify(progress)}::jsonb)
       WHERE tenant_id = ${tenantId} AND id = ${id}`);
  }

  /**
   * Completes a publication: the block becomes `published` and the claim is cleared, in one statement. `extra` is
   * merged into `content_json` (the published question's id, for a question block).
   */
  async finishPublication(tenantId: string, id: string, extra: Record<string, unknown>, tx: Executor = this.db): Promise<ContentBlockRow | undefined> {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE content_blocks
         SET status = 'published', published_at = now(),
             content_json = (coalesce(content_json, '{}'::jsonb) - 'publishing') || ${JSON.stringify(extra)}::jsonb
       WHERE tenant_id = ${tenantId} AND id = ${id} AND deleted_at IS NULL
      RETURNING id`);
    if (rows.rows.length === 0) return undefined;
    return this.findBlock(tenantId, id, tx);
  }

  /** Drops a publication claim, leaving the block as it was: for a publication that failed cleanly. */
  async releaseClaim(tenantId: string, id: string, tx: Executor = this.db): Promise<void> {
    await tx.execute(sql`
      UPDATE content_blocks SET content_json = content_json - 'publishing'
       WHERE tenant_id = ${tenantId} AND id = ${id} AND content_json ? 'publishing'`);
  }

  async insertBlock(values: PgInsertValue<typeof contentBlocks>, tx: Executor = this.db): Promise<ContentBlockRow> {
    const [row] = await tx.insert(contentBlocks).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async updateBlock(
    tenantId: string,
    id: string,
    patch: PgUpdateSetSource<typeof contentBlocks>,
    tx: Executor = this.db,
  ): Promise<ContentBlockRow | undefined> {
    const [row] = await tx
      .update(contentBlocks)
      .set(patch)
      .where(and(eq(contentBlocks.tenantId, tenantId), eq(contentBlocks.id, id)))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------- syllabus candidates

  /**
   * Published sub-topics the pipeline may map to, with their ancestors' names.
   *
   * Published only, and existing only: this query is the reason the pipeline cannot invent
   * taxonomy — there is no code path from ingestion to a syllabus insert.
   */
  async syllabusCandidates(
    tenantId: string,
    hint: { trackId: string | null; subjectId: string | null },
    tx: Executor = this.db,
  ): Promise<SyllabusCandidate[]> {
    const rows = await tx
      .select({
        subtopicId: subtopics.id,
        subtopicName: subtopics.name,
        topicName: topics.name,
        chapterName: chapters.name,
        subjectName: subjects.name,
        subjectId: subjects.id,
        trackId: tracks.id,
        trackSlug: tracks.slug,
      })
      .from(subtopics)
      .innerJoin(topics, and(eq(topics.tenantId, subtopics.tenantId), eq(topics.id, subtopics.topicId)))
      .innerJoin(chapters, and(eq(chapters.tenantId, topics.tenantId), eq(chapters.id, topics.chapterId)))
      .innerJoin(subjects, and(eq(subjects.tenantId, chapters.tenantId), eq(subjects.id, chapters.subjectId)))
      .innerJoin(tracks, and(eq(tracks.tenantId, subjects.tenantId), eq(tracks.id, subjects.trackId)))
      .where(
        and(
          eq(subtopics.tenantId, tenantId),
          eq(subtopics.status, 'published'),
          isNull(subtopics.deletedAt),
          eq(topics.status, 'published'),
          isNull(topics.deletedAt),
          eq(chapters.status, 'published'),
          isNull(chapters.deletedAt),
          eq(subjects.status, 'published'),
          isNull(subjects.deletedAt),
          eq(tracks.status, 'published'),
          isNull(tracks.deletedAt),
        ),
      );

    return rows.map((r) => ({
      subtopicId: r.subtopicId,
      subtopicName: r.subtopicName,
      topicName: r.topicName,
      chapterName: r.chapterName,
      subjectName: r.subjectName,
      trackSlug: r.trackSlug,
      matchesUploadHint:
        (hint.trackId === null || hint.trackId === r.trackId) && (hint.subjectId === null || hint.subjectId === r.subjectId),
    }));
  }

  /**
   * The tracks a set of sub-topics sit under, for the mandatory-approval rule.
   *
   * Takes the whole set in one query, because the caller decides auto-approval for every block of a
   * job and the blocks of one job share a handful of sub-topics: one lookup per block was the same
   * five-table join executed dozens of times for the same answer.
   *
   * `kind` comes back alongside the slug because the Olympiad rule is `kind = 'olympiad'` since
   * migration 0013 — see src/common/learning/track-identity.ts.
   */
  async tracksOfSubtopics(
    tenantId: string,
    subtopicIds: readonly string[],
    tx: Executor = this.db,
  ): Promise<Map<string, TrackIdentity>> {
    const unique = [...new Set(subtopicIds)];
    if (unique.length === 0) return new Map();
    const rows = await tx
      .select({ subtopicId: subtopics.id, slug: tracks.slug, kind: tracks.kind })
      .from(subtopics)
      .innerJoin(topics, and(eq(topics.tenantId, subtopics.tenantId), eq(topics.id, subtopics.topicId)))
      .innerJoin(chapters, and(eq(chapters.tenantId, topics.tenantId), eq(chapters.id, topics.chapterId)))
      .innerJoin(subjects, and(eq(subjects.tenantId, chapters.tenantId), eq(subjects.id, chapters.subjectId)))
      .innerJoin(tracks, and(eq(tracks.tenantId, subjects.tenantId), eq(tracks.id, subjects.trackId)))
      .where(and(eq(subtopics.tenantId, tenantId), inArray(subtopics.id, unique)));
    return new Map(rows.map((r) => [r.subtopicId, { slug: r.slug, kind: r.kind ?? null }]));
  }

  /** The track one sub-topic sits under. */
  async trackOfSubtopic(tenantId: string, subtopicId: string, tx: Executor = this.db): Promise<TrackIdentity | undefined> {
    return (await this.tracksOfSubtopics(tenantId, [subtopicId], tx)).get(subtopicId);
  }

  // ---------------------------------------------------------------- near duplicates

  /**
   * Published or draft questions whose stem is a near-duplicate of this text.
   *
   * `pg_trgm`'s `similarity()` is the same trigram measure `near_duplicate.trigram_similarity`
   * was written for in Phase 4, so the threshold is the configured one and not a new invention.
   * The extension is installed by migration 0001, so this runs everywhere the app does — unlike
   * the vector half of retrieval, which needs pgvector.
   */
  async nearDuplicateQuestions(
    tenantId: string,
    stem: string,
    threshold: number,
    excludeQuestionId: string | null,
    tx: Executor = this.db,
  ): Promise<{ questionId: string; similarity: number; stem: string }[]> {
    const result = await tx.execute<{ id: string; similarity: number | string; stem: string }>(sql`
      SELECT q.id, similarity(q.stem, ${stem}) AS similarity, q.stem
        FROM ${questions} q
       WHERE q.tenant_id = ${tenantId}
         AND q.deleted_at IS NULL
         AND q.status IN ('draft', 'published')
         AND (${excludeQuestionId}::uuid IS NULL OR q.id <> ${excludeQuestionId}::uuid)
         AND similarity(q.stem, ${stem}) >= ${threshold}
       ORDER BY similarity DESC
       LIMIT 5
    `);
    return result.rows.map((r) => ({ questionId: r.id, similarity: Number(r.similarity), stem: r.stem }));
  }

  // ---------------------------------------------------------------- review tasks

  async insertReviewTask(values: PgInsertValue<typeof reviewTasks>, tx: Executor = this.db): Promise<ReviewTaskRow> {
    const [row] = await tx.insert(reviewTasks).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  /**
   * Opens a task the pipeline raised, as opposed to one a person or a student report created.
   *
   * The distinction matters twice over: `deleteOpenMachineTasks` recognises these by having no
   * assignee and no reporter, and the draft type is narrow enough that the compiler checks every
   * call site — a task with a misspelled field would otherwise insert a null and quietly lose the
   * reason a reviewer was called in.
   */
  async openMachineTask(tenantId: string, jobId: string, draft: ReviewTaskDraft, tx: Executor = this.db): Promise<ReviewTaskRow> {
    return this.insertReviewTask({ ...draft, tenantId, jobId, status: 'open' }, tx);
  }

  async findReviewTask(tenantId: string, id: string, tx: Executor = this.db, lock = false): Promise<ReviewTaskRow | undefined> {
    const query = tx
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.tenantId, tenantId), eq(reviewTasks.id, id)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  async updateReviewTask(
    tenantId: string,
    id: string,
    patch: PgUpdateSetSource<typeof reviewTasks>,
    tx: Executor = this.db,
  ): Promise<ReviewTaskRow | undefined> {
    const [row] = await tx
      .update(reviewTasks)
      .set(patch)
      .where(and(eq(reviewTasks.tenantId, tenantId), eq(reviewTasks.id, id)))
      .returning();
    return row;
  }

  /** Open tasks naming a block or a question: what the `open_review_tasks` gate counts. */
  async openTaskCount(
    tenantId: string,
    target: { blockId?: string; questionId?: string },
    tx: Executor = this.db,
  ): Promise<number> {
    const where: (SQL | undefined)[] = [
      eq(reviewTasks.tenantId, tenantId),
      inArray(reviewTasks.status, ['open', 'in_progress']),
    ];
    if (target.blockId) where.push(eq(reviewTasks.contentBlockId, target.blockId));
    if (target.questionId) where.push(eq(reviewTasks.questionId, target.questionId));
    const [row] = await tx.select({ n: count() }).from(reviewTasks).where(and(...where));
    return row?.n ?? 0;
  }

  /** The review tasks that name one block: what a reviewer's decision has to resolve. */
  async tasksOfBlock(tenantId: string, blockId: string, tx: Executor = this.db): Promise<ReviewTaskRow[]> {
    return tx
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.tenantId, tenantId), eq(reviewTasks.contentBlockId, blockId)))
      .orderBy(asc(reviewTasks.priority), asc(reviewTasks.createdAt));
  }

  /**
   * How many open tasks each of these jobs has, in one query.
   *
   * The job list shows this per row, and a count per job would be one query per row. Jobs with no
   * open task are simply absent from the map.
   */
  async openTaskCountsByJob(tenantId: string, jobIds: string[], tx: Executor = this.db): Promise<Map<string, number>> {
    if (jobIds.length === 0) return new Map();
    const rows = await tx
      .select({ jobId: reviewTasks.jobId, n: count() })
      .from(reviewTasks)
      .where(
        and(
          eq(reviewTasks.tenantId, tenantId),
          inArray(reviewTasks.jobId, jobIds),
          inArray(reviewTasks.status, ['open', 'in_progress']),
        ),
      )
      .groupBy(reviewTasks.jobId);
    return new Map(rows.filter((r): r is { jobId: string; n: number } => r.jobId !== null).map((r) => [r.jobId, r.n]));
  }

  async tasksOfJob(tenantId: string, jobId: string, tx: Executor = this.db): Promise<ReviewTaskRow[]> {
    return tx
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.tenantId, tenantId), eq(reviewTasks.jobId, jobId)))
      .orderBy(asc(reviewTasks.priority), asc(reviewTasks.createdAt));
  }

  /** Replaces the machine-opened tasks of a job, so a re-run does not pile up duplicates. */
  async deleteOpenMachineTasks(tenantId: string, jobId: string, tx: Executor): Promise<void> {
    await tx
      .delete(reviewTasks)
      .where(
        and(
          eq(reviewTasks.tenantId, tenantId),
          eq(reviewTasks.jobId, jobId),
          eq(reviewTasks.status, 'open'),
          isNull(reviewTasks.assignedTo),
          isNull(reviewTasks.reporterUserId),
        ),
      );
  }
}
