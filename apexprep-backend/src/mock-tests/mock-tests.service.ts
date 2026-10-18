import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception';
import { revealedAnswer } from '../practice/grading';
import { toStudentQuestionView } from '../questions/student-question.view';
import type { TestKind, TestSessionRow } from '../database/schema';
import type {
  MockTestAttemptSummaryDto,
  MockTestDetailDto,
  MockTestSummaryDto,
  QuestionResultAnalysisDto,
  SectionResultDto,
  SessionClockDto,
  SubmitTestAnswerDto,
  TestResultDto,
  TestSessionQuestionDto,
  TestSessionSectionDto,
  TestSessionStateDto,
} from './dto/mock-tests.dto';
import { gradePaper } from './mock-test-grading';
import { MockTestsRepository, type FinalizeOutcome } from './mock-tests.repository';

/** The largest saved response, serialized. A real answer is a few option keys, a number or a written solution. */
const MAX_RESPONSE_BYTES = 20_000;

/**
 * Mock tests: timed papers with a marking scheme.
 *
 * Three rules this service exists to keep, all enforced on the server and none left to the browser:
 *
 *  1. **The deadline is the database's.** `ends_at` is set from the database clock when the session starts and
 *     every comparison uses the database clock. The countdown in the browser is a display. A session whose
 *     deadline has passed is closed and graded (`timed_out`) the first time anything touches it, and by the
 *     sweep (`finalizeExpiredSessions`) when nothing does.
 *  2. **Nothing about the answers is revealed before the paper is closed.** The result — correct answers and
 *     solutions — exists only for a closed session.
 *  3. **Closing is final and happens once.** It runs under the session's row lock; answers and timing can no
 *     longer change afterwards, and a repeated submit returns the stored result.
 *
 * Time on a question is *measured* by the server (see `focus`); expected solving time is information about the
 * question and is never enforced here; there are no per-question or per-section deadlines.
 */
@Injectable()
export class MockTestsService {
  private readonly logger = new Logger(MockTestsService.name);

  constructor(private readonly repo: MockTestsRepository) {}

  // ---------------------------------------------------------------- catalogue

  async listTests(tenantId: string, userId: string, kind?: TestKind): Promise<MockTestSummaryDto[]> {
    // A paper left open past its deadline is closed before the learner's history is read, so the history is true.
    await this.finalizeExpiredFor(tenantId, userId);
    const list = await this.repo.listTests(tenantId, userId, kind);

    return list.map(({ test, sectionCount, questionCount, lastAttempt }) => ({
      id: test.id,
      title: test.title,
      description: test.description,
      kind: test.kind,
      durationMinutes: test.durationMinutes,
      totalMarks: test.totalMarks,
      defaultPositiveMarks: Number(test.defaultPositiveMarks),
      defaultNegativeMarks: Number(test.defaultNegativeMarks),
      status: test.status,
      questionCount,
      sectionCount,
      instructions: test.instructions,
      lastAttempt: lastAttempt ? attemptSummary(lastAttempt, test.totalMarks) : null,
    }));
  }

