import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import {
  attempts,
  contentAssets,
  contentBlocks,
  generatedQuestions,
  revisionNotes,
  tutorConversations,
  tutorMessages,
  visualExplanations,
  type ContentAssetRow,
  type GeneratedQuestionRow,
  type NoteScopeLevel,
  type RevisionNotesRow,
  type TutorConversationRow,
  type TutorIntent,
  type TutorMessageRow,
  type VisualExplanationRow,
} from '../database/schema';
import type { AudienceTrack } from './audience';
import type { SourceBlock } from './source';

/** A published syllabus node with the names above it and the track's learning context. */
export interface ScopeContext {
  level: NoteScopeLevel;
  id: string;
  name: string;
  /** "Track › Subject › Chapter › …", for prompts and headings. */
  path: string;
  track: AudienceTrack & { id: string; slug: string };
}

/** A published sub-topic with everything retrieval and prompts need to know about where it sits. */
export interface SubtopicContext {
  subtopicId: string;
  subtopicName: string;
  topicId: string;
  topicName: string;
  chapterId: string;
  chapterName: string;
  subjectName: string;
  track: AudienceTrack & { id: string; slug: string };
}

type Row = Record<string, string | number | null>;

/** One side of a tutor exchange; tenant, conversation and role are supplied by `appendExchange`. */
export interface TurnValues {
  intent: TutorIntent;
  body: string;
  payload: Record<string, unknown>;
}

/**
 * The published-path join every student-facing read uses: a node is visible only when it and every
 * ancestor is published and not deleted — the same rule as `SyllabusRepository`'s `published` view.
 */
const PUBLISHED_PATH = sql`
  FROM subtopics st
  JOIN topics   tp ON tp.tenant_id = st.tenant_id AND tp.id = st.topic_id    AND tp.status = 'published' AND tp.deleted_at IS NULL
  JOIN chapters ch ON ch.tenant_id = st.tenant_id AND ch.id = tp.chapter_id  AND ch.status = 'published' AND ch.deleted_at IS NULL
  JOIN subjects sb ON sb.tenant_id = st.tenant_id AND sb.id = ch.subject_id  AND sb.status = 'published' AND sb.deleted_at IS NULL
  JOIN tracks   tr ON tr.tenant_id = st.tenant_id AND tr.id = sb.track_id    AND tr.status = 'published' AND tr.deleted_at IS NULL
`;

function trackOf(r: Row): ScopeContext['track'] {
  return {
    id: String(r.track_id),
    slug: String(r.track_slug),
    name: String(r.track_name),
    kind: r.track_kind === null ? null : String(r.track_kind),
    gradeLabel: r.grade_label === null ? null : String(r.grade_label),
    gradeOrdinal: r.grade_ordinal === null ? null : Number(r.grade_ordinal),
    examFamily: r.exam_family === null ? null : String(r.exam_family),
  };
}

const TRACK_COLUMNS = sql`tr.id AS track_id, tr.slug AS track_slug, tr.name AS track_name, tr.kind AS track_kind,
  tr.grade_label, tr.grade_ordinal, tr.exam_family`;

function scopeFilter(level: NoteScopeLevel, id: string) {
  switch (level) {
    case 'subtopic':
      return sql`st.id = ${id}`;
    case 'topic':
      return sql`tp.id = ${id}`;
    case 'chapter':
      return sql`ch.id = ${id}`;
    case 'subject':
      return sql`sb.id = ${id}`;
    case 'track':
      return sql`tr.id = ${id}`;
  }
}

