import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module';
import { benchmarkSnapshots, type BenchmarkSnapshotRow, type NewBenchmarkSnapshot } from '../database/schema/analytics';
import { tenants } from '../database/schema/tenants';

export interface StudentCohortSummary {
  userId: string;
  attemptCount: number;
  correctCount: number;
  accuracy: number;
  medianTimeMs: number;
}

@Injectable()
export class BenchmarkRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async isBenchmarkingEnabled(tenantId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ benchmarkingEnabled: tenants.benchmarkingEnabled })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return row?.benchmarkingEnabled ?? true;
  }

  async getLatestSnapshot(tenantId: string, subtopicId: string): Promise<BenchmarkSnapshotRow | undefined> {
    const [row] = await this.db
      .select()
      .from(benchmarkSnapshots)
      .where(
        and(
          eq(benchmarkSnapshots.tenantId, tenantId),
          eq(benchmarkSnapshots.subtopicId, subtopicId),
        ),
      )
      .orderBy(desc(benchmarkSnapshots.snapshotDate))
      .limit(1);
    return row;
  }

  /**
   * Aggregates student attempts for this subtopic in the window.
   * Returns per-user metrics for students with at least 5 attempts (qualifying threshold).
   */
  async cohortAttempts(tenantId: string, subtopicId: string, since: Date, until: Date): Promise<StudentCohortSummary[]> {
    const rows = await this.db.execute<{
      user_id: string;
      attempt_count: number | string;
      correct_count: number | string;
      accuracy: number | string;
      median_time_ms: number | string;
    }>(sql`
      SELECT
        a.user_id,
        COUNT(*)::int AS attempt_count,
        COUNT(*) FILTER (WHERE a.outcome = 'correct')::int AS correct_count,
        ROUND((COUNT(*) FILTER (WHERE a.outcome = 'correct')::numeric / NULLIF(COUNT(*) FILTER (WHERE a.outcome IN ('correct', 'incorrect')), 0)), 4) AS accuracy,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.total_time_ms)::int AS median_time_ms
      FROM attempts a
      JOIN questions q ON q.tenant_id = a.tenant_id AND q.id = a.question_id
      WHERE a.tenant_id = ${tenantId}
        AND q.primary_subtopic_id = ${subtopicId}
        AND a.created_at >= ${since}
        AND a.created_at <= ${until}
        AND a.outcome IN ('correct', 'incorrect')
      GROUP BY a.user_id
      HAVING COUNT(*) >= 5
    `);

    return rows.rows.map((r) => ({
      userId: r.user_id,
      attemptCount: Number(r.attempt_count),
      correctCount: Number(r.correct_count),
      accuracy: Number(r.accuracy ?? 0),
      medianTimeMs: Number(r.median_time_ms ?? 0),
    }));
  }

  async saveSnapshot(data: NewBenchmarkSnapshot): Promise<BenchmarkSnapshotRow> {
    const [row] = await this.db
      .insert(benchmarkSnapshots)
      .values(data)
      .onConflictDoUpdate({
        target: [
          benchmarkSnapshots.tenantId,
          benchmarkSnapshots.subtopicId,
          benchmarkSnapshots.difficultyLabel,
          benchmarkSnapshots.snapshotDate,
        ],
        set: {
          qualifyingStudents: data.qualifyingStudents,
          minQualifyingStudents: data.minQualifyingStudents,
          topK: data.topK,
          isPublished: data.isPublished,
          topAccuracy: data.topAccuracy,
          topMedianTimeMs: data.topMedianTimeMs,
          engineConfigId: data.engineConfigId,
          computedAt: sql`now()`,
        },
      })
      .returning();
    return row!;
  }
}
