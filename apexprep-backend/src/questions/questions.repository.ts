import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { afterCursor, cursorTimestamp, type CursorPosition } from '../common/pagination/cursor';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import {
  officialSolutions,
  questionOptions,
  questionSecondarySubtopics,
  questions,
  type OfficialSolutionRow,
  type QuestionOptionRow,
  type QuestionRow,
  type QuestionStatus,
  type QuestionType,
} from '../database/schema';
import {
  HINT_COUNT,
  STUDENT_OPTION_COLUMNS,
  STUDENT_QUESTION_COLUMNS,
  type StudentOptionRow,
  type StudentQuestionRow,
} from './student-question.view';
import type { ShapedOption } from './question-shape';

export interface QuestionFilters {
  trackId?: string;
  subjectId?: string;
  subtopicId?: string;
  status?: QuestionStatus;
  type?: QuestionType;
  difficultyLabel?: number;
  search?: string;
}

export interface QuestionListRow {
  id: string;
  subtopicId: string;
  trackName?: string | null;
  subjectName?: string | null;
  type: QuestionType;
  status: QuestionStatus;
  version: number;
  stem: string;
  difficultyLabel: number;
  difficultyB: number;
  expectedTimeSeconds: number;
  hasOfficialSolution: boolean;
  createdAt: Date;
  updatedAt: Date;
  cursorTs: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Every method is tenant-scoped; ids from another tenant simply return nothing. */
@Injectable()
export class QuestionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findById(tenantId: string, id: string, tx: Executor = this.db, lock = false): Promise<QuestionRow | undefined> {
    const q = tx
      .select()
      .from(questions)
      .where(and(eq(questions.tenantId, tenantId), eq(questions.id, id), isNull(questions.deletedAt)))
      .limit(1);
    const [row] = await (lock ? q.for('update') : q);
    return row;
  }

  async insert(values: PgInsertValue<typeof questions>, tx: Executor): Promise<QuestionRow> {
    const [row] = await tx.insert(questions).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async update(tenantId: string, id: string, patch: PgUpdateSetSource<typeof questions>, tx: Executor): Promise<QuestionRow | undefined> {
    const [row] = await tx
      .update(questions)
      .set(patch)
      .where(and(eq(questions.tenantId, tenantId), eq(questions.id, id), isNull(questions.deletedAt)))
      .returning();
    return row;
  }

  options(tenantId: string, questionId: string, tx: Executor = this.db): Promise<QuestionOptionRow[]> {
    return tx
      .select()
      .from(questionOptions)
      .where(and(eq(questionOptions.tenantId, tenantId), eq(questionOptions.questionId, questionId)))
      .orderBy(asc(questionOptions.side), asc(questionOptions.sortOrder), asc(questionOptions.optionKey));
  }

  /** Options are replaced wholesale inside the caller's transaction; the publish validator runs at COMMIT. */
  async replaceOptions(tenantId: string, questionId: string, options: ShapedOption[], tx: Executor): Promise<void> {
    await tx.delete(questionOptions).where(and(eq(questionOptions.tenantId, tenantId), eq(questionOptions.questionId, questionId)));
    if (options.length === 0) return;
    await tx.insert(questionOptions).values(options.map((o) => ({ tenantId, questionId, ...o })));
  }

  async secondarySubtopicIds(tenantId: string, questionId: string, tx: Executor = this.db): Promise<string[]> {
    const rows = await tx
      .select({ id: questionSecondarySubtopics.subtopicId })
      .from(questionSecondarySubtopics)
      .where(and(eq(questionSecondarySubtopics.tenantId, tenantId), eq(questionSecondarySubtopics.questionId, questionId)))
      .orderBy(asc(questionSecondarySubtopics.subtopicId));
    return rows.map((r) => r.id);
  }

  async replaceSecondarySubtopics(tenantId: string, questionId: string, subtopicIds: string[], tx: Executor): Promise<void> {
    await tx
      .delete(questionSecondarySubtopics)
      .where(and(eq(questionSecondarySubtopics.tenantId, tenantId), eq(questionSecondarySubtopics.questionId, questionId)));
    if (subtopicIds.length === 0) return;
    await tx.insert(questionSecondarySubtopics).values(subtopicIds.map((subtopicId) => ({ tenantId, questionId, subtopicId })));
  }

  async approvedSolution(tenantId: string, questionId: string, tx: Executor = this.db): Promise<OfficialSolutionRow | undefined> {
    const [row] = await tx
      .select()
      .from(officialSolutions)
      .where(
        and(
          eq(officialSolutions.tenantId, tenantId),
          eq(officialSolutions.questionId, questionId),
          eq(officialSolutions.status, 'approved'),
          isNull(officialSolutions.deletedAt),
        ),
      )
      .limit(1);
    return row;
  }

  async insertSolution(values: PgInsertValue<typeof officialSolutions>, tx: Executor): Promise<OfficialSolutionRow> {
    const [row] = await tx.insert(officialSolutions).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async softDeleteSolutions(tenantId: string, questionId: string, tx: Executor): Promise<number> {
    const rows = await tx
      .update(officialSolutions)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(officialSolutions.tenantId, tenantId),
          eq(officialSolutions.questionId, questionId),
          eq(officialSolutions.status, 'approved'),
          isNull(officialSolutions.deletedAt),
        ),
      )
      .returning({ id: officialSolutions.id });
    return rows.length;
  }

