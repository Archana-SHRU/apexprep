import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import {
  chapters,
  contentBlocks,
  questions,
  subjects,
  subtopics,
  topics,
  tracks,
  type ChapterRow,
  type SubjectRow,
  type SubtopicRow,
  type TopicRow,
  type TrackRow,
} from '../database/schema';
import type { SyllabusLevel } from './dto/syllabus.dto';

/**
 * Visibility is decided here and nowhere else.
 *
 *  - `published` view (students): a node is visible when it and every ancestor is
 *    published and not deleted. Children are only ever loaded for visible parents, and
 *    ancestry lookups join the whole chain, so an unpublished ancestor hides a subtree.
 *  - `all` view (content admins): every node that is not soft-deleted, any status.
 *
 * Every query is scoped to the caller's tenant.
 */
export type Visibility = 'published' | 'all';

interface NodeTable {
  tenantId: AnyColumn;
  status: AnyColumn;
  deletedAt: AnyColumn;
}

function visible(t: NodeTable, tenantId: string, v: Visibility): SQL {
  const live = and(eq(t.tenantId, tenantId), isNull(t.deletedAt))!;
  return v === 'published' ? and(live, eq(t.status, 'published'))! : live;
}

export interface SubtreeRows {
  subjects: SubjectRow[];
  chapters: ChapterRow[];
  topics: TopicRow[];
  subtopics: SubtopicRow[];
  /** published questions per sub-topic (primary sub-topic only) */
  questionCounts: Map<string, number>;
  /** sub-topics with at least one published theory block */
  withTheory: Set<string>;
}

export interface Ancestry {
  track: TrackRow;
  subject?: SubjectRow;
  chapter?: ChapterRow;
  topic?: TopicRow;
  subtopic?: SubtopicRow;
}

