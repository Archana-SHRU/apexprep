import { Inject, Injectable } from '@nestjs/common';
import type { EngineParams } from '../adaptive';
import { DRIZZLE, type Database } from '../database/database.module';
import type { AbilityScoreRow } from '../database/schema';
import { EngineConfigService } from '../engine-config/engine-config.service';
import { replayAbility, type ReplayResult } from './ability-replay';
import { PracticeRepository } from './practice.repository';

export interface RebuildOutcome extends ReplayResult {
  /** The projection as stored, before the rebuild (null when there is no row). */
  stored: AbilityScoreRow | null;
  /** Columns where the stored projection and the replay disagree. */
  differences: string[];
  /** True when the rebuild was written back. */
  written: boolean;
}

/**
 * Rebuilds `ability_scores` from the immutable `attempts` rows.
 *
 * This exists to keep the projection honest: it is a cache of a replay, so it must be
 * possible to throw it away and recompute it. Use it to repair a row after an incident, to
 * migrate a history onto new engine parameters, or (as the test suite does) to prove that
 * nothing in the projection is authoritative.
 *
 * Tenant isolation is the same as everywhere else: every read is keyed on `tenant_id`, so a
 * rebuild can only ever see the attempts of the organisation it was asked about.
 */
@Injectable()
export class AbilityRebuildService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: PracticeRepository,
    private readonly engineConfig: EngineConfigService,
  ) {}

  /**
   * Replays one student's history in one sub-topic and compares it with the stored row.
   * With `write: true` the replayed values replace the stored ones, in one transaction.
   */
  async rebuild(
    tenantId: string,
    userId: string,
    subtopicId: string,
    options: { write?: boolean } = {},
  ): Promise<RebuildOutcome> {
    return this.db.transaction(async (tx) => {
      const [history, stored] = await Promise.all([
        this.repo.attemptsForReplay(tenantId, userId, subtopicId, tx),
        this.repo.findAbility(tenantId, userId, subtopicId, tx, options.write === true),
      ]);
      if (history.length === 0) {
        throw new Error('nothing to replay: this student has no attempts in this sub-topic');
      }

      const params = await this.paramsByConfigId(tenantId, history.map((a) => a.engineConfigId));
      const result = replayAbility(history, (id) => {
        const found = params.get(id);
        if (!found) throw new Error(`engine configuration ${id} is referenced by an attempt but could not be loaded`);
        return found;
      });

      const differences = stored ? this.compare(stored, result) : ['(no stored row)'];
      if (options.write !== true || !stored) return { ...result, stored: stored ?? null, differences, written: false };

      await this.repo.updateAbility(
        tenantId,
        stored.id,
        {
          theta: result.ability.theta,
          level: result.ability.level,
          attemptsCount: result.ability.attemptsCount,
          gradedCount: result.ability.gradedCount,
          correctCount: result.ability.correctCount,
          consecutiveCorrect: result.ability.consecutiveCorrect,
          consecutiveIncorrect: result.ability.consecutiveIncorrect,
          placementAnswered: result.ability.placementAnswered,
          placementStatus: result.ability.placementStatus,
          ladderResetAt: result.ability.ladderResetAt,
          lastAttemptId: result.ability.lastAttemptId,
          lastAttemptAt: result.ability.lastAttemptAt,
          ...(result.ability.engineConfigId ? { engineConfigId: result.ability.engineConfigId } : {}),
        },
        tx,
      );
      return { ...result, stored, differences, written: true };
    });
  }

  // ---------------------------------------------------------------- internals

  /** Every engine configuration the history refers to, parsed once each. */
  private async paramsByConfigId(tenantId: string, ids: readonly string[]): Promise<Map<string, EngineParams>> {
    const out = new Map<string, EngineParams>();
    for (const id of new Set(ids)) out.set(id, await this.engineConfig.paramsForVersion(tenantId, id));
    return out;
  }

  /** Column names where the stored projection differs from the replay. */
  private compare(stored: AbilityScoreRow, result: ReplayResult): string[] {
    const replayed = result.ability;
    const pairs: [string, unknown, unknown][] = [
      ['theta', stored.theta, replayed.theta],
      ['level', stored.level, replayed.level],
      ['attempts_count', stored.attemptsCount, replayed.attemptsCount],
      ['graded_count', stored.gradedCount, replayed.gradedCount],
      ['correct_count', stored.correctCount, replayed.correctCount],
      ['consecutive_correct', stored.consecutiveCorrect, replayed.consecutiveCorrect],
      ['consecutive_incorrect', stored.consecutiveIncorrect, replayed.consecutiveIncorrect],
      ['placement_answered', stored.placementAnswered, replayed.placementAnswered],
      ['placement_status', stored.placementStatus, replayed.placementStatus],
      ['last_attempt_id', stored.lastAttemptId, replayed.lastAttemptId],
      ['ladder_reset_at', stored.ladderResetAt?.getTime() ?? null, replayed.ladderResetAt?.getTime() ?? null],
    ];
    return pairs.filter(([, a, b]) => a !== b).map(([column]) => column);
  }
}