  /** The conditions every listing and count of the bank shares, so a page and its total can never disagree. */
  private filterConditions(tenantId: string, filters: QuestionFilters): (SQL | undefined)[] {
    const where: (SQL | undefined)[] = [eq(questions.tenantId, tenantId), isNull(questions.deletedAt)];
    if (filters.subtopicId) where.push(eq(questions.primarySubtopicId, filters.subtopicId));
    if (filters.status) where.push(eq(questions.status, filters.status));
    if (filters.type) where.push(eq(questions.type, filters.type));
    if (filters.difficultyLabel) where.push(eq(questions.difficultyLabel, filters.difficultyLabel));
    if (filters.subjectId) {
      where.push(sql`EXISTS (SELECT 1 FROM subtopic_paths p WHERE p.tenant_id = questions.tenant_id AND p.subtopic_id = questions.primary_subtopic_id AND p.subject_id = ${filters.subjectId})`);
    }
    if (filters.trackId) {
      where.push(sql`EXISTS (SELECT 1 FROM subtopic_paths p WHERE p.tenant_id = questions.tenant_id AND p.subtopic_id = questions.primary_subtopic_id AND p.track_id = ${filters.trackId})`);
    }
    if (filters.search) {
      where.push(
        or(
          sql`search_tsv @@ websearch_to_tsquery('english', ${filters.search})`,
          sql`${questions.stem} ILIKE ${`%${escapeLike(filters.search)}%`}`,
        ),
      );
    }
    return where;
  }