@Injectable()
export class SyllabusRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Admin-chosen order first; then grade, so Class 2 precedes Class 10 even where no sort order was set
   * (by name alone "Class 10" sorts first). `grade_ordinal` is NULL outside school tracks, and Postgres
   * sorts NULLs last in ascending order, so every other track keeps ordering by name as before.
   */
  listTracks(tenantId: string, v: Visibility): Promise<TrackRow[]> {
    return this.db
      .select()
      .from(tracks)
      .where(visible(tracks, tenantId, v))
      .orderBy(asc(tracks.sortOrder), asc(tracks.gradeOrdinal), asc(tracks.name), asc(tracks.id));
  }

  async subjectsOfTracks(tenantId: string, trackIds: string[], v: Visibility): Promise<SubjectRow[]> {
    if (trackIds.length === 0) return [];
    return this.db
      .select()
      .from(subjects)
      .where(and(visible(subjects, tenantId, v), inArray(subjects.trackId, trackIds)))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name), asc(subjects.id));
  }

  /**
   * The node and its ancestors, or undefined when the node does not exist in this tenant
   * or is not visible (itself or through any ancestor).
   */
  async ancestry(level: SyllabusLevel, tenantId: string, id: string, v: Visibility): Promise<Ancestry | undefined> {
    switch (level) {
      case 'track': {
        const [row] = await this.db.select().from(tracks).where(and(visible(tracks, tenantId, v), eq(tracks.id, id))).limit(1);
        return row ? { track: row } : undefined;
      }
      case 'subject': {
        const [row] = await this.db
          .select({ track: tracks, subject: subjects })
          .from(subjects)
          .innerJoin(tracks, eq(tracks.id, subjects.trackId))
          .where(and(visible(subjects, tenantId, v), visible(tracks, tenantId, v), eq(subjects.id, id)))
          .limit(1);
        return row;
      }
      case 'chapter': {
        const [row] = await this.db
          .select({ track: tracks, subject: subjects, chapter: chapters })
          .from(chapters)
          .innerJoin(subjects, eq(subjects.id, chapters.subjectId))
          .innerJoin(tracks, eq(tracks.id, subjects.trackId))
          .where(and(visible(chapters, tenantId, v), visible(subjects, tenantId, v), visible(tracks, tenantId, v), eq(chapters.id, id)))
          .limit(1);
        return row;
      }
      case 'topic': {
        const [row] = await this.db
          .select({ track: tracks, subject: subjects, chapter: chapters, topic: topics })
          .from(topics)
          .innerJoin(chapters, eq(chapters.id, topics.chapterId))
          .innerJoin(subjects, eq(subjects.id, chapters.subjectId))
          .innerJoin(tracks, eq(tracks.id, subjects.trackId))
          .where(
            and(
              visible(topics, tenantId, v),
              visible(chapters, tenantId, v),
              visible(subjects, tenantId, v),
              visible(tracks, tenantId, v),
              eq(topics.id, id),
            ),
          )
          .limit(1);
        return row;
      }
      case 'subtopic': {
        const [row] = await this.db
          .select({ track: tracks, subject: subjects, chapter: chapters, topic: topics, subtopic: subtopics })
          .from(subtopics)
          .innerJoin(topics, eq(topics.id, subtopics.topicId))
          .innerJoin(chapters, eq(chapters.id, topics.chapterId))
          .innerJoin(subjects, eq(subjects.id, chapters.subjectId))
          .innerJoin(tracks, eq(tracks.id, subjects.trackId))
          .where(
            and(
              visible(subtopics, tenantId, v),
              visible(topics, tenantId, v),
              visible(chapters, tenantId, v),
              visible(subjects, tenantId, v),
              visible(tracks, tenantId, v),
              eq(subtopics.id, id),
            ),
          )
          .limit(1);
        return row;
      }
    }
  }

  /**
   * Everything below a node, level by level (one query per level plus two count queries).
   * `from` names the level of `rootIds`; its own rows are not loaded again.
   */
  async subtree(tenantId: string, from: SyllabusLevel, rootIds: string[], v: Visibility): Promise<SubtreeRows> {
    const out: SubtreeRows = { subjects: [], chapters: [], topics: [], subtopics: [], questionCounts: new Map(), withTheory: new Set() };
    let subjectIds: string[] = [];
    let chapterIds: string[] = [];
    let topicIds: string[] = [];
    let subtopicIds: string[] = [];

    if (from === 'track') {
      out.subjects = await this.subjectsOfTracks(tenantId, rootIds, v);
      subjectIds = out.subjects.map((s) => s.id);
    } else if (from === 'subject') subjectIds = rootIds;

    if (from === 'track' || from === 'subject') {
      out.chapters = subjectIds.length
        ? await this.db
            .select()
            .from(chapters)
            .where(and(visible(chapters, tenantId, v), inArray(chapters.subjectId, subjectIds)))
            .orderBy(asc(chapters.sortOrder), asc(chapters.name), asc(chapters.id))
        : [];
      chapterIds = out.chapters.map((c) => c.id);
    } else if (from === 'chapter') chapterIds = rootIds;

    if (from !== 'topic' && from !== 'subtopic') {
      out.topics = chapterIds.length
        ? await this.db
            .select()
            .from(topics)
            .where(and(visible(topics, tenantId, v), inArray(topics.chapterId, chapterIds)))
            .orderBy(asc(topics.sortOrder), asc(topics.name), asc(topics.id))
        : [];
      topicIds = out.topics.map((t) => t.id);
    } else if (from === 'topic') topicIds = rootIds;

    if (from !== 'subtopic') {
      out.subtopics = topicIds.length
        ? await this.db
            .select()
            .from(subtopics)
            .where(and(visible(subtopics, tenantId, v), inArray(subtopics.topicId, topicIds)))
            .orderBy(asc(subtopics.sortOrder), asc(subtopics.name), asc(subtopics.id))
        : [];
      subtopicIds = out.subtopics.map((s) => s.id);
    } else subtopicIds = rootIds;

    if (subtopicIds.length > 0) {
      const [qc, th] = await Promise.all([
        this.db
          .select({ subtopicId: questions.primarySubtopicId, n: count() })
          .from(questions)
          .where(
            and(
              eq(questions.tenantId, tenantId),
              inArray(questions.primarySubtopicId, subtopicIds),
              eq(questions.status, 'published'),
              isNull(questions.deletedAt),
            ),
          )
          .groupBy(questions.primarySubtopicId),
        this.db
          .selectDistinct({ subtopicId: contentBlocks.subtopicId })
          .from(contentBlocks)
          .where(
            and(
              eq(contentBlocks.tenantId, tenantId),
              inArray(contentBlocks.subtopicId, subtopicIds),
              eq(contentBlocks.kind, 'theory'),
              eq(contentBlocks.status, 'published'),
              isNull(contentBlocks.deletedAt),
            ),
          ),
      ]);
      for (const r of qc) out.questionCounts.set(r.subtopicId, r.n);
      for (const r of th) if (r.subtopicId) out.withTheory.add(r.subtopicId);
    }
    return out;
  }

  // ---------------------------------------------------------------- admin writes

  /** Locks a live parent row for the rest of the transaction (FOR SHARE) and reports whether it exists. */
  async lockLiveNode(level: SyllabusLevel, tenantId: string, id: string, tx: Executor, mode: 'share' | 'update'): Promise<boolean> {
    const lock = mode === 'share' ? sql`FOR SHARE` : sql`FOR UPDATE`;
    const table = { track: tracks, subject: subjects, chapter: chapters, topic: topics, subtopic: subtopics }[level];
    const res = await tx.execute(
      sql`SELECT 1 FROM ${table} WHERE ${table.tenantId} = ${tenantId} AND ${table.id} = ${id} AND ${table.deletedAt} IS NULL ${lock}`,
    );
    return res.rows.length > 0;
  }

  /** Live (non-deleted) things that stop a node from being deleted. */
  async liveDependents(level: SyllabusLevel, tenantId: string, id: string, tx: Executor): Promise<Record<string, number>> {
    const countWhere = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    switch (level) {
      case 'track':
        return { subjects: await countWhere(tx.select({ n: count() }).from(subjects).where(and(eq(subjects.tenantId, tenantId), eq(subjects.trackId, id), isNull(subjects.deletedAt)))) };
      case 'subject':
        return { chapters: await countWhere(tx.select({ n: count() }).from(chapters).where(and(eq(chapters.tenantId, tenantId), eq(chapters.subjectId, id), isNull(chapters.deletedAt)))) };
      case 'chapter':
        return { topics: await countWhere(tx.select({ n: count() }).from(topics).where(and(eq(topics.tenantId, tenantId), eq(topics.chapterId, id), isNull(topics.deletedAt)))) };
      case 'topic':
        return { subtopics: await countWhere(tx.select({ n: count() }).from(subtopics).where(and(eq(subtopics.tenantId, tenantId), eq(subtopics.topicId, id), isNull(subtopics.deletedAt)))) };
      case 'subtopic':
        return {
          questions: await countWhere(
            tx.select({ n: count() }).from(questions).where(and(eq(questions.tenantId, tenantId), eq(questions.primarySubtopicId, id), isNull(questions.deletedAt))),
          ),
          contentBlocks: await countWhere(
            tx.select({ n: count() }).from(contentBlocks).where(and(eq(contentBlocks.tenantId, tenantId), eq(contentBlocks.subtopicId, id), isNull(contentBlocks.deletedAt))),
          ),
        };
    }
  }
}