@Injectable()
export class LearningAiRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // ---------------------------------------------------------------- syllabus context

  /**
   * A published node at any level, with its path and track. The track and subject levels are read
   * directly because a published track or subject may have no sub-topics yet.
   */
  async scopeContext(tenantId: string, level: NoteScopeLevel, id: string): Promise<ScopeContext | undefined> {
    const query =
      level === 'track'
        ? sql`SELECT tr.name AS name, tr.name AS path, ${TRACK_COLUMNS}
                FROM tracks tr
               WHERE tr.tenant_id = ${tenantId} AND tr.id = ${id} AND tr.status = 'published' AND tr.deleted_at IS NULL`
        : level === 'subject'
          ? sql`SELECT sb.name AS name, tr.name || ' › ' || sb.name AS path, ${TRACK_COLUMNS}
                  FROM subjects sb
                  JOIN tracks tr ON tr.tenant_id = sb.tenant_id AND tr.id = sb.track_id AND tr.status = 'published' AND tr.deleted_at IS NULL
                 WHERE sb.tenant_id = ${tenantId} AND sb.id = ${id} AND sb.status = 'published' AND sb.deleted_at IS NULL`
          : level === 'chapter'
            ? sql`SELECT ch.name AS name, tr.name || ' › ' || sb.name || ' › ' || ch.name AS path, ${TRACK_COLUMNS}
                    FROM chapters ch
                    JOIN subjects sb ON sb.tenant_id = ch.tenant_id AND sb.id = ch.subject_id AND sb.status = 'published' AND sb.deleted_at IS NULL
                    JOIN tracks tr ON tr.tenant_id = ch.tenant_id AND tr.id = sb.track_id AND tr.status = 'published' AND tr.deleted_at IS NULL
                   WHERE ch.tenant_id = ${tenantId} AND ch.id = ${id} AND ch.status = 'published' AND ch.deleted_at IS NULL`
            : level === 'topic'
              ? sql`SELECT tp.name AS name, tr.name || ' › ' || sb.name || ' › ' || ch.name || ' › ' || tp.name AS path, ${TRACK_COLUMNS}
                      FROM topics tp
                      JOIN chapters ch ON ch.tenant_id = tp.tenant_id AND ch.id = tp.chapter_id AND ch.status = 'published' AND ch.deleted_at IS NULL
                      JOIN subjects sb ON sb.tenant_id = tp.tenant_id AND sb.id = ch.subject_id AND sb.status = 'published' AND sb.deleted_at IS NULL
                      JOIN tracks tr ON tr.tenant_id = tp.tenant_id AND tr.id = sb.track_id AND tr.status = 'published' AND tr.deleted_at IS NULL
                     WHERE tp.tenant_id = ${tenantId} AND tp.id = ${id} AND tp.status = 'published' AND tp.deleted_at IS NULL`
              : sql`SELECT st.name AS name, tr.name || ' › ' || sb.name || ' › ' || ch.name || ' › ' || tp.name || ' › ' || st.name AS path, ${TRACK_COLUMNS}
                      ${PUBLISHED_PATH}
                     WHERE st.tenant_id = ${tenantId} AND st.id = ${id} AND st.status = 'published' AND st.deleted_at IS NULL`;
    const result = await this.db.execute<Row>(query);
    const r = result.rows[0];
    if (!r) return undefined;
    return { level, id, name: String(r.name), path: String(r.path), track: trackOf(r) };
  }

  async subtopicContext(tenantId: string, subtopicId: string): Promise<SubtopicContext | undefined> {
    const result = await this.db.execute<Row>(sql`
      SELECT st.id AS subtopic_id, st.name AS subtopic_name, tp.id AS topic_id, tp.name AS topic_name,
             ch.id AS chapter_id, ch.name AS chapter_name, sb.name AS subject_name, ${TRACK_COLUMNS}
        ${PUBLISHED_PATH}
       WHERE st.tenant_id = ${tenantId} AND st.id = ${subtopicId} AND st.status = 'published' AND st.deleted_at IS NULL
    `);
    const r = result.rows[0];
    if (!r) return undefined;
    return {
      subtopicId: String(r.subtopic_id),
      subtopicName: String(r.subtopic_name),
      topicId: String(r.topic_id),
      topicName: String(r.topic_name),
      chapterId: String(r.chapter_id),
      chapterName: String(r.chapter_name),
      subjectName: String(r.subject_name),
      track: trackOf(r),
    };
  }

  /**
   * Published theory anywhere under a node, in reading order. `limit` bounds the read; the caller
   * compares the count with it to know whether the scope was larger than it may process.
   */
  async theoryInScope(tenantId: string, level: NoteScopeLevel, id: string, limit: number, tx: Executor = this.db): Promise<SourceBlock[]> {
    const result = await tx.execute<Row>(sql`
      SELECT cb.id, cb.title, coalesce(cb.normalized_text, cb.raw_text) AS text, cb.content_hash,
             row_number() OVER (ORDER BY sb.sort_order, sb.id, ch.sort_order, ch.id, tp.sort_order, tp.id,
                                         st.sort_order, st.id, cb.sort_order, cb.id) AS reading_order
        FROM ${contentBlocks} cb
        JOIN subtopics st ON st.tenant_id = cb.tenant_id AND st.id = cb.subtopic_id
        JOIN topics  tp ON tp.tenant_id = st.tenant_id AND tp.id = st.topic_id    AND tp.status = 'published' AND tp.deleted_at IS NULL
        JOIN chapters ch ON ch.tenant_id = st.tenant_id AND ch.id = tp.chapter_id  AND ch.status = 'published' AND ch.deleted_at IS NULL
        JOIN subjects sb ON sb.tenant_id = st.tenant_id AND sb.id = ch.subject_id  AND sb.status = 'published' AND sb.deleted_at IS NULL
        JOIN tracks   tr ON tr.tenant_id = st.tenant_id AND tr.id = sb.track_id    AND tr.status = 'published' AND tr.deleted_at IS NULL
       WHERE cb.tenant_id = ${tenantId}
         AND cb.kind = 'theory' AND cb.status = 'published' AND cb.deleted_at IS NULL
         AND st.status = 'published' AND st.deleted_at IS NULL
         AND ${scopeFilter(level, id)}
       ORDER BY reading_order
       LIMIT ${limit}
    `);
    return result.rows.map((r) => ({
      blockId: String(r.id),
      title: r.title === null ? null : String(r.title),
      text: String(r.text),
      contentHash: String(r.content_hash),
      sortOrder: Number(r.reading_order),
    }));
  }

  /** Content hashes of specific blocks, for hashing a retrieval result into a cache key. */
  async blockHashes(tenantId: string, blockIds: readonly string[]): Promise<{ blockId: string; contentHash: string }[]> {
    if (blockIds.length === 0) return [];
    const result = await this.db.execute<{ id: string; content_hash: string }>(sql`
      SELECT id, content_hash FROM ${contentBlocks}
       WHERE tenant_id = ${tenantId} AND id = ANY(${sql.param([...blockIds])}::uuid[])
    `);
    return result.rows.map((r) => ({ blockId: r.id, contentHash: r.content_hash }));
  }

  // ---------------------------------------------------------------- revision notes

  async activeNotes(tenantId: string, level: NoteScopeLevel, scopeId: string): Promise<RevisionNotesRow | undefined> {
    const [row] = await this.db
      .select()
      .from(revisionNotes)
      .where(and(eq(revisionNotes.tenantId, tenantId), eq(revisionNotes.scopeLevel, level), eq(revisionNotes.scopeId, scopeId), eq(revisionNotes.status, 'active')))
      .limit(1);
    return row;
  }

  /** The newest rejected attempt for exactly these inputs, so a failing scope is not regenerated on every click. */
  async recentRejectedNotes(tenantId: string, level: NoteScopeLevel, scopeId: string, hash: string, promptVersion: string, since: Date): Promise<RevisionNotesRow | undefined> {
    const [row] = await this.db
      .select()
      .from(revisionNotes)
      .where(
        and(
          eq(revisionNotes.tenantId, tenantId),
          eq(revisionNotes.scopeLevel, level),
          eq(revisionNotes.scopeId, scopeId),
          eq(revisionNotes.status, 'rejected'),
          eq(revisionNotes.sourceHash, hash),
          eq(revisionNotes.promptVersion, promptVersion),
          gte(revisionNotes.generatedAt, since),
        ),
      )
      .orderBy(desc(revisionNotes.generatedAt))
      .limit(1);
    return row;
  }

  async insertNotes(values: PgInsertValue<typeof revisionNotes>, tx: Executor = this.db): Promise<RevisionNotesRow> {
    const [row] = await tx.insert(revisionNotes).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async supersedeNotes(tenantId: string, id: string, tx: Executor = this.db): Promise<void> {
    await tx.update(revisionNotes).set({ status: 'superseded' }).where(and(eq(revisionNotes.tenantId, tenantId), eq(revisionNotes.id, id), eq(revisionNotes.status, 'active')));
  }

  // ---------------------------------------------------------------- generated questions

  /** Stems of every live question in a sub-topic, for duplicate detection. */
  async subtopicStems(tenantId: string, subtopicId: string, limit = 1000): Promise<string[]> {
    const result = await this.db.execute<{ stem: string }>(sql`
      SELECT stem FROM questions
       WHERE tenant_id = ${tenantId} AND primary_subtopic_id = ${subtopicId} AND deleted_at IS NULL
         AND status IN ('draft', 'in_review', 'published')
       ORDER BY created_at DESC
       LIMIT ${limit}
    `);
    return result.rows.map((r) => r.stem);
  }

  async countGeneratedSince(tenantId: string, userId: string, since: Date): Promise<number> {
    const result = await this.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM ${generatedQuestions}
       WHERE tenant_id = ${tenantId} AND requested_by = ${userId} AND created_at >= ${since.toISOString()}::timestamptz
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  async countGeneratedForSubtopic(tenantId: string, subtopicId: string): Promise<number> {
    const result = await this.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM ${generatedQuestions} WHERE tenant_id = ${tenantId} AND subtopic_id = ${subtopicId}
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  async insertGenerated(values: PgInsertValue<typeof generatedQuestions>, tx: Executor = this.db): Promise<GeneratedQuestionRow> {
    const [row] = await tx.insert(generatedQuestions).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async generatedForAdmin(tenantId: string, subtopicId: string | null, limit: number): Promise<GeneratedQuestionRow[]> {
    return this.db
      .select()
      .from(generatedQuestions)
      .where(subtopicId ? and(eq(generatedQuestions.tenantId, tenantId), eq(generatedQuestions.subtopicId, subtopicId)) : eq(generatedQuestions.tenantId, tenantId))
      .orderBy(desc(generatedQuestions.createdAt))
      .limit(limit);
  }

  // ---------------------------------------------------------------- attempts

  /** The student's most recent attempt on a question, with what they answered and the verdict. */
  async latestAttempt(tenantId: string, userId: string, questionId: string): Promise<{ response: Record<string, unknown>; outcome: string } | undefined> {
    const [row] = await this.db
      .select({ response: attempts.response, outcome: attempts.outcome })
      .from(attempts)
      .where(and(eq(attempts.tenantId, tenantId), eq(attempts.userId, userId), eq(attempts.questionId, questionId)))
      .orderBy(desc(attempts.createdAt), desc(attempts.id))
      .limit(1);
    return row ? { response: row.response, outcome: row.outcome } : undefined;
  }

  // ---------------------------------------------------------------- tutor

  async insertConversation(values: PgInsertValue<typeof tutorConversations>): Promise<TutorConversationRow> {
    const [row] = await this.db.insert(tutorConversations).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async findConversation(tenantId: string, userId: string, id: string): Promise<TutorConversationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tutorConversations)
      .where(and(eq(tutorConversations.tenantId, tenantId), eq(tutorConversations.userId, userId), eq(tutorConversations.id, id)))
      .limit(1);
    return row;
  }

  /** An open conversation about exactly this context, active since `since`, to continue rather than restart. */
  async reusableConversation(
    tenantId: string,
    userId: string,
    subtopicId: string,
    question: { id: string; version: number } | null,
    since: Date,
  ): Promise<TutorConversationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tutorConversations)
      .where(
        and(
          eq(tutorConversations.tenantId, tenantId),
          eq(tutorConversations.userId, userId),
          eq(tutorConversations.subtopicId, subtopicId),
          question ? eq(tutorConversations.questionId, question.id) : sql`${tutorConversations.questionId} IS NULL`,
          question ? eq(tutorConversations.questionVersion, question.version) : sql`true`,
          eq(tutorConversations.status, 'open'),
          gte(tutorConversations.lastMessageAt, since),
        ),
      )
      .orderBy(desc(tutorConversations.lastMessageAt))
      .limit(1);
    return row;
  }

  async messages(tenantId: string, conversationId: string): Promise<TutorMessageRow[]> {
    return this.db
      .select()
      .from(tutorMessages)
      .where(and(eq(tutorMessages.tenantId, tenantId), eq(tutorMessages.conversationId, conversationId)))
      .orderBy(asc(tutorMessages.createdAt), asc(tutorMessages.id));
  }

  /** Both turns of an exchange in one transaction, so a conversation never holds a question without its reply. */
  async appendExchange(
    tenantId: string,
    conversationId: string,
    student: TurnValues,
    tutor: TurnValues,
  ): Promise<{ student: TutorMessageRow; tutor: TutorMessageRow }> {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.insert(tutorMessages).values({ ...student, tenantId, conversationId, role: 'student' }).returning();
      // A distinct timestamp keeps the reading order stable even inside one transaction.
      const [t] = await tx
        .insert(tutorMessages)
        .values({ ...tutor, tenantId, conversationId, role: 'tutor', createdAt: sql`clock_timestamp()` })
        .returning();
      await tx
        .update(tutorConversations)
        .set({ lastMessageAt: sql`now()` })
        .where(and(eq(tutorConversations.tenantId, tenantId), eq(tutorConversations.id, conversationId)));
      if (!s || !t) throw new Error('insert returned no row');
      return { student: s, tutor: t };
    });
  }

  // ---------------------------------------------------------------- visuals

  async activeVisual(tenantId: string, questionId: string, questionVersion: number): Promise<VisualExplanationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(visualExplanations)
      .where(
        and(
          eq(visualExplanations.tenantId, tenantId),
          eq(visualExplanations.questionId, questionId),
          eq(visualExplanations.questionVersion, questionVersion),
          eq(visualExplanations.status, 'active'),
        ),
      )
      .limit(1);
    return row;
  }

  async recentRejectedVisual(tenantId: string, questionId: string, questionVersion: number, hash: string, promptVersion: string, since: Date): Promise<VisualExplanationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(visualExplanations)
      .where(
        and(
          eq(visualExplanations.tenantId, tenantId),
          eq(visualExplanations.questionId, questionId),
          eq(visualExplanations.questionVersion, questionVersion),
          eq(visualExplanations.status, 'rejected'),
          eq(visualExplanations.sourceHash, hash),
          eq(visualExplanations.promptVersion, promptVersion),
          gte(visualExplanations.generatedAt, since),
        ),
      )
      .orderBy(desc(visualExplanations.generatedAt))
      .limit(1);
    return row;
  }

  async findVisual(tenantId: string, id: string): Promise<VisualExplanationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(visualExplanations)
      .where(and(eq(visualExplanations.tenantId, tenantId), eq(visualExplanations.id, id)))
      .limit(1);
    return row;
  }

  async insertVisual(values: PgInsertValue<typeof visualExplanations>, tx: Executor = this.db): Promise<VisualExplanationRow> {
    const [row] = await tx.insert(visualExplanations).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async supersedeVisual(tenantId: string, id: string, tx: Executor = this.db): Promise<void> {
    await tx
      .update(visualExplanations)
      .set({ status: 'superseded' })
      .where(and(eq(visualExplanations.tenantId, tenantId), eq(visualExplanations.id, id), eq(visualExplanations.status, 'active')));
  }

  async insertAsset(values: PgInsertValue<typeof contentAssets>, tx: Executor = this.db): Promise<ContentAssetRow> {
    const [row] = await tx.insert(contentAssets).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async findAsset(tenantId: string, id: string): Promise<ContentAssetRow | undefined> {
    const [row] = await this.db
      .select()
      .from(contentAssets)
      .where(and(eq(contentAssets.tenantId, tenantId), eq(contentAssets.id, id), sql`${contentAssets.deletedAt} IS NULL`))
      .limit(1);
    return row;
  }
}