  /** How many questions match the filters, for numbered pages. */
  async count(tenantId: string, filters: QuestionFilters): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(questions)
      .where(and(...this.filterConditions(tenantId, filters)));
    return row?.n ?? 0;
  }

  /**
   * Newest first. Keyset-paginated by default (`cursor`); `offset` serves numbered pages. `search` uses the tsvector
   * index, with a trigram LIKE fallback for partial words.
   */
  list(tenantId: string, filters: QuestionFilters, limit: number, cursor?: CursorPosition, offset?: number): Promise<QuestionListRow[]> {
    const where = this.filterConditions(tenantId, filters);
    if (cursor) where.push(afterCursor(questions.createdAt, questions.id, cursor));

    return this.db
      .select({
        id: questions.id,
        subtopicId: questions.primarySubtopicId,
        subjectName: sql<string | null>`(SELECT sj.name FROM subtopic_paths p JOIN subjects sj ON sj.tenant_id = p.tenant_id AND sj.id = p.subject_id WHERE p.tenant_id = questions.tenant_id AND p.subtopic_id = questions.primary_subtopic_id LIMIT 1)`,
        trackName: sql<string | null>`(SELECT tr.name FROM subtopic_paths p JOIN tracks tr ON tr.tenant_id = p.tenant_id AND tr.id = p.track_id WHERE p.tenant_id = questions.tenant_id AND p.subtopic_id = questions.primary_subtopic_id LIMIT 1)`,
        type: questions.type,
        status: questions.status,
        version: questions.version,
        stem: questions.stem,
        difficultyLabel: questions.difficultyLabel,
        difficultyB: questions.difficultyB,
        expectedTimeSeconds: questions.expectedTimeSeconds,
        hasOfficialSolution: sql<boolean>`EXISTS (SELECT 1 FROM official_solutions os
            WHERE os.question_id = questions.id AND os.status = 'approved' AND os.deleted_at IS NULL)`,
        createdAt: questions.createdAt,
        updatedAt: questions.updatedAt,
        cursorTs: cursorTimestamp(questions.createdAt),
      })
      .from(questions)
      .where(and(...where))
      .orderBy(desc(questions.createdAt), desc(questions.id))
      .limit(limit + 1)
      .offset(offset ?? 0);
  }

  async taxonomy(tenantId: string, subtopicId: string): Promise<{
    trackId: string;
    trackName: string;
    subjectId: string;
    subjectName: string;
    chapterId: string;
    chapterName: string;
    topicId: string;
    topicName: string;
    subtopicId: string;
    subtopicName: string;
  } | null> {
    const result = await this.db.execute<{
      track_id: string;
      track_name: string;
      subject_id: string;
      subject_name: string;
      chapter_id: string;
      chapter_name: string;
      topic_id: string;
      topic_name: string;
      subtopic_id: string;
      subtopic_name: string;
    }>(sql`
      SELECT
        tr.id AS track_id, tr.name AS track_name,
        sj.id AS subject_id, sj.name AS subject_name,
        ch.id AS chapter_id, ch.name AS chapter_name,
        tp.id AS topic_id, tp.name AS topic_name,
        st.id AS subtopic_id, st.name AS subtopic_name
      FROM subtopic_paths p
      JOIN tracks tr ON tr.tenant_id = p.tenant_id AND tr.id = p.track_id
      JOIN subjects sj ON sj.tenant_id = p.tenant_id AND sj.id = p.subject_id
      JOIN chapters ch ON ch.tenant_id = p.tenant_id AND ch.id = p.chapter_id
      JOIN topics tp ON tp.tenant_id = p.tenant_id AND tp.id = p.topic_id
      JOIN subtopics st ON st.tenant_id = p.tenant_id AND st.id = p.subtopic_id
      WHERE p.tenant_id = ${tenantId} AND p.subtopic_id = ${subtopicId}
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      trackId: row.track_id,
      trackName: row.track_name,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      chapterId: row.chapter_id,
      chapterName: row.chapter_name,
      topicId: row.topic_id,
      topicName: row.topic_name,
      subtopicId: row.subtopic_id,
      subtopicName: row.subtopic_name,
    };
  }

  // ---------------------------------------------------------------- student projection

  /**
   * Student-safe read. Selects only STUDENT_QUESTION_COLUMNS / STUDENT_OPTION_COLUMNS, so
   * no answer column is ever fetched on this path. `publishedOnly` is what the practice
   * API uses; the admin preview route reads drafts too.
   */
  async studentQuestion(tenantId: string, id: string, publishedOnly: boolean): Promise<{ question: StudentQuestionRow; options: StudentOptionRow[] } | undefined> {
    const where = [eq(questions.tenantId, tenantId), eq(questions.id, id), isNull(questions.deletedAt)];
    if (publishedOnly) where.push(eq(questions.status, 'published'));
    const [question] = await this.db
      .select({ ...STUDENT_QUESTION_COLUMNS, hintCount: HINT_COUNT })
      .from(questions)
      .where(and(...where))
      .limit(1);
    if (!question) return undefined;
    const options = await this.db
      .select(STUDENT_OPTION_COLUMNS)
      .from(questionOptions)
      .where(and(eq(questionOptions.tenantId, tenantId), eq(questionOptions.questionId, id)))
      .orderBy(asc(questionOptions.sortOrder), asc(questionOptions.optionKey));
    return { question, options };
  }
}
