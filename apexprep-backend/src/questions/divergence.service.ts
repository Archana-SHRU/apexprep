import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { DRIZZLE, type Database } from '../database/database.module';
import { questions, reviewTasks } from '../database/schema';
import type { CheckDivergenceDto, DivergenceCheckResultDto, QuestionDivergenceItemDto } from './dto/divergence.dto';

const INITIAL_B_BY_LEVEL: Record<number, number> = {
  1: 800,
  2: 1000,
  3: 1200,
  4: 1400,
  5: 1600,
};

function suggestedLevelForB(b: number): number {
  if (b < 900) return 1;
  if (b < 1100) return 2;
  if (b < 1300) return 3;
  if (b < 1500) return 4;
  return 5;
}

@Injectable()
export class DivergenceService {
  private readonly logger = new Logger(DivergenceService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Scans questions where calibration sample size >= minCalibrations (default 30).
   * Identifies questions where empirical observed difficulty B diverges from the assigned L-label
   * by more than the threshold (default 250 Elo points).
   * Opens teacher review tasks rather than silently overwriting teacher judgement (FR-6.6 / E3).
   */
  async checkDivergence(auth: AuthContext, dto: CheckDivergenceDto): Promise<DivergenceCheckResultDto> {
    const threshold = dto.threshold ?? 250;
    const minCalibrations = dto.minCalibrations ?? 30;

    const candidateQuestions = await this.db
      .select({
        id: questions.id,
        stem: questions.stem,
        difficultyLabel: questions.difficultyLabel,
        difficultyB: questions.difficultyB,
        calibrationN: questions.calibrationN,
      })
      .from(questions)
      .where(
        and(
          eq(questions.tenantId, auth.tenantId),
          eq(questions.status, 'published'),
          isNull(questions.deletedAt),
          gte(questions.calibrationN, minCalibrations),
        ),
      );

    const divergences: QuestionDivergenceItemDto[] = [];
    let tasksOpened = 0;

    for (const q of candidateQuestions) {
      const observedB = Number(q.difficultyB);
      const expectedB = INITIAL_B_BY_LEVEL[q.difficultyLabel] ?? 1000;
      const delta = Math.round(Math.abs(observedB - expectedB) * 100) / 100;

      if (delta >= threshold) {
        const suggestedLabel = suggestedLevelForB(observedB);

        // Check if an open review task already exists for this question
        const [existingTask] = await this.db
          .select({ id: reviewTasks.id })
          .from(reviewTasks)
          .where(
            and(
              eq(reviewTasks.tenantId, auth.tenantId),
              eq(reviewTasks.questionId, q.id),
              eq(reviewTasks.kind, 'question_review'),
              eq(reviewTasks.status, 'open'),
            ),
          )
          .limit(1);

        let reviewTaskId: string | null = existingTask?.id ?? null;

        if (!existingTask) {
          const [newTask] = await this.db
            .insert(reviewTasks)
            .values({
              tenantId: auth.tenantId,
              kind: 'question_review',
              status: 'open',
              priority: 2,
              questionId: q.id,
              reason: `Empirical difficulty diverged by ${delta} Elo points from assigned L${q.difficultyLabel} (observed θ=${observedB}, suggested L${suggestedLabel})`,
              suggestion: {
                trigger: 'divergence',
                observedB,
                expectedB,
                currentLabel: q.difficultyLabel,
                suggestedLabel,
                calibrationN: q.calibrationN,
                delta,
              },
            })
            .returning({ id: reviewTasks.id });

          reviewTaskId = newTask?.id ?? null;
          tasksOpened += 1;

          await this.audit.record({
            tenantId: auth.tenantId,
            action: 'questions.divergence_flagged',
            entityType: 'question',
            entityId: q.id,
            after: {
              reviewTaskId,
              currentLabel: q.difficultyLabel,
              suggestedLabel,
              observedB,
              expectedB,
              delta,
              calibrationN: q.calibrationN,
            },
          });
        }

        divergences.push({
          questionId: q.id,
          stem: q.stem.slice(0, 150),
          currentLabel: q.difficultyLabel,
          suggestedLabel,
          observedB,
          expectedB,
          delta,
          calibrationN: q.calibrationN,
          reviewTaskId,
        });
      }
    }

    this.logger.log(
      `Divergence check evaluated ${candidateQuestions.length} questions, found ${divergences.length} divergences, opened ${tasksOpened} new review tasks`,
    );

    return {
      scannedCount: candidateQuestions.length,
      divergingCount: divergences.length,
      tasksOpened,
      divergences,
    };
  }
}
