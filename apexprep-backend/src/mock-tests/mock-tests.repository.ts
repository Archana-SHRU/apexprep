import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { isUniqueViolation } from '../database/pg-error';
import {
  mockTests,
  officialSolutions,
  questionOptions,
  questions,
  testItemResponses,
  testItems,
  testSections,
  testSessions,
  type MockTestRow,
  type TestItemResponseRow,
  type TestItemRow,
  type TestItemStatus,
  type TestKind,
  type TestSectionRow,
  type TestSessionRow,
} from '../database/schema';
import {
  HINT_COUNT,
  STUDENT_OPTION_COLUMNS,
  STUDENT_QUESTION_COLUMNS,
  type StudentOptionRow,
  type StudentQuestionRow,
} from '../questions/student-question.view';
import type { AnswerKey } from '../practice/grading';
import type { GradableItem, GradedPaper } from './mock-test-grading';

export interface FullQuestionKey extends AnswerKey {
  id: string;
  stem: string;
  stemJson: Record<string, unknown> | null;
  options: { key: string; text: string; isCorrect: boolean; side: string }[];
  solution?: { body: string; finalAnswerText: string | null } | null;
}

/** A session together with the database clock at the moment it was read. */
export interface SessionAt {
  session: TestSessionRow;
  /** `clock_timestamp()` on the database server. Every deadline comparison uses this, never the app's clock. */
  dbNow: Date;
}

export interface SessionStructure {
  session: TestSessionRow;
  test: MockTestRow;
  sections: {
    section: TestSectionRow;
    items: {
      item: TestItemRow;
      question: StudentQuestionRow;
      options: StudentOptionRow[];
      savedResponse: TestItemResponseRow | null;
    }[];
  }[];
}

export type SaveOutcome =
  | { kind: 'ok'; remainingMs: number }
  | { kind: 'not_found' }
  | { kind: 'closed'; status: string }
  | { kind: 'expired' }
  | { kind: 'unknown_item' };

export type FocusOutcome =
  | { kind: 'ok'; remainingMs: number; activeItemId: string | null }
  | { kind: 'not_found' }
  | { kind: 'closed'; status: string }
  | { kind: 'expired' }
  | { kind: 'unknown_item' };

export type FinalizeOutcome =
  | { kind: 'finalized'; status: 'completed' | 'timed_out' }
  | { kind: 'already'; status: string }
  | { kind: 'not_found' };

/** Builds the marks for a paper from what the repository loaded inside the finalizing transaction. */
export type PaperGrader = (items: GradableItem[], keys: Map<string, FullQuestionKey>) => GradedPaper;

/**
 * Saves are accepted this long after the deadline, so an answer typed in the last moment and still in flight
 * when the clock ran out is not lost to network latency. It is a tolerance, not extra exam time.
 */
export const SAVE_GRACE_MS = 5_000;

interface LockedSession {
  id: string;
  status: string;
  startedAt: Date;
  endsAt: Date;
  activeItemId: string | null;
  activeSince: Date | null;
  dbNow: Date;
}

