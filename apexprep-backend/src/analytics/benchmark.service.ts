import { Injectable, Logger } from '@nestjs/common';
import type { AuthContext } from '../common/auth/auth-context';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { BenchmarkRepository } from './benchmark.repository';
import type { BenchmarkDto, ComputeBenchmarkDto } from './dto/benchmark.dto';

@Injectable()
export class BenchmarkService {
  private readonly logger = new Logger(BenchmarkService.name);

  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly engineConfig: EngineConfigService,
  ) {}

  /**
   * Reads anonymous peer benchmarks for a student on a specific sub-topic.
   * Enforces FR-10.2: Withholds benchmark figures when qualifying cohort is below 30 students.
   */
  async getBenchmark(auth: AuthContext, subtopicId: string): Promise<BenchmarkDto> {
    const enabled = await this.repo.isBenchmarkingEnabled(auth.tenantId);
    if (!enabled) {
      return {
        subtopicId,
        isPublished: false,
        qualifyingStudents: 0,
        minQualifyingStudents: 30,
        topK: 10,
        topAccuracy: null,
        topMedianTimeSeconds: null,
        snapshotDate: null,
        message: 'Anonymous benchmarking is disabled for this organization.',
      };
    }

    const snapshot = await this.repo.getLatestSnapshot(auth.tenantId, subtopicId);
    if (!snapshot) {
      return {
        subtopicId,
        isPublished: false,
        qualifyingStudents: 0,
        minQualifyingStudents: 30,
        topK: 10,
        topAccuracy: null,
        topMedianTimeSeconds: null,
        snapshotDate: null,
        message: 'No peer benchmark snapshot computed for this subtopic yet.',
      };
    }

    if (!snapshot.isPublished) {
      return {
        subtopicId,
        isPublished: false,
        qualifyingStudents: snapshot.qualifyingStudents,
        minQualifyingStudents: snapshot.minQualifyingStudents,
        topK: snapshot.topK,
        topAccuracy: null,
        topMedianTimeSeconds: null,
        snapshotDate: snapshot.snapshotDate,
        message: `Peer benchmark is withheld: requires at least ${snapshot.minQualifyingStudents} qualifying learners (currently ${snapshot.qualifyingStudents}).`,
      };
    }

    return {
      subtopicId,
      isPublished: true,
      qualifyingStudents: snapshot.qualifyingStudents,
      minQualifyingStudents: snapshot.minQualifyingStudents,
      topK: snapshot.topK,
      topAccuracy: snapshot.topAccuracy !== null ? Number(snapshot.topAccuracy) : null,
      topMedianTimeSeconds: snapshot.topMedianTimeMs !== null ? Math.round(snapshot.topMedianTimeMs / 1000) : null,
      snapshotDate: snapshot.snapshotDate,
    };
  }

  /**
   * Computes an anonymous peer benchmark snapshot over a rolling window.
   */
  async compute(auth: AuthContext, dto: ComputeBenchmarkDto): Promise<BenchmarkDto> {
    const active = await this.engineConfig.requireActive(auth.tenantId);
    const windowDays = dto.windowDays ?? (active.params.benchmark?.window_days ?? 90);
    const minQualifying = active.params.benchmark?.min_qualifying_students ?? 30;
    const topK = active.params.benchmark?.top_k ?? 10;

    const now = new Date();
    const snapshotDate = dto.snapshotDate ?? now.toISOString().slice(0, 10);
    const windowEnd = now;
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const cohort = await this.repo.cohortAttempts(auth.tenantId, dto.subtopicId, windowStart, windowEnd);
    const qualifyingCount = cohort.length;

    const isPublished = qualifyingCount >= minQualifying && qualifyingCount >= topK;

    let topAccuracy: number | null = null;
    let topMedianTimeMs: number | null = null;

    if (isPublished) {
      // Sort by accuracy descending, then faster pace ascending
      const sorted = [...cohort].sort((a, b) => {
        if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
        return a.medianTimeMs - b.medianTimeMs;
      });
      const topCohort = sorted.slice(0, topK);
      topAccuracy = Math.round((topCohort.reduce((acc, s) => acc + s.accuracy, 0) / topCohort.length) * 10000) / 10000;
      topMedianTimeMs = Math.round(topCohort.reduce((acc, s) => acc + s.medianTimeMs, 0) / topCohort.length);
    }

    const saved = await this.repo.saveSnapshot({
      tenantId: auth.tenantId,
      subtopicId: dto.subtopicId,
      difficultyLabel: null,
      snapshotDate,
      windowDays,
      windowStart,
      windowEnd,
      qualifyingStudents: qualifyingCount,
      minQualifyingStudents: minQualifying,
      topK,
      isPublished,
      topAccuracy,
      topMedianTimeMs,
      engineConfigId: active.id,
    });

    return {
      subtopicId: dto.subtopicId,
      isPublished: saved.isPublished,
      qualifyingStudents: saved.qualifyingStudents,
      minQualifyingStudents: saved.minQualifyingStudents,
      topK: saved.topK,
      topAccuracy: saved.topAccuracy !== null ? Number(saved.topAccuracy) : null,
      topMedianTimeSeconds: saved.topMedianTimeMs !== null ? Math.round(saved.topMedianTimeMs / 1000) : null,
      snapshotDate: saved.snapshotDate,
      message: isPublished ? undefined : `Under threshold: ${qualifyingCount}/${minQualifying} qualifying students`,
    };
  }
}