  async getTestDetail(tenantId: string, testId: string, userId: string): Promise<MockTestDetailDto> {
    await this.finalizeExpiredFor(tenantId, userId, testId);
    const detail = await this.repo.getTestDetail(tenantId, testId, userId);
    if (!detail) throw AppException.notFound('Mock test not found', 'NOT_FOUND');

    const { test, sections, pastAttempts } = detail;
    const totalQuestions = sections.reduce((acc, s) => acc + s.questionCount, 0);

    return {
      id: test.id,
      title: test.title,
      description: test.description,
      kind: test.kind,
      durationMinutes: test.durationMinutes,
      totalMarks: test.totalMarks,
      defaultPositiveMarks: Number(test.defaultPositiveMarks),
      defaultNegativeMarks: Number(test.defaultNegativeMarks),
      status: test.status,
      questionCount: totalQuestions,
      sectionCount: sections.length,
      instructions: test.instructions,
      lastAttempt: pastAttempts[0] ? attemptSummary(pastAttempts[0], test.totalMarks) : null,
      sections: sections.map((s) => ({
        id: s.section.id,
        name: s.section.name,
        subjectId: s.section.subjectId,
        sortOrder: s.section.sortOrder,
        questionCount: s.questionCount,
        durationMinutes: s.section.durationMinutes,
        instructions: s.section.instructions,
      })),
      pastAttempts: pastAttempts.map((a) => attemptSummary(a, test.totalMarks)),
    };
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Starts a paper, or resumes the one that is open.
   *
   * A paper whose deadline has passed is **not** replaced by a fresh attempt: it is closed and graded, and the
   * caller is told (`SESSION_EXPIRED`, with the session id in the details) so it can show that result. Only a
   * later, deliberate start — with nothing open — begins a new attempt.
   */
  async startOrResumeTest(tenantId: string, userId: string, testId: string): Promise<TestSessionStateDto> {
    const detail = await this.repo.getTestDetail(tenantId, testId, userId);
    if (!detail || detail.test.status !== 'published') throw AppException.notFound('Mock test not found or not published');
    if (detail.sections.reduce((n, s) => n + s.questionCount, 0) === 0) {
      throw AppException.conflict('This test has no questions yet', 'INVALID_STATE');
    }

    const open = await this.repo.findOpenSession(tenantId, userId, testId);
    if (open) {
      if (open.dbNow.getTime() >= open.session.endsAt.getTime()) {
        await this.close(tenantId, open.session.id, userId);
        throw this.expired(open.session.id);
      }
      return this.getSessionState(tenantId, userId, open.session.id);
    }

    const { session } = await this.repo.createSession(tenantId, userId, detail.test);
    return this.getSessionState(tenantId, userId, session.id);
  }

  async getSessionState(tenantId: string, userId: string, sessionId: string): Promise<TestSessionStateDto> {
    let loaded = await this.requireSession(tenantId, userId, sessionId);
    if (loaded.session.status === 'in_progress' && loaded.dbNow.getTime() >= loaded.session.endsAt.getTime()) {
      await this.close(tenantId, sessionId, userId);
      // Re-read: the status this response reports must be the one the database now holds.
      loaded = await this.requireSession(tenantId, userId, sessionId);
    }

    const data = await this.repo.getSessionStructure(tenantId, sessionId);
    if (!data) throw AppException.notFound('Test session not found');
    const { session, test, sections } = data;
    const remainingSeconds =
      session.status === 'in_progress' ? Math.max(0, Math.floor((session.endsAt.getTime() - loaded.dbNow.getTime()) / 1000)) : 0;

    const sectionDtos: TestSessionSectionDto[] = sections.map(({ section, items }) => ({
      id: section.id,
      name: section.name,
      sortOrder: section.sortOrder,
      durationMinutes: section.durationMinutes,
      questions: items.map(({ item, question, options, savedResponse }): TestSessionQuestionDto => ({
        testItemId: item.id,
        sectionId: section.id,
        sectionName: section.name,
        sortOrder: item.sortOrder,
        positiveMarks: Number(item.positiveMarks),
        negativeMarks: Number(item.negativeMarks),
        question: toStudentQuestionView(question, options),
        currentResponse: savedResponse?.response ?? null,
        status: savedResponse?.status ?? 'not_visited',
        timeSpentSec: Math.round((savedResponse?.timeSpentMs ?? 0) / 1000),
      })),
    }));

    return {
      sessionId: session.id,
      testId: test.id,
      testTitle: test.title,
      kind: test.kind,
      durationMinutes: test.durationMinutes,
      totalMarks: test.totalMarks,
      startedAt: session.startedAt.toISOString(),
      endsAt: session.endsAt.toISOString(),
      remainingSeconds,
      status: session.status,
      activeTestItemId: session.status === 'in_progress' ? session.activeItemId : null,
      sections: sectionDtos,
    };
  }

  async saveAnswer(tenantId: string, userId: string, sessionId: string, dto: SubmitTestAnswerDto): Promise<SessionClockDto> {
    const response = dto.response ?? null;
    if (response !== null && JSON.stringify(response).length > MAX_RESPONSE_BYTES) {
      throw AppException.validation([{ field: 'response', message: `a response may not exceed ${MAX_RESPONSE_BYTES} characters` }]);
    }

    const outcome = await this.repo.saveResponse(tenantId, userId, sessionId, dto.testItemId, { response, status: dto.status });
    switch (outcome.kind) {
      case 'ok':
        return { ok: true, remainingSeconds: Math.floor(outcome.remainingMs / 1000) };
      case 'not_found':
        throw AppException.notFound('Test session not found');
      case 'unknown_item':
        // Never a quiet `ok`: the client must learn that nothing was stored.
        throw AppException.validation([{ field: 'testItemId', message: 'this question is not part of the session' }]);
      case 'closed':
        throw AppException.conflict('This test session is closed; answers can no longer change', 'SESSION_CLOSED');
      case 'expired':
        await this.close(tenantId, sessionId, userId);
        throw AppException.conflict('The time limit for this test has expired; your saved answers were submitted', 'TIME_EXPIRED');
    }
  }

  /**
   * The student has opened a question (or none). The server adds up how long the previous one was open.
   * This is the only way time on a question is recorded: a value sent by the client is never trusted.
   */
  async focus(tenantId: string, userId: string, sessionId: string, testItemId: string | null): Promise<SessionClockDto> {
    const outcome = await this.repo.recordFocus(tenantId, userId, sessionId, testItemId);
    switch (outcome.kind) {
      case 'ok':
        return { ok: true, remainingSeconds: Math.floor(outcome.remainingMs / 1000) };
      case 'not_found':
        throw AppException.notFound('Test session not found');
      case 'unknown_item':
        throw AppException.validation([{ field: 'testItemId', message: 'this question is not part of the session' }]);
      case 'closed':
        throw AppException.conflict('This test session is closed', 'SESSION_CLOSED');
      case 'expired':
        await this.close(tenantId, sessionId, userId);
        throw AppException.conflict('The time limit for this test has expired; your saved answers were submitted', 'TIME_EXPIRED');
    }
  }

  /** Submitting twice, or after the deadline, never grades twice: the stored result is returned. */
  async submitTest(tenantId: string, userId: string, sessionId: string): Promise<TestResultDto> {
    const outcome = await this.close(tenantId, sessionId, userId);
    if (outcome.kind === 'not_found') throw AppException.notFound('Test session not found');
    return this.getResult(tenantId, userId, sessionId);
  }

  /**
   * The result of a closed session: score, analysis, correct answers and solutions.
   *
   * Refused while the paper is still open — this is what stops a student reading the answer key mid-test — and
   * for an abandoned attempt, which was never graded. A paper that is past its deadline but not yet closed is
   * closed here first, so its owner can always read what they earned.
   */
  async getResult(tenantId: string, userId: string, sessionId: string): Promise<TestResultDto> {
    let loaded = await this.requireSession(tenantId, userId, sessionId);
    if (loaded.session.status === 'in_progress') {
      if (loaded.dbNow.getTime() < loaded.session.endsAt.getTime()) {
        throw AppException.conflict('The result is available once you submit the test', 'INVALID_STATE');
      }
      await this.close(tenantId, sessionId, userId);
      loaded = await this.requireSession(tenantId, userId, sessionId);
    }
    if (loaded.session.status !== 'completed' && loaded.session.status !== 'timed_out') {
      throw AppException.conflict('This attempt was abandoned and has no result', 'INVALID_STATE');
    }

    const data = await this.repo.getSessionStructure(tenantId, sessionId);
    if (!data) throw AppException.notFound('Test session not found');
    const { session, test, sections } = data;
    const keys = await this.repo.getGradingKeysForTest(tenantId, test.id);

    const sectionResults: SectionResultDto[] = [];
    const questionAnalyses: QuestionResultAnalysisDto[] = [];
    let rawScore = 0;

    for (const { section, items } of sections) {
      let secScore = 0;
      let secMaxScore = 0;
      let secCorrect = 0;
      let secIncorrect = 0;
      let secUnattempted = 0;
      let secTimeSpent = 0;

      for (const { item, savedResponse } of items) {
        const key = keys.get(item.questionId);
        const score = Number(savedResponse?.score ?? 0);
        const positiveMarks = Number(item.positiveMarks);
        const negativeMarks = Number(item.negativeMarks);
        const outcome = savedResponse?.outcome ?? 'unattempted';
        const timeSpent = Math.round((savedResponse?.timeSpentMs ?? 0) / 1000);

        secScore += score;
        secMaxScore += positiveMarks;
        secTimeSpent += timeSpent;
        if (outcome === 'correct') secCorrect++;
        else if (outcome === 'incorrect') secIncorrect++;
        else secUnattempted++;

        questionAnalyses.push({
          testItemId: item.id,
          questionId: item.questionId,
          sectionName: section.name,
          sortOrder: item.sortOrder,
          stem: key?.stem ?? '',
          stemJson: key?.stemJson ?? null,
          type: key?.type ?? 'single_correct',
          options: (key?.options ?? []).map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })),
          correctAnswer: key ? revealedAnswer(key) : {},
          studentResponse: savedResponse?.response ?? null,
          status: savedResponse?.status ?? 'not_visited',
          outcome,
          score,
          positiveMarks,
          negativeMarks,
          timeSpentSec: timeSpent,
          solution: key?.solution ?? null,
        });
      }

