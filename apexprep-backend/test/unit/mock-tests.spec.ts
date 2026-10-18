import { AppException } from '../../src/common/errors/app-exception';
import type { MockTestRow, TestItemResponseRow, TestItemRow, TestSectionRow, TestSessionRow } from '../../src/database/schema';
import { MockTestsService } from '../../src/mock-tests/mock-tests.service';
import type { FullQuestionKey, MockTestsRepository, SessionStructure } from '../../src/mock-tests/mock-tests.repository';

/**
 * The service's own rules, against a mocked repository: who may see what, and what each repository outcome
 * means to the caller. The transactional behaviour itself (locking, the database clock, the unique index) is
 * proved against a real database in test/e2e/mock-tests.e2e-spec.ts.
 */
describe('MockTestsService', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const userId = '00000000-0000-0000-0000-000000000002';
  const testId = '00000000-0000-0000-0000-000000000003';
  const sectionId = '00000000-0000-0000-0000-000000000004';
  const sessionId = '00000000-0000-0000-0000-000000000005';
  const q1Id = '00000000-0000-0000-0000-000000000011';
  const NOW = new Date('2026-03-01T10:00:00.000Z');
  const FUTURE = new Date('2026-03-01T12:00:00.000Z');
  const PAST = new Date('2026-03-01T09:00:00.000Z');

  const test: MockTestRow = {
    id: testId,
    tenantId,
    trackId: null,
    title: 'JEE Main Simulation Test 1',
    description: null,
    kind: 'full_length',
    durationMinutes: 180,
    totalMarks: 300,
    defaultPositiveMarks: '4.00',
    defaultNegativeMarks: '1.00',
    status: 'published',
    instructions: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
  const section: TestSectionRow = {
    id: sectionId,
    testId,
    name: 'Physics',
    subjectId: null,
    sortOrder: 0,
    durationMinutes: null,
    instructions: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
  const item: TestItemRow = {
    id: 'item-1',
    testId,
    sectionId,
    questionId: q1Id,
    sortOrder: 0,
    positiveMarks: '4.00',
    negativeMarks: '1.00',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  const sessionRow = (over: Partial<TestSessionRow> = {}): TestSessionRow => ({
    id: sessionId,
    tenantId,
    userId,
    testId,
    status: 'in_progress',
    startedAt: new Date('2026-03-01T09:30:00.000Z'),
    endsAt: FUTURE,
    submittedAt: null,
    totalScore: '0',
    maxScore: 4,
    correctCount: 0,
    incorrectCount: 0,
    unattemptedCount: 0,
    accuracy: '0',
    timeSpentSec: 0,
    activeItemId: null,
    activeSince: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  const response = (over: Partial<TestItemResponseRow> = {}): TestItemResponseRow => ({
    id: 'r-1',
    testSessionId: sessionId,
    testItemId: item.id,
    questionId: q1Id,
    response: { optionKeys: ['A'] },
    status: 'answered',
    isCorrect: true,
    score: '4.00',
    outcome: 'correct',
    timeSpentSec: 41,
    timeSpentMs: 40_600,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  const structure = (session: TestSessionRow, saved: TestItemResponseRow | null = response()): SessionStructure => ({
    session,
    test,
    sections: [
      {
        section,
        items: [
          {
            item,
            question: {
              id: q1Id,
              version: 1,
              type: 'single_correct',
              subtopicId: 'st-1',
              stem: 'What is the SI unit of force?',
              stemJson: null,
              difficultyLabel: 2,
              expectedTimeSeconds: 60,
              hintCount: 0,
            },
            options: [
              { key: 'A', side: 'single', text: 'Newton' },
              { key: 'B', side: 'single', text: 'Joule' },
            ],
            savedResponse: saved,
          },
        ],
      },
    ],
  });

  const key: FullQuestionKey = {
    id: q1Id,
    stem: 'What is the SI unit of force?',
    stemJson: null,
    type: 'single_correct',
    correctOptionKeys: ['A'],
    optionKeys: { single: ['A', 'B'], left: [], right: [] },
    options: [
      { key: 'A', text: 'Newton', isCorrect: true, side: 'single' },
      { key: 'B', text: 'Joule', isCorrect: false, side: 'single' },
    ],
    correctNumeric: null,
    numericTolerance: null,
    toleranceMode: null,
    matrixAnswer: null,
    solution: { body: 'Force = mass × acceleration, unit is Newton (N)', finalAnswerText: 'Newton' },
  };

  let repo: jest.Mocked<MockTestsRepository>;
  let service: MockTestsService;

  const detail = { test, sections: [{ section, questionCount: 1 }], pastAttempts: [] as TestSessionRow[] };

  beforeEach(() => {
    repo = {
      listTests: jest.fn(),
      getTestDetail: jest.fn(),
      findOpenSession: jest.fn(),
      findExpiredOpenSessions: jest.fn().mockResolvedValue([]),
      createSession: jest.fn(),
      loadSession: jest.fn(),
      getSessionStructure: jest.fn(),
      getGradingKeysForTest: jest.fn().mockResolvedValue(new Map([[q1Id, key]])),
      saveResponse: jest.fn(),
      recordFocus: jest.fn(),
      finalize: jest.fn(),
    } as unknown as jest.Mocked<MockTestsRepository>;
    service = new MockTestsService(repo);
  });

  const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
    try {
      await promise;
    } catch (error) {
      return error instanceof AppException ? error.code : 'NOT_AN_APP_EXCEPTION';
    }
    return undefined;
  };

  describe('listTests', () => {
    it('closes the learner\'s expired papers first, then returns published tests with their counts', async () => {
      repo.listTests.mockResolvedValue([{ test, sectionCount: 3, questionCount: 75, lastAttempt: null }]);
      const result = await service.listTests(tenantId, userId);
      expect(repo.findExpiredOpenSessions).toHaveBeenCalledWith(expect.objectContaining({ tenantId, userId }));
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ title: test.title, questionCount: 75, sectionCount: 3, lastAttempt: null });
    });
  });

  describe('startOrResumeTest', () => {
    it('resumes the open session and does not create another', async () => {
      repo.getTestDetail.mockResolvedValue(detail);
      repo.findOpenSession.mockResolvedValue({ session: sessionRow(), dbNow: NOW });
      repo.loadSession.mockResolvedValue({ session: sessionRow(), dbNow: NOW });
      repo.getSessionStructure.mockResolvedValue(structure(sessionRow({ activeItemId: item.id })));

      const state = await service.startOrResumeTest(tenantId, userId, testId);
      expect(state).toMatchObject({ sessionId, status: 'in_progress', remainingSeconds: 7200, activeTestItemId: item.id });
      expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('does not start a fresh attempt when the open one has expired: it closes it and says so', async () => {
      repo.getTestDetail.mockResolvedValue(detail);
      repo.findOpenSession.mockResolvedValue({ session: sessionRow({ endsAt: PAST }), dbNow: NOW });
      repo.finalize.mockResolvedValue({ kind: 'finalized', status: 'timed_out' });

      const error = await service.startOrResumeTest(tenantId, userId, testId).catch((e: unknown) => e as AppException);
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('SESSION_EXPIRED');
      expect((error as AppException).details).toEqual([{ field: 'sessionId', message: sessionId }]);
      expect(repo.finalize).toHaveBeenCalledTimes(1);
      expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('creates a session only when nothing is open', async () => {
      repo.getTestDetail.mockResolvedValue(detail);
      repo.findOpenSession.mockResolvedValue(undefined);
      repo.createSession.mockResolvedValue({ session: sessionRow(), created: true });
      repo.loadSession.mockResolvedValue({ session: sessionRow(), dbNow: NOW });
      repo.getSessionStructure.mockResolvedValue(structure(sessionRow(), null));

      const state = await service.startOrResumeTest(tenantId, userId, testId);
      expect(repo.createSession).toHaveBeenCalledWith(tenantId, userId, test);
      expect(state.sections[0]!.questions[0]).toMatchObject({ status: 'not_visited', timeSpentSec: 0, currentResponse: null });
    });

    it('refuses a draft test and a test with no questions', async () => {
      repo.getTestDetail.mockResolvedValue({ ...detail, test: { ...test, status: 'draft' } });
      expect(await codeOf(service.startOrResumeTest(tenantId, userId, testId))).toBe('NOT_FOUND');
      repo.getTestDetail.mockResolvedValue({ ...detail, sections: [{ section, questionCount: 0 }] });
      expect(await codeOf(service.startOrResumeTest(tenantId, userId, testId))).toBe('INVALID_STATE');
    });
  });

  describe('getSessionState', () => {
    it('closes an expired session and reports the status the database now holds, not the stale one', async () => {
      repo.loadSession
        .mockResolvedValueOnce({ session: sessionRow({ endsAt: PAST }), dbNow: NOW })
        .mockResolvedValueOnce({ session: sessionRow({ endsAt: PAST, status: 'timed_out' }), dbNow: NOW });
      repo.finalize.mockResolvedValue({ kind: 'finalized', status: 'timed_out' });
      repo.getSessionStructure.mockResolvedValue(structure(sessionRow({ endsAt: PAST, status: 'timed_out' })));

      const state = await service.getSessionState(tenantId, userId, sessionId);
      expect(state.status).toBe('timed_out');
      expect(state.remainingSeconds).toBe(0);
      expect(state.activeTestItemId).toBeNull();
    });

    it('treats another student\'s session exactly like a missing one', async () => {
      repo.loadSession.mockResolvedValue(undefined);
      expect(await codeOf(service.getSessionState(tenantId, 'someone-else', sessionId))).toBe('NOT_FOUND');
      expect(repo.loadSession).toHaveBeenCalledWith(tenantId, sessionId, 'someone-else');
    });

    it('never serialises an answer key into the student view', async () => {
      repo.loadSession.mockResolvedValue({ session: sessionRow(), dbNow: NOW });
      repo.getSessionStructure.mockResolvedValue(structure(sessionRow()));
      const json = JSON.stringify(await service.getSessionState(tenantId, userId, sessionId));
      expect(json).not.toMatch(/isCorrect|correctOption|Force = mass|finalAnswerText/);
    });
  });

  describe('getResult — answer protection', () => {
    it('refuses while the paper is still open, without reading the answer key', async () => {
      repo.loadSession.mockResolvedValue({ session: sessionRow(), dbNow: NOW });
      expect(await codeOf(service.getResult(tenantId, userId, sessionId))).toBe('INVALID_STATE');
      expect(repo.getGradingKeysForTest).not.toHaveBeenCalled();
      expect(repo.getSessionStructure).not.toHaveBeenCalled();
    });

    it('refuses an abandoned attempt', async () => {
      repo.loadSession.mockResolvedValue({ session: sessionRow({ status: 'abandoned' }), dbNow: NOW });
      expect(await codeOf(service.getResult(tenantId, userId, sessionId))).toBe('INVALID_STATE');
    });

    it('closes a paper past its deadline and then returns what the learner earned', async () => {
      const closed = sessionRow({ endsAt: PAST, status: 'timed_out', totalScore: '4', maxScore: 4, correctCount: 1, accuracy: '100', timeSpentSec: 41 });
      repo.loadSession
        .mockResolvedValueOnce({ session: sessionRow({ endsAt: PAST }), dbNow: NOW })
        .mockResolvedValueOnce({ session: closed, dbNow: NOW });
      repo.finalize.mockResolvedValue({ kind: 'finalized', status: 'timed_out' });
      repo.getSessionStructure.mockResolvedValue(structure(closed));

      const result = await service.getResult(tenantId, userId, sessionId);
      expect(repo.finalize).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'timed_out', totalScore: 4, rawScore: 4, correctCount: 1 });
    });

    it('returns the analysis, correct answers and solutions once the paper is closed', async () => {
      const closed = sessionRow({ status: 'completed', totalScore: '4', correctCount: 1, accuracy: '100', timeSpentSec: 41 });
      repo.loadSession.mockResolvedValue({ session: closed, dbNow: NOW });
      repo.getSessionStructure.mockResolvedValue(structure(closed));

      const result = await service.getResult(tenantId, userId, sessionId);
      expect(result.questions[0]).toMatchObject({ outcome: 'correct', score: 4, timeSpentSec: 41 });
      expect(result.questions[0]!.options.find((o) => o.key === 'A')?.isCorrect).toBe(true);
      expect(result.questions[0]!.solution?.body).toContain('Force = mass × acceleration');
      expect(result.sections).toHaveLength(1);
    });

    it('shows the unfloored score beside the floored total when the paper went negative', async () => {
      const negative = response({ response: { optionKeys: ['B'] }, isCorrect: false, score: '-1.00', outcome: 'incorrect' });
      const closed = sessionRow({ status: 'completed', totalScore: '0', correctCount: 0, incorrectCount: 1 });
      repo.loadSession.mockResolvedValue({ session: closed, dbNow: NOW });
      repo.getSessionStructure.mockResolvedValue(structure(closed, negative));

      const result = await service.getResult(tenantId, userId, sessionId);
      expect(result.totalScore).toBe(0);
      expect(result.rawScore).toBe(-1);
      expect(result.sections[0]!.score).toBe(0);
    });
  });

  describe('saveAnswer', () => {
    const dto = { testItemId: item.id, response: { optionKeys: ['A'] }, status: 'answered' as const };

    it('reports the remaining time on success', async () => {
      repo.saveResponse.mockResolvedValue({ kind: 'ok', remainingMs: 61_500 });
      await expect(service.saveAnswer(tenantId, userId, sessionId, dto)).resolves.toEqual({ ok: true, remainingSeconds: 61 });
    });

    it('never reports success for a question that is not in the session', async () => {
      repo.saveResponse.mockResolvedValue({ kind: 'unknown_item' });
      expect(await codeOf(service.saveAnswer(tenantId, userId, sessionId, dto))).toBe('VALIDATION_FAILED');
    });

    it('refuses once the session is closed', async () => {
      repo.saveResponse.mockResolvedValue({ kind: 'closed', status: 'completed' });
      expect(await codeOf(service.saveAnswer(tenantId, userId, sessionId, dto))).toBe('SESSION_CLOSED');
    });

    it('closes and grades the paper when the deadline has passed, and says so', async () => {
      repo.saveResponse.mockResolvedValue({ kind: 'expired' });
      repo.finalize.mockResolvedValue({ kind: 'finalized', status: 'timed_out' });
      expect(await codeOf(service.saveAnswer(tenantId, userId, sessionId, dto))).toBe('TIME_EXPIRED');
      expect(repo.finalize).toHaveBeenCalledTimes(1);
    });

    it('does not reveal another student\'s session', async () => {
      repo.saveResponse.mockResolvedValue({ kind: 'not_found' });
      expect(await codeOf(service.saveAnswer(tenantId, userId, sessionId, dto))).toBe('NOT_FOUND');
    });

    it('refuses an oversized response before it reaches the database', async () => {
      const huge = { text: 'x'.repeat(30_000) };
      expect(await codeOf(service.saveAnswer(tenantId, userId, sessionId, { ...dto, response: huge }))).toBe('VALIDATION_FAILED');
      expect(repo.saveResponse).not.toHaveBeenCalled();
    });

    it('ignores any time the client claims: it is not passed on', async () => {
      repo.saveResponse.mockResolvedValue({ kind: 'ok', remainingMs: 1000 });
      await service.saveAnswer(tenantId, userId, sessionId, { ...dto, timeSpentSec: 999_999 });
      expect(repo.saveResponse).toHaveBeenCalledWith(tenantId, userId, sessionId, item.id, { response: dto.response, status: 'answered' });
    });
  });

  describe('focus (server-measured time)', () => {
    it('records the open question', async () => {
      repo.recordFocus.mockResolvedValue({ kind: 'ok', remainingMs: 10_000, activeItemId: item.id });
      await expect(service.focus(tenantId, userId, sessionId, item.id)).resolves.toEqual({ ok: true, remainingSeconds: 10 });
      expect(repo.recordFocus).toHaveBeenCalledWith(tenantId, userId, sessionId, item.id);
    });

    it.each([
      [{ kind: 'unknown_item' as const }, 'VALIDATION_FAILED'],
      [{ kind: 'closed' as const, status: 'completed' }, 'SESSION_CLOSED'],
      [{ kind: 'not_found' as const }, 'NOT_FOUND'],
    ])('maps %j to %s', async (outcome, code) => {
      repo.recordFocus.mockResolvedValue(outcome);
      expect(await codeOf(service.focus(tenantId, userId, sessionId, item.id))).toBe(code);
    });

    it('closes the paper when focus arrives after the deadline', async () => {
      repo.recordFocus.mockResolvedValue({ kind: 'expired' });
      repo.finalize.mockResolvedValue({ kind: 'finalized', status: 'timed_out' });
      expect(await codeOf(service.focus(tenantId, userId, sessionId, item.id))).toBe('TIME_EXPIRED');
      expect(repo.finalize).toHaveBeenCalledTimes(1);
    });
  });

  describe('submitTest', () => {
    it('closes once and returns the stored result; a repeated submit grades nothing again', async () => {
      const closed = sessionRow({ status: 'completed', totalScore: '4', correctCount: 1, accuracy: '100' });
      repo.finalize.mockResolvedValueOnce({ kind: 'finalized', status: 'completed' }).mockResolvedValueOnce({ kind: 'already', status: 'completed' });
      repo.loadSession.mockResolvedValue({ session: closed, dbNow: NOW });
      repo.getSessionStructure.mockResolvedValue(structure(closed));

      const first = await service.submitTest(tenantId, userId, sessionId);
      const second = await service.submitTest(tenantId, userId, sessionId);
      expect(second).toEqual(first);
      expect(first.status).toBe('completed');
    });

    it('does not reveal another student\'s session', async () => {
      repo.finalize.mockResolvedValue({ kind: 'not_found' });
      expect(await codeOf(service.submitTest(tenantId, 'someone-else', sessionId))).toBe('NOT_FOUND');
    });
  });

  describe('finalizeExpiredSessions', () => {
    it('closes every expired session, counts only those it actually closed and survives a failure', async () => {
      repo.findExpiredOpenSessions.mockResolvedValue([
        { id: 's1', tenantId },
        { id: 's2', tenantId },
        { id: 's3', tenantId },
      ]);
      repo.finalize
        .mockResolvedValueOnce({ kind: 'finalized', status: 'timed_out' })
        .mockRejectedValueOnce(new Error('deadlock detected'))
        .mockResolvedValueOnce({ kind: 'already', status: 'completed' });
      await expect(service.finalizeExpiredSessions()).resolves.toBe(1);
      expect(repo.finalize).toHaveBeenCalledTimes(3);
    });
  });
});
