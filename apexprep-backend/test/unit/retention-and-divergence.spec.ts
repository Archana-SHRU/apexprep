import { RetentionService } from '../../src/common/maintenance/retention.service';
import { DivergenceService } from '../../src/questions/divergence.service';
import type { AuthContext } from '../../src/common/auth/auth-context';

describe('Retention and Divergence Services', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const auth: AuthContext = {
    tenantId,
    userId: 'admin-user',
    role: 'SUPER_ADMIN',
    tokenVersion: 1,
    permissions: new Set(['engine_config:manage', 'questions:manage']),
  };

  describe('RetentionService (§15.2 / E5)', () => {
    it('executes purge query and records audit log for events older than threshold', async () => {
      const mockExecute = jest.fn().mockResolvedValue({
        rows: [{ count: 142 }],
      });
      const mockAudit = { record: jest.fn().mockResolvedValue(undefined) };

      const service = new RetentionService({ execute: mockExecute } as any, mockAudit as any);
      const res = await service.purgeOldSessionEvents(auth, 365);

      expect(res.purgedCount).toBe(142);
      expect(res.tenantId).toBe(tenantId);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          action: 'maintenance.session_events_purged',
          after: expect.objectContaining({
            olderThanDays: 365,
            purgedCount: 142,
          }),
        }),
      );
    });
  });

  describe('DivergenceService (FR-6.6 / E3)', () => {
    it('identifies questions diverging from teacher L-label by >= 250 Elo points and opens review tasks', async () => {
      const mockAudit = { record: jest.fn().mockResolvedValue(undefined) };

      // Candidate questions in DB
      const candidateQuestions = [
        // Question 1: L1 (expected 800), observed 1250 (delta = 450 >= 250) -> Diverges!
        {
          id: 'q-1',
          stem: 'What is angular velocity?',
          difficultyLabel: 1,
          difficultyB: 1250,
          calibrationN: 45,
        },
        // Question 2: L3 (expected 1200), observed 1220 (delta = 20 < 250) -> Normal
        {
          id: 'q-2',
          stem: 'Compute moment of inertia',
          difficultyLabel: 3,
          difficultyB: 1220,
          calibrationN: 50,
        },
      ];

      const mockSelect = jest.fn();
      // First select: candidate questions
      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValueOnce({
          where: jest.fn().mockResolvedValueOnce(candidateQuestions),
        }),
      });
      // Second select: check existing task for q-1
      mockSelect.mockReturnValueOnce({
        from: jest.fn().mockReturnValueOnce({
          where: jest.fn().mockReturnValueOnce({
            limit: jest.fn().mockResolvedValueOnce([]), // no existing task
          }),
        }),
      });

      const mockInsert = jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValueOnce([{ id: 'task-new-1' }]),
        }),
      });

      const db = {
        select: mockSelect,
        insert: mockInsert,
      };

      const service = new DivergenceService(db as any, mockAudit as any);
      const res = await service.checkDivergence(auth, { threshold: 250, minCalibrations: 30 });

      expect(res.scannedCount).toBe(2);
      expect(res.divergingCount).toBe(1);
      expect(res.tasksOpened).toBe(1);
      expect(res.divergences[0]).toEqual(
        expect.objectContaining({
          questionId: 'q-1',
          currentLabel: 1,
          suggestedLabel: 3,
          observedB: 1250,
          expectedB: 800,
          delta: 450,
          reviewTaskId: 'task-new-1',
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'questions.divergence_flagged',
          entityId: 'q-1',
        }),
      );
    });
  });
});