@Injectable()
export class MockTestsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listTests(tenantId: string, userId: string, kind?: TestKind): Promise<{
    test: MockTestRow;
    questionCount: number;
    sectionCount: number;
    lastAttempt: TestSessionRow | null;
  }[]> {
    const where = [eq(mockTests.tenantId, tenantId), eq(mockTests.status, 'published')];
    if (kind) {
      where.push(eq(mockTests.kind, kind));
    }

    const tests = await this.db
      .select()
      .from(mockTests)
      .where(and(...where))
      .orderBy(asc(mockTests.kind), desc(mockTests.createdAt));

    const results = [];

    for (const test of tests) {
      const [counts] = await this.db
        .select({
          sectionCount: sql<number>`count(distinct ${testSections.id})::int`,
          questionCount: sql<number>`count(distinct ${testItems.id})::int`,
        })
        .from(testSections)
        .leftJoin(testItems, eq(testItems.sectionId, testSections.id))
        .where(eq(testSections.testId, test.id));

      const [lastAttempt] = await this.db
        .select()
        .from(testSessions)
        .where(
          and(
            eq(testSessions.tenantId, tenantId),
            eq(testSessions.userId, userId),
            eq(testSessions.testId, test.id),
          ),
        )
        .orderBy(desc(testSessions.startedAt))
        .limit(1);

      results.push({
        test,
        sectionCount: counts?.sectionCount ?? 0,
        questionCount: counts?.questionCount ?? 0,
        lastAttempt: lastAttempt ?? null,
      });
    }

    return results;
  }

  async getTestDetail(tenantId: string, testId: string, userId?: string): Promise<{
    test: MockTestRow;
    sections: { section: TestSectionRow; questionCount: number }[];
    pastAttempts: TestSessionRow[];
  } | undefined> {
    const [test] = await this.db
      .select()
      .from(mockTests)
      .where(and(eq(mockTests.tenantId, tenantId), eq(mockTests.id, testId)))
      .limit(1);

    if (!test) return undefined;

    const sectionRows = await this.db
      .select()
      .from(testSections)
      .where(eq(testSections.testId, testId))
      .orderBy(asc(testSections.sortOrder));

    const sections = [];
    for (const section of sectionRows) {
      const [countRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(testItems)
        .where(eq(testItems.sectionId, section.id));
      sections.push({
        section,
        questionCount: countRow?.count ?? 0,
      });
    }

    let pastAttempts: TestSessionRow[] = [];
    if (userId) {
      pastAttempts = await this.db
        .select()
        .from(testSessions)
        .where(
          and(
            eq(testSessions.tenantId, tenantId),
            eq(testSessions.userId, userId),
            eq(testSessions.testId, testId),
          ),
        )
        .orderBy(desc(testSessions.startedAt));
    }

    return { test, sections, pastAttempts };
  }


  // ---------------------------------------------------------------- sessions: reading

  /** The session and the database clock, optionally restricted to its owner. */
  async loadSession(tenantId: string, sessionId: string, userId?: string): Promise<SessionAt | undefined> {
    const [session] = await this.db
      .select()
      .from(testSessions)
      .where(
        and(
          eq(testSessions.tenantId, tenantId),
          eq(testSessions.id, sessionId),
          userId ? eq(testSessions.userId, userId) : undefined,
        ),
      )
      .limit(1);
    if (!session) return undefined;
    return { session, dbNow: await this.dbNow() };
  }

  /** The student's open session for this test, expired or not — the caller decides what an expired one means. */
  async findOpenSession(tenantId: string, userId: string, testId: string): Promise<SessionAt | undefined> {
    const [session] = await this.db
      .select()
      .from(testSessions)
      .where(
        and(
          eq(testSessions.tenantId, tenantId),
          eq(testSessions.userId, userId),
          eq(testSessions.testId, testId),
          eq(testSessions.status, 'in_progress'),
        ),
      )
      .orderBy(desc(testSessions.startedAt))
      .limit(1);
    if (!session) return undefined;
    return { session, dbNow: await this.dbNow() };
  }

  /** Open sessions whose deadline has passed: what the lazy finalizer and the sweep work through. */
  async findExpiredOpenSessions(opts: { tenantId?: string; userId?: string; testId?: string; limit?: number } = {}): Promise<{ id: string; tenantId: string }[]> {
    return this.db
      .select({ id: testSessions.id, tenantId: testSessions.tenantId })
      .from(testSessions)
      .where(
        and(
          eq(testSessions.status, 'in_progress'),
          sql`${testSessions.endsAt} <= clock_timestamp()`,
          opts.tenantId ? eq(testSessions.tenantId, opts.tenantId) : undefined,
          opts.userId ? eq(testSessions.userId, opts.userId) : undefined,
          opts.testId ? eq(testSessions.testId, opts.testId) : undefined,
        ),
      )
      .orderBy(asc(testSessions.endsAt))
      .limit(opts.limit ?? 100);
  }

  async getSessionStructure(tenantId: string, sessionId: string): Promise<SessionStructure | undefined> {
    return this.loadStructure(this.db, tenantId, sessionId);
  }

  async getGradingKeysForTest(tenantId: string, testId: string): Promise<Map<string, FullQuestionKey>> {
    return this.loadKeys(this.db, tenantId, testId);
  }

  // ---------------------------------------------------------------- sessions: starting

  /**
   * Opens a session, or returns the one already open. Serialised per student and test by an advisory lock,
   * and backed by `test_sessions_one_open_uq`, so two simultaneous starts end up with one session.
   * The deadline is computed on the database clock.
   */
  async createSession(
    tenantId: string,
    userId: string,
    test: MockTestRow,
  ): Promise<{ session: TestSessionRow; created: boolean }> {
    const openOne = async (exec: Executor): Promise<TestSessionRow | undefined> =>
      (
        await exec
          .select()
          .from(testSessions)
          .where(
            and(
              eq(testSessions.tenantId, tenantId),
              eq(testSessions.userId, userId),
              eq(testSessions.testId, test.id),
              eq(testSessions.status, 'in_progress'),
            ),
          )
          .limit(1)
      )[0];

    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mock:${tenantId}:${userId}:${test.id}`}, 0))`);
        const existing = await openOne(tx);
        if (existing) return { session: existing, created: false };

        const [session] = await tx
          .insert(testSessions)
          .values({
            tenantId,
            userId,
            testId: test.id,
            status: 'in_progress',
            endsAt: sql`clock_timestamp() + make_interval(mins => ${test.durationMinutes}::int)`,
            maxScore: test.totalMarks,
          })
          .returning();
        if (!session) throw new Error('Failed to create test session');

        const itemRows = await tx.select({ id: testItems.id, questionId: testItems.questionId }).from(testItems).where(eq(testItems.testId, test.id));
        if (itemRows.length > 0) {
          await tx
            .insert(testItemResponses)
            .values(itemRows.map((item) => ({ testSessionId: session.id, testItemId: item.id, questionId: item.questionId, status: 'not_visited' as const })))
            .onConflictDoNothing();
        }
        return { session, created: true };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'test_sessions_one_open_uq')) {
        const existing = await openOne(this.db);
        if (existing) return { session: existing, created: false };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- sessions: answering and timing

  /**
   * Saves one answer. The session row is locked for the whole statement, so a save and a finalization can never
   * interleave: an answer is either stored before the paper is graded or refused afterwards.
   *
   * Time spent is not taken from the client here — see `recordFocus`.
   */
  async saveResponse(
    tenantId: string,
    userId: string,
    sessionId: string,
    testItemId: string,
    input: { response: Record<string, unknown> | null; status: TestItemStatus },
  ): Promise<SaveOutcome> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, sessionId, userId);
      if (!locked) return { kind: 'not_found' };
      if (locked.status !== 'in_progress') return { kind: 'closed', status: locked.status };
      if (locked.dbNow.getTime() > locked.endsAt.getTime() + SAVE_GRACE_MS) return { kind: 'expired' };

      const updated = await tx
        .update(testItemResponses)
        .set({ response: input.response, status: input.status, updatedAt: sql`now()` as unknown as Date })
        .where(and(eq(testItemResponses.testSessionId, sessionId), eq(testItemResponses.testItemId, testItemId)))
        .returning({ id: testItemResponses.id });
      if (updated.length === 0) return { kind: 'unknown_item' };
      return { kind: 'ok', remainingMs: Math.max(0, locked.endsAt.getTime() - locked.dbNow.getTime()) };
    });
  }

  /**
   * Records which question the student now has open (or none, with `null`).
   *
   * The time the *previously* open question was open — measured between two database timestamps, and never
   * past the deadline — is added to that question first. There is one pointer per session, so two tabs cannot
   * both be "the open question": whichever focused last owns the clock, and total time can never exceed the
   * session's lifetime. Visiting a question marks it visited even if nothing is answered.
   */
  async recordFocus(tenantId: string, userId: string, sessionId: string, testItemId: string | null): Promise<FocusOutcome> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, sessionId, userId);
      if (!locked) return { kind: 'not_found' };
      if (locked.status !== 'in_progress') return { kind: 'closed', status: locked.status };
      if (locked.dbNow.getTime() >= locked.endsAt.getTime()) return { kind: 'expired' };

      let target: { status: string } | undefined;
      if (testItemId !== null) {
        [target] = await tx
          .select({ status: testItemResponses.status })
          .from(testItemResponses)
          .where(and(eq(testItemResponses.testSessionId, sessionId), eq(testItemResponses.testItemId, testItemId)))
          .limit(1);
        if (!target) return { kind: 'unknown_item' };
      }

      await this.flushActive(tx, sessionId, locked);

      await tx
        .update(testSessions)
        .set({ activeItemId: testItemId, activeSince: testItemId === null ? null : locked.dbNow, updatedAt: sql`now()` as unknown as Date })
        .where(eq(testSessions.id, sessionId));

      if (testItemId !== null && target?.status === 'not_visited') {
        await tx
          .update(testItemResponses)
          .set({ status: 'not_answered', updatedAt: sql`now()` as unknown as Date })
          .where(and(eq(testItemResponses.testSessionId, sessionId), eq(testItemResponses.testItemId, testItemId), eq(testItemResponses.status, 'not_visited')));
      }
      return { kind: 'ok', remainingMs: Math.max(0, locked.endsAt.getTime() - locked.dbNow.getTime()), activeItemId: testItemId };
    });
  }

  // ---------------------------------------------------------------- sessions: finalizing

  /**
   * Closes a session and stores its grade, once.
   *
   * Everything happens under the session row's lock: the open question's time is added up, the paper is read
   * and graded, and the outcome is written. A second caller (a double click, a retry, the sweep) waits for the
   * lock and then finds the session already closed, so grading cannot run twice or race a late save. A session
   * closed after its deadline is `timed_out` and stamped with the deadline, not with whenever it was noticed.
   */
  async finalize(tenantId: string, sessionId: string, grade: PaperGrader, userId?: string): Promise<FinalizeOutcome> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, sessionId, userId);
      if (!locked) return { kind: 'not_found' };
      if (locked.status !== 'in_progress') return { kind: 'already', status: locked.status };

      const expired = locked.dbNow.getTime() >= locked.endsAt.getTime();
      const closedAt = expired ? locked.endsAt : locked.dbNow;
      await this.flushActive(tx, sessionId, locked);

      const structure = await this.loadStructure(tx, tenantId, sessionId);
      if (!structure) return { kind: 'not_found' };
      const keys = await this.loadKeys(tx, tenantId, structure.test.id);

      const gradable: GradableItem[] = structure.sections.flatMap(({ items }) =>
        items.map(({ item, savedResponse }) => ({
          testItemId: item.id,
          questionId: item.questionId,
          positiveMarks: Number(item.positiveMarks),
          negativeMarks: Number(item.negativeMarks),
          response: savedResponse?.response ?? null,
        })),
      );
      const paper = grade(gradable, keys);

      if (paper.items.length > 0) {
        const values = sql.join(
          paper.items.map((i) => sql`(${i.testItemId}::uuid, ${i.isCorrect}::boolean, ${i.score}::numeric, ${i.outcome}::text)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE test_item_responses r
             SET is_correct = v.is_correct, score = v.score, outcome = v.outcome, updated_at = now()
            FROM (VALUES ${values}) AS v(item_id, is_correct, score, outcome)
           WHERE r.test_session_id = ${sessionId} AND r.test_item_id = v.item_id`);
      }

      const timeSpentMs = structure.sections.reduce(
        (sum, { items }) => sum + items.reduce((s, { savedResponse }) => s + (savedResponse?.timeSpentMs ?? 0), 0),
        0,
      );
      const status = expired ? ('timed_out' as const) : ('completed' as const);
      await tx
        .update(testSessions)
        .set({
          status,
          submittedAt: closedAt,
          totalScore: String(paper.totalScore),
          maxScore: paper.maxScore > 0 ? paper.maxScore : structure.test.totalMarks,
          correctCount: paper.correctCount,
          incorrectCount: paper.incorrectCount,
          unattemptedCount: paper.unattemptedCount,
          accuracy: String(paper.accuracy),
          timeSpentSec: Math.round(timeSpentMs / 1000),
          activeItemId: null,
          activeSince: null,
          updatedAt: sql`now()` as unknown as Date,
        })
        .where(eq(testSessions.id, sessionId));
      return { kind: 'finalized', status };
    });
  }

  // ---------------------------------------------------------------- internals

  private async dbNow(): Promise<Date> {
    const res = await this.db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    return new Date(res.rows[0]!.now);
  }

  /** Locks the session row for the rest of the transaction and reads the database clock in the same statement. */
  private async lock(tx: Executor, tenantId: string, sessionId: string, userId?: string): Promise<LockedSession | undefined> {
    const res = await tx.execute<{
      id: string;
      status: string;
      started_at: Date;
      ends_at: Date;
      active_item_id: string | null;
      active_since: Date | null;
      db_now: Date;
    }>(sql`
      SELECT id, status, started_at, ends_at, active_item_id, active_since, clock_timestamp() AS db_now
        FROM test_sessions
       WHERE tenant_id = ${tenantId} AND id = ${sessionId} ${userId ? sql`AND user_id = ${userId}` : sql``}
         FOR UPDATE`);
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      startedAt: new Date(row.started_at),
      endsAt: new Date(row.ends_at),
      activeItemId: row.active_item_id,
      activeSince: row.active_since ? new Date(row.active_since) : null,
      dbNow: new Date(row.db_now),
    };
  }

  /** Adds the time the open question has been open, up to the deadline at most, to that question. */
  private async flushActive(tx: Executor, sessionId: string, locked: LockedSession): Promise<void> {
    if (!locked.activeItemId || !locked.activeSince) return;
    const until = Math.min(locked.dbNow.getTime(), locked.endsAt.getTime());
    const delta = Math.min(Math.max(0, until - locked.activeSince.getTime()), 2_000_000_000);
    if (delta === 0) return;
    await tx.execute(sql`
      UPDATE test_item_responses
         SET time_spent_ms  = LEAST(time_spent_ms + ${delta}::bigint, 2000000000),
             time_spent_sec = (LEAST(time_spent_ms + ${delta}::bigint, 2000000000) + 500) / 1000,
             updated_at     = now()
       WHERE test_session_id = ${sessionId} AND test_item_id = ${locked.activeItemId}`);
  }

  private async loadStructure(exec: Executor, tenantId: string, sessionId: string): Promise<SessionStructure | undefined> {
    const [session] = await exec
      .select()
      .from(testSessions)
      .where(and(eq(testSessions.tenantId, tenantId), eq(testSessions.id, sessionId)))
      .limit(1);
    if (!session) return undefined;

    const [test] = await exec
      .select()
      .from(mockTests)
      .where(and(eq(mockTests.tenantId, tenantId), eq(mockTests.id, session.testId)))
      .limit(1);
    if (!test) return undefined;

    const sectionRows = await exec.select().from(testSections).where(eq(testSections.testId, test.id)).orderBy(asc(testSections.sortOrder));
    const itemRows = await exec.select().from(testItems).where(eq(testItems.testId, test.id)).orderBy(asc(testItems.sortOrder));
    const questionIds = [...new Set(itemRows.map((i) => i.questionId))];

    const questionRows: StudentQuestionRow[] =
      questionIds.length === 0
        ? []
        : await exec
            .select({ ...STUDENT_QUESTION_COLUMNS, hintCount: HINT_COUNT })
            .from(questions)
            .where(and(eq(questions.tenantId, tenantId), inArray(questions.id, questionIds)));
    const optionRows =
      questionIds.length === 0
        ? []
        : await exec
            .select({ ...STUDENT_OPTION_COLUMNS, questionId: questionOptions.questionId })
            .from(questionOptions)
            .where(and(eq(questionOptions.tenantId, tenantId), inArray(questionOptions.questionId, questionIds)))
            .orderBy(asc(questionOptions.sortOrder), asc(questionOptions.optionKey));
    const responseRows = await exec.select().from(testItemResponses).where(eq(testItemResponses.testSessionId, sessionId));

    const questionById = new Map(questionRows.map((q) => [q.id, q]));
    const optionsByQuestion = new Map<string, StudentOptionRow[]>();
    for (const { questionId, ...option } of optionRows) {
      const list = optionsByQuestion.get(questionId) ?? [];
      list.push(option);
      optionsByQuestion.set(questionId, list);
    }
    const responseByItem = new Map(responseRows.map((r) => [r.testItemId, r]));

    const sections = sectionRows.map((section) => ({
      section,
      items: itemRows
        .filter((item) => item.sectionId === section.id)
        .flatMap((item) => {
          const question = questionById.get(item.questionId);
          if (!question) return [];
          return [{ item, question, options: optionsByQuestion.get(item.questionId) ?? [], savedResponse: responseByItem.get(item.id) ?? null }];
        }),
    }));
    return { session, test, sections };
  }

  private async loadKeys(exec: Executor, tenantId: string, testId: string): Promise<Map<string, FullQuestionKey>> {
    const itemRows = await exec.select({ questionId: testItems.questionId }).from(testItems).where(eq(testItems.testId, testId));
    const questionIds = [...new Set(itemRows.map((i) => i.questionId))];
    const map = new Map<string, FullQuestionKey>();
    if (questionIds.length === 0) return map;

    const questionRows = await exec
      .select({
        id: questions.id,
        stem: questions.stem,
        stemJson: questions.stemJson,
        type: questions.type,
        correctNumeric: questions.correctNumeric,
        numericTolerance: questions.numericTolerance,
        toleranceMode: questions.toleranceMode,
        matrixAnswer: questions.matrixAnswer,
      })
      .from(questions)
      .where(and(eq(questions.tenantId, tenantId), inArray(questions.id, questionIds)));
    const optionRows = await exec
      .select({
        questionId: questionOptions.questionId,
        key: questionOptions.optionKey,
        side: questionOptions.side,
        text: questionOptions.body,
        isCorrect: questionOptions.isCorrect,
      })
      .from(questionOptions)
      .where(and(eq(questionOptions.tenantId, tenantId), inArray(questionOptions.questionId, questionIds)))
      .orderBy(asc(questionOptions.sortOrder));
    const solutionRows = await exec
      .select({ questionId: officialSolutions.questionId, body: officialSolutions.body, finalAnswerText: officialSolutions.finalAnswerText })
      .from(officialSolutions)
      .where(
        and(
          eq(officialSolutions.tenantId, tenantId),
          inArray(officialSolutions.questionId, questionIds),
          eq(officialSolutions.status, 'approved'),
          isNull(officialSolutions.deletedAt),
        ),
      );

    const optionsByQuestion = new Map<string, { key: string; side: string; text: string; isCorrect: boolean }[]>();
    for (const { questionId, ...option } of optionRows) {
      const list = optionsByQuestion.get(questionId) ?? [];
      list.push(option);
      optionsByQuestion.set(questionId, list);
    }
    const solutionByQuestion = new Map<string, { body: string; finalAnswerText: string | null }>();
    for (const { questionId, ...solution } of solutionRows) if (!solutionByQuestion.has(questionId)) solutionByQuestion.set(questionId, solution);

    for (const q of questionRows) {
      const options = optionsByQuestion.get(q.id) ?? [];
      map.set(q.id, {
        id: q.id,
        stem: q.stem,
        stemJson: q.stemJson,
        type: q.type,
        correctNumeric: q.correctNumeric,
        numericTolerance: q.numericTolerance,
        toleranceMode: q.toleranceMode,
        matrixAnswer: q.matrixAnswer ?? null,
        correctOptionKeys: options.filter((o) => o.isCorrect).map((o) => o.key),
        optionKeys: {
          single: options.filter((o) => o.side === 'single').map((o) => o.key),
          left: options.filter((o) => o.side === 'left').map((o) => o.key),
          right: options.filter((o) => o.side === 'right').map((o) => o.key),
        },
        options,
        solution: solutionByQuestion.get(q.id) ?? null,
      });
    }
    return map;
  }
}
