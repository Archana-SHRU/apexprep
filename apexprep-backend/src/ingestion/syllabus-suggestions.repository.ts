import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import {
  chapters,
  contentBlocks,
  subjects,
  subtopics,
  syllabusSuggestionBlocks,
  syllabusSuggestions,
  topics,
  tracks,
  type SyllabusSuggestionRow,
} from '../database/schema';
import type { ExistingTree } from './hierarchy';

export interface SubjectContext {
  subjectId: string;
  subjectName: string;
  trackId: string;
  trackName: string;
}

/**
 * Data access for syllabus suggestions and for the one subject's tree they are matched against.
 * Tenant-scoped on every read and write; the composite foreign keys of migration 0016 make a
 * cross-tenant link impossible even if a caller forgot.
 */
@Injectable()
export class SyllabusSuggestionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** The subject and its track, when both exist (any status) and are not deleted. */
  async subjectContext(tenantId: string, subjectId: string, tx: Executor = this.db): Promise<SubjectContext | undefined> {
    const [row] = await tx
      .select({ subjectId: subjects.id, subjectName: subjects.name, trackId: tracks.id, trackName: tracks.name })
      .from(subjects)
      .innerJoin(tracks, and(eq(tracks.tenantId, subjects.tenantId), eq(tracks.id, subjects.trackId)))
      .where(and(eq(subjects.tenantId, tenantId), eq(subjects.id, subjectId), isNull(subjects.deletedAt), isNull(tracks.deletedAt)))
      .limit(1);
    return row;
  }

  /**
   * Chapters → topics → sub-topics of one subject: the only nodes a detected path is compared with.
   * Deleted nodes are left out; archived ones come back with their status so matching can skip them.
   */
  async subjectTree(tenantId: string, subjectId: string, tx: Executor = this.db): Promise<ExistingTree> {
    const chapterRows = await tx
      .select({ id: chapters.id, name: chapters.name, status: chapters.status })
      .from(chapters)
      .where(and(eq(chapters.tenantId, tenantId), eq(chapters.subjectId, subjectId), isNull(chapters.deletedAt)))
      .orderBy(asc(chapters.sortOrder), asc(chapters.name));
    if (chapterRows.length === 0) return { chapters: [] };
    const topicRows = await tx
      .select({ id: topics.id, chapterId: topics.chapterId, name: topics.name, status: topics.status })
      .from(topics)
      .where(and(eq(topics.tenantId, tenantId), inArray(topics.chapterId, chapterRows.map((c) => c.id)), isNull(topics.deletedAt)))
      .orderBy(asc(topics.sortOrder), asc(topics.name));
    const subtopicRows = topicRows.length
      ? await tx
          .select({ id: subtopics.id, topicId: subtopics.topicId, name: subtopics.name, status: subtopics.status })
          .from(subtopics)
          .where(and(eq(subtopics.tenantId, tenantId), inArray(subtopics.topicId, topicRows.map((t) => t.id)), isNull(subtopics.deletedAt)))
          .orderBy(asc(subtopics.sortOrder), asc(subtopics.name))
      : [];
    return {
      chapters: chapterRows.map((c) => ({
        ...c,
        topics: topicRows
          .filter((t) => t.chapterId === c.id)
          .map((t) => ({ id: t.id, name: t.name, status: t.status, subtopics: subtopicRows.filter((s) => s.topicId === t.id).map(({ id, name, status }) => ({ id, name, status })) })),
      })),
    };
  }

  /** The open suggestion for a path in a subject, from any upload. */
  async findPending(
    tenantId: string,
    subjectId: string,
    keys: { chapterKey: string; topicKey: string; subtopicKey: string },
    tx: Executor = this.db,
  ): Promise<SyllabusSuggestionRow | undefined> {
    const [row] = await tx
      .select()
      .from(syllabusSuggestions)
      .where(
        and(
          eq(syllabusSuggestions.tenantId, tenantId),
          eq(syllabusSuggestions.subjectId, subjectId),
          eq(syllabusSuggestions.chapterKey, keys.chapterKey),
          eq(syllabusSuggestions.topicKey, keys.topicKey),
          eq(syllabusSuggestions.subtopicKey, keys.subtopicKey),
          eq(syllabusSuggestions.status, 'pending'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * A rejected suggestion for this path in this subject, if there is one. A person has said this path
   * is not part of the syllabus, so neither a re-run nor another upload proposes it again; the content
   * stays unmapped for a person to file by hand (or the node can be authored on the Syllabus page).
   */
  async findRejected(
    tenantId: string,
    subjectId: string,
    keys: { chapterKey: string; topicKey: string; subtopicKey: string },
    tx: Executor = this.db,
  ): Promise<SyllabusSuggestionRow | undefined> {
    const [row] = await tx
      .select()
      .from(syllabusSuggestions)
      .where(
        and(
          eq(syllabusSuggestions.tenantId, tenantId),
          eq(syllabusSuggestions.subjectId, subjectId),
          eq(syllabusSuggestions.chapterKey, keys.chapterKey),
          eq(syllabusSuggestions.topicKey, keys.topicKey),
          eq(syllabusSuggestions.subtopicKey, keys.subtopicKey),
          eq(syllabusSuggestions.status, 'rejected'),
        ),
      )
      .limit(1);
    return row;
  }

  async insert(values: PgInsertValue<typeof syllabusSuggestions>, tx: Executor = this.db): Promise<SyllabusSuggestionRow> {
    const [row] = await tx.insert(syllabusSuggestions).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async update(tenantId: string, id: string, patch: PgUpdateSetSource<typeof syllabusSuggestions>, tx: Executor = this.db): Promise<SyllabusSuggestionRow> {
    const [row] = await tx
      .update(syllabusSuggestions)
      .set(patch)
      .where(and(eq(syllabusSuggestions.tenantId, tenantId), eq(syllabusSuggestions.id, id)))
      .returning();
    if (!row) throw new Error('update matched no row');
    return row;
  }

  async find(tenantId: string, id: string, tx: Executor = this.db, lock = false): Promise<SyllabusSuggestionRow | undefined> {
    const query = tx.select().from(syllabusSuggestions).where(and(eq(syllabusSuggestions.tenantId, tenantId), eq(syllabusSuggestions.id, id))).limit(1);
    const [row] = lock ? await query.for('update') : await query;
    return row;
  }

  /** Links blocks to a suggestion; a block already linked (to any suggestion) keeps its link. */
  async link(tenantId: string, suggestionId: string, blockIds: readonly string[], tx: Executor = this.db): Promise<void> {
    if (blockIds.length === 0) return;
    await tx
      .insert(syllabusSuggestionBlocks)
      .values(blockIds.map((contentBlockId) => ({ tenantId, suggestionId, contentBlockId })))
      .onConflictDoNothing();
  }

  /**
   * Writes the suggestion id into each linked block's `content_json.mapping.hierarchy`, so a block read
   * on its own (by any review action) still says which suggestion it waits on.
   */
  async stamp(tenantId: string, suggestionId: string | null, blockIds: readonly string[], tx: Executor = this.db, extra: Record<string, unknown> = {}): Promise<void> {
    if (blockIds.length === 0) return;
    const patch = JSON.stringify({ suggestionId, ...extra });
    await tx
      .update(contentBlocks)
      .set({
        contentJson: sql`jsonb_set(coalesce(${contentBlocks.contentJson}, '{}'::jsonb), '{mapping,hierarchy}',
          coalesce(${contentBlocks.contentJson} #> '{mapping,hierarchy}', '{}'::jsonb) || ${patch}::jsonb, true)`,
      })
      .where(and(eq(contentBlocks.tenantId, tenantId), inArray(contentBlocks.id, [...blockIds]), sql`${contentBlocks.contentJson} ? 'mapping'`));
  }

  /** Every suggestion this job proposed or has blocks linked to, oldest first. */
  async ofJob(tenantId: string, jobId: string, tx: Executor = this.db): Promise<SyllabusSuggestionRow[]> {
    const linked = tx
      .select({ id: syllabusSuggestionBlocks.suggestionId })
      .from(syllabusSuggestionBlocks)
      .innerJoin(contentBlocks, and(eq(contentBlocks.tenantId, syllabusSuggestionBlocks.tenantId), eq(contentBlocks.id, syllabusSuggestionBlocks.contentBlockId)))
      .where(and(eq(syllabusSuggestionBlocks.tenantId, tenantId), eq(contentBlocks.jobId, jobId)));
    return tx
      .select()
      .from(syllabusSuggestions)
      .where(and(eq(syllabusSuggestions.tenantId, tenantId), or(eq(syllabusSuggestions.jobId, jobId), inArray(syllabusSuggestions.id, linked))))
      .orderBy(asc(syllabusSuggestions.createdAt), asc(syllabusSuggestions.id));
  }

  /** Suggestion id per block, for the blocks of one job. */
  async linksOfJob(tenantId: string, jobId: string, tx: Executor = this.db): Promise<Map<string, string>> {
    const rows = await tx
      .select({ blockId: syllabusSuggestionBlocks.contentBlockId, suggestionId: syllabusSuggestionBlocks.suggestionId })
      .from(syllabusSuggestionBlocks)
      .innerJoin(contentBlocks, and(eq(contentBlocks.tenantId, syllabusSuggestionBlocks.tenantId), eq(contentBlocks.id, syllabusSuggestionBlocks.contentBlockId)))
      .where(and(eq(syllabusSuggestionBlocks.tenantId, tenantId), eq(contentBlocks.jobId, jobId)));
    return new Map(rows.map((r) => [r.blockId, r.suggestionId]));
  }

  /** The blocks linked to a suggestion, optionally only those of one job. */
  async blocksOf(tenantId: string, suggestionId: string, jobId: string | null, tx: Executor = this.db): Promise<{ id: string; jobId: string | null; status: string; subtopicId: string | null }[]> {
    return tx
      .select({ id: contentBlocks.id, jobId: contentBlocks.jobId, status: contentBlocks.status, subtopicId: contentBlocks.subtopicId })
      .from(syllabusSuggestionBlocks)
      .innerJoin(contentBlocks, and(eq(contentBlocks.tenantId, syllabusSuggestionBlocks.tenantId), eq(contentBlocks.id, syllabusSuggestionBlocks.contentBlockId)))
      .where(
        and(
          eq(syllabusSuggestionBlocks.tenantId, tenantId),
          eq(syllabusSuggestionBlocks.suggestionId, suggestionId),
          isNull(contentBlocks.deletedAt),
          ...(jobId ? [eq(contentBlocks.jobId, jobId)] : []),
        ),
      );
  }

  /** Pending suggestions this job opened that no block points at any more (a re-run moved them). */
  async deleteOrphanedPending(tenantId: string, jobId: string, tx: Executor): Promise<void> {
    const linked = tx.select({ id: syllabusSuggestionBlocks.suggestionId }).from(syllabusSuggestionBlocks).where(eq(syllabusSuggestionBlocks.tenantId, tenantId));
    await tx
      .delete(syllabusSuggestions)
      .where(
        and(
          eq(syllabusSuggestions.tenantId, tenantId),
          eq(syllabusSuggestions.jobId, jobId),
          eq(syllabusSuggestions.status, 'pending'),
          sql`${syllabusSuggestions.id} NOT IN (${linked})`,
        ),
      );
  }

  /** Next sort position among a parent's children, so a created node lands after the existing ones. */
  async nextSortOrder(level: 'chapter' | 'topic' | 'subtopic', tenantId: string, parentId: string, tx: Executor): Promise<number> {
    const table = level === 'chapter' ? chapters : level === 'topic' ? topics : subtopics;
    const parent = level === 'chapter' ? chapters.subjectId : level === 'topic' ? topics.chapterId : subtopics.topicId;
    const [row] = await tx
      .select({ max: sql<number | null>`max(${table.sortOrder})` })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(parent, parentId), isNull(table.deletedAt)));
    return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
  }

  /** Slugs already taken under a parent (deleted rows free theirs, per the partial unique indexes). */
  async takenSlugs(level: 'chapter' | 'topic' | 'subtopic', tenantId: string, parentId: string, tx: Executor): Promise<Set<string>> {
    const table = level === 'chapter' ? chapters : level === 'topic' ? topics : subtopics;
    const parent = level === 'chapter' ? chapters.subjectId : level === 'topic' ? topics.chapterId : subtopics.topicId;
    // The unique index is (parent, slug), so the parent alone scopes it; the tenant check is belt and braces.
    const rows = await tx.select({ slug: table.slug }).from(table).where(and(eq(table.tenantId, tenantId), eq(parent, parentId), isNull(table.deletedAt)));
    return new Set(rows.map((r) => r.slug));
  }
}