      rawScore += secScore;
      const secAttempted = secCorrect + secIncorrect;
      sectionResults.push({
        sectionId: section.id,
        sectionName: section.name,
        // Floored like the paper's total, as it always has been.
        score: Math.max(0, secScore),
        maxScore: secMaxScore,
        correctCount: secCorrect,
        incorrectCount: secIncorrect,
        unattemptedCount: secUnattempted,
        accuracy: secAttempted > 0 ? Number(((secCorrect / secAttempted) * 100).toFixed(2)) : 0,
        timeSpentSec: secTimeSpent,
      });
    }

    const totalScore = Number(session.totalScore ?? 0);
    const maxScore = session.maxScore ?? test.totalMarks;
    return {
      sessionId: session.id,
      testId: test.id,
      testTitle: test.title,
      kind: test.kind,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      submittedAt: session.submittedAt ? session.submittedAt.toISOString() : null,
      timeSpentSec: session.timeSpentSec ?? 0,
      totalScore,
      rawScore,
      maxScore,
      percentage: maxScore > 0 ? Number(((totalScore / maxScore) * 100).toFixed(2)) : 0,
      accuracy: Number(session.accuracy ?? 0),
      correctCount: session.correctCount ?? 0,
      incorrectCount: session.incorrectCount ?? 0,
      unattemptedCount: session.unattemptedCount ?? 0,
      sections: sectionResults,
      questions: questionAnalyses,
    };
  }

  // ---------------------------------------------------------------- closing

  /**
   * Closes and grades every session whose deadline has passed, oldest first, and returns how many it closed.
   * Safe to run from any number of processes at once: each close takes the session's lock and a session that
   * is already closed is skipped.
   */
  async finalizeExpiredSessions(limit = 100): Promise<number> {
    const expired = await this.repo.findExpiredOpenSessions({ limit });
    let closed = 0;
    for (const { id, tenantId } of expired) {
      try {
        const outcome = await this.close(tenantId, id);
        if (outcome.kind === 'finalized') closed += 1;
      } catch (error) {
        this.logger.warn(`could not close expired test session ${id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return closed;
  }

  private async finalizeExpiredFor(tenantId: string, userId: string, testId?: string): Promise<void> {
    const expired = await this.repo.findExpiredOpenSessions({ tenantId, userId, testId, limit: 20 });
    for (const { id } of expired) await this.close(tenantId, id, userId);
  }

  private close(tenantId: string, sessionId: string, userId?: string): Promise<FinalizeOutcome> {
    return this.repo.finalize(tenantId, sessionId, (items, keys) => gradePaper(items, keys), userId);
  }

  private async requireSession(tenantId: string, userId: string, sessionId: string): Promise<{ session: TestSessionRow; dbNow: Date }> {
    // Scoped to the owner in the query itself: someone else's session is indistinguishable from a missing one.
    const loaded = await this.repo.loadSession(tenantId, sessionId, userId);
    if (!loaded) throw AppException.notFound('Test session not found');
    return loaded;
  }

  private expired(sessionId: string): AppException {
    return new AppException(HttpStatus.CONFLICT, 'SESSION_EXPIRED', 'The time for this test ran out. Your answers were submitted; the result is ready.', [
      { field: 'sessionId', message: sessionId },
    ]);
  }
}

function attemptSummary(a: TestSessionRow, testTotalMarks: number): MockTestAttemptSummaryDto {
  return {
    sessionId: a.id,
    status: a.status,
    totalScore: Number(a.totalScore ?? 0),
    maxScore: a.maxScore ?? testTotalMarks,
    accuracy: Number(a.accuracy ?? 0),
    startedAt: a.startedAt.toISOString(),
    submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
  };
}
