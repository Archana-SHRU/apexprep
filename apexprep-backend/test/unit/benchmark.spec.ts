import { BenchmarkService } from '../../src/analytics/benchmark.service';
import type { BenchmarkRepository } from '../../src/analytics/benchmark.repository';
import type { EngineConfigService } from '../../src/engine-config/engine-config.service';
import type { AuthContext } from '../../src/common/auth/auth-context';

describe('BenchmarkService', () => {
  let service: BenchmarkService;
  let repo: jest.Mocked<BenchmarkRepository>;
  let engineConfig: jest.Mocked<EngineConfigService>;

  const auth: AuthContext = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'STUDENT',
    tokenVersion: 1,
    permissions: new Set(['practice:use', 'analytics:own']),
  };

  const subtopicId = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    repo = {
      isBenchmarkingEnabled: jest.fn().mockResolvedValue(true),
      getLatestSnapshot: jest.fn(),
      cohortAttempts: jest.fn(),
      saveSnapshot: jest.fn(),
    } as unknown as jest.Mocked<BenchmarkRepository>;

    engineConfig = {
      requireActive: jest.fn().mockResolvedValue({
        id: 'cfg-1',
        version: 1,
        params: {
          benchmark: {
            window_days: 90,
            min_qualifying_students: 30,
            top_k: 10,
          },
        },
      }),
    } as unknown as jest.Mocked<EngineConfigService>;

    service = new BenchmarkService(repo, engineConfig);
  });

  describe('getBenchmark (FR-10.2)', () => {
    it('returns disabled status if benchmarking is switched off for tenant', async () => {
      repo.isBenchmarkingEnabled.mockResolvedValueOnce(false);
      const res = await service.getBenchmark(auth, subtopicId);
      expect(res.isPublished).toBe(false);
      expect(res.message).toContain('disabled');
    });

    it('withholds values if qualifying cohort is below 30', async () => {
      repo.getLatestSnapshot.mockResolvedValueOnce({
        id: 'snap-1',
        tenantId: auth.tenantId,
        subtopicId,
        difficultyLabel: null,
        snapshotDate: '2026-10-06',
        windowDays: 90,
        windowStart: new Date(),
        windowEnd: new Date(),
        qualifyingStudents: 18,
        minQualifyingStudents: 30,
        topK: 10,
        isPublished: false,
        topAccuracy: null,
        topMedianTimeMs: null,
        engineConfigId: 'cfg-1',
        computedAt: new Date(),
        createdAt: new Date(),
      });

      const res = await service.getBenchmark(auth, subtopicId);
      expect(res.isPublished).toBe(false);
      expect(res.topAccuracy).toBeNull();
      expect(res.topMedianTimeSeconds).toBeNull();
      expect(res.message).toContain('at least 30 qualifying learners');
    });

    it('publishes top cohort benchmarks when cohort meets threshold', async () => {
      repo.getLatestSnapshot.mockResolvedValueOnce({
        id: 'snap-2',
        tenantId: auth.tenantId,
        subtopicId,
        difficultyLabel: null,
        snapshotDate: '2026-10-06',
        windowDays: 90,
        windowStart: new Date(),
        windowEnd: new Date(),
        qualifyingStudents: 42,
        minQualifyingStudents: 30,
        topK: 10,
        isPublished: true,
        topAccuracy: 0.895,
        topMedianTimeMs: 45000,
        engineConfigId: 'cfg-1',
        computedAt: new Date(),
        createdAt: new Date(),
      });

      const res = await service.getBenchmark(auth, subtopicId);
      expect(res.isPublished).toBe(true);
      expect(res.qualifyingStudents).toBe(42);
      expect(res.topAccuracy).toBe(0.895);
      expect(res.topMedianTimeSeconds).toBe(45);
    });
  });

  describe('compute', () => {
    it('computes top-10 accuracy and time for qualifying cohorts >= 30', async () => {
      const cohort = Array.from({ length: 35 }, (_, i) => ({
        userId: `user-${i}`,
        attemptCount: 10,
        correctCount: 8,
        accuracy: 0.8 + (i % 10) * 0.02,
        medianTimeMs: 30000 + i * 1000,
      }));

      repo.cohortAttempts.mockResolvedValueOnce(cohort);
      repo.saveSnapshot.mockImplementationOnce((snap) =>
        Promise.resolve({
          ...snap,
          id: 'new-snap',
          computedAt: new Date(),
          createdAt: new Date(),
        } as any),
      );

      const res = await service.compute(auth, { subtopicId });
      expect(res.isPublished).toBe(true);
      expect(res.qualifyingStudents).toBe(35);
      expect(res.topAccuracy).toBeGreaterThan(0.8);
      expect(repo.saveSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          isPublished: true,
          qualifyingStudents: 35,
          minQualifyingStudents: 30,
        }),
      );
    });

    it('withholds publication for cohort < 30', async () => {
      const cohort = Array.from({ length: 12 }, (_, i) => ({
        userId: `user-${i}`,
        attemptCount: 7,
        correctCount: 5,
        accuracy: 0.7,
        medianTimeMs: 40000,
      }));

      repo.cohortAttempts.mockResolvedValueOnce(cohort);
      repo.saveSnapshot.mockImplementationOnce((snap) =>
        Promise.resolve({
          ...snap,
          id: 'new-snap',
          computedAt: new Date(),
          createdAt: new Date(),
        } as any),
      );

      const res = await service.compute(auth, { subtopicId });
      expect(res.isPublished).toBe(false);
      expect(res.topAccuracy).toBeNull();
      expect(res.message).toContain('Under threshold');
      expect(repo.saveSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          isPublished: false,
          topAccuracy: null,
          topMedianTimeMs: null,
        }),
      );
    });
  });
});
