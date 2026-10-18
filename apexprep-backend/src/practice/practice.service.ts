import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  applyInactivityDecay,
  coldStartLevel,
  coldStartTheta,
  fallbackSelection,
  levelForTheta,
  parentTopicTheta,
  selectNextQuestion,
  type Candidate,
  type EngineParams,
  type Selection,
  type SelectionState,
} from '../adaptive';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { sessions, type AbilityScoreRow, type SessionRow } from '../database/schema';
import { EngineConfigService, type ActiveEngineConfig } from '../engine-config/engine-config.service';
import { QuestionsService } from '../questions/questions.service';
import { SyllabusRepository } from '../syllabus/syllabus.repository';
import { TenantsRepository } from '../tenants/tenants.repository';
import { UsersRepository } from '../users/users.repository';
import type {
  ContentGapDto,
  CreatePracticeSessionDto,
  EndSessionDto,
  NextQuestionDto,
  PracticeSessionDto,
  RevealHintDto,
  RevealedHintDto,
  SessionEventsResultDto,
  SessionStartDto,
  StudentProgressDto,
  SubmitSessionEventsDto,
} from './dto/practice.dto';
import { PracticeRepository } from './practice.repository';

/**
 * The student practice flow: open a session, get the next question, close the session.
 *
 * Everything adaptive is decided by the Phase 4 engine in `src/adaptive/` — this service
 * loads state, hands it to those pure functions, and writes the result. No threshold or
 * rule is re-implemented here; every number comes from the active `engine_config` version.
 */
@Injectable()
export class PracticeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: PracticeRepository,
    private readonly syllabus: SyllabusRepository,
    private readonly engineConfig: EngineConfigService,
    private readonly questions: QuestionsService,
    private readonly tenants: TenantsRepository,
    private readonly users: UsersRepository,
  ) {}

  // ---------------------------------------------------------------- sessions

  async createSession(auth: AuthContext, dto: CreatePracticeSessionDto): Promise<SessionStartDto> {
    await this.requireVisibleSubtopic(auth, dto.subtopicId);
    const config = await this.engineConfig.requireActive(auth.tenantId);
    const focusTrackingEnabled = await this.focusTrackingFor(auth);

    return this.db.transaction(async (tx) => {
      const open = await this.repo.findActiveSession(auth.tenantId, auth.userId, dto.subtopicId, tx);
      if (open) {
        const ability = await this.requireAbility(auth, dto.subtopicId, config, tx);
        return { session: await this.toSessionDto(open, { resumed: true }, config.params, tx), progress: toProgressDto(ability), decayApplied: 0 };
      }

      const { ability, decayApplied } = await this.abilityForSession(auth, dto.subtopicId, config, tx);
      const inPlacement = config.params.placement.enabled && ability.placementStatus !== 'completed' && ability.placementStatus !== 'skipped';

      const session = await this.repo.insertSession(
        {
          tenantId: auth.tenantId,
          userId: auth.userId,
          subtopicId: dto.subtopicId,
          mode: inPlacement ? 'placement' : 'adaptive',
          engineConfigId: config.id,
          focusTrackingEnabled,
          deviceType: dto.deviceType ?? 'unknown',
          targetQuestionCount: dto.targetQuestionCount ?? null,
        },
        tx,
      );

      let current = ability;
      if (inPlacement && ability.placementStatus === 'not_started') {
        current = (await this.repo.updateAbility(auth.tenantId, ability.id, { placementStatus: 'in_progress' }, tx)) ?? ability;
      }
      return { session: await this.toSessionDto(session, { resumed: false }, config.params, tx), progress: toProgressDto(current), decayApplied };
    });
  }

  async getSession(auth: AuthContext, sessionId: string): Promise<PracticeSessionDto> {
    const session = await this.repo.findSession(auth.tenantId, auth.userId, sessionId);
    if (!session) throw AppException.notFound('Practice session not found');
    return this.toSessionDto(session, { resumed: false });
  }

  async endSession(auth: AuthContext, sessionId: string, dto: EndSessionDto): Promise<PracticeSessionDto> {
    return this.db.transaction(async (tx) => {
      const session = await this.repo.findSession(auth.tenantId, auth.userId, sessionId, tx, true);
      if (!session) throw AppException.notFound('Practice session not found');
      if (session.status !== 'active') throw AppException.conflict(`This session is already ${session.status}`, 'INVALID_STATE');

      const outstanding = await this.repo.findOutstandingItem(auth.tenantId, sessionId, tx);
      if (outstanding) await this.repo.updateItem(auth.tenantId, outstanding.id, { status: 'abandoned' }, tx);

      const updated = await this.repo.updateSession(
        auth.tenantId,
        sessionId,
        { status: dto.status ?? 'completed', endedAt: sql`now()`, lastActivityAt: sql`now()` },
        tx,
      );
      return this.toSessionDto(updated ?? session, { resumed: false }, undefined, tx);
    });
  }

  // ---------------------------------------------------------------- next question

  /**
   * Serves the next question. Calling it again without answering returns the same question
   * (so a refresh cannot skip one); `skip = true` marks the outstanding one skipped first,
   * which the exclusion rules then take into account.
   */
  async nextQuestion(auth: AuthContext, sessionId: string, options: { skip?: boolean } = {}): Promise<NextQuestionDto> {
    const config = await this.engineConfig.requireActive(auth.tenantId);
    const params = config.params;

    const served = await this.db.transaction(async (tx) => {
      const session = await this.repo.findSession(auth.tenantId, auth.userId, sessionId, tx, true);
      if (!session) throw AppException.notFound('Practice session not found');
      if (session.status !== 'active') throw AppException.conflict(`This session is ${session.status}`, 'INVALID_STATE');

      const flaggedGuesses = await this.repo.countProbableGuesses(auth.tenantId, sessionId, tx);
      if (flaggedGuesses >= params.probable_guess.pause_session_after) {
        throw AppException.conflict(
          `This session is paused after ${flaggedGuesses} rushed answers. Take a break and start a new session when you are ready.`,
          'SESSION_PAUSED',
        );
      }

      const outstanding = await this.repo.findOutstandingItem(auth.tenantId, sessionId, tx);
      if (outstanding && options.skip !== true) {
        const ability = await this.requireAbility(auth, session.subtopicId, config, tx);
        return { session, item: outstanding, ability, contentGap: undefined as ContentGapDto | undefined };
      }
      if (outstanding) await this.repo.updateItem(auth.tenantId, outstanding.id, { status: 'skipped' }, tx);

      const ability = await this.requireAbility(auth, session.subtopicId, config, tx);
      const now = new Date();
      const state: SelectionState = {
        position: session.servedCount + 1,
        theta: ability.theta,
        level: ability.level,
        attemptsInSubtopic: ability.gradedCount,
        seenDuplicateGroups: await this.repo.seenDuplicateGroups(
          auth.tenantId,
          auth.userId,
          new Date(now.getTime() - params.near_duplicate.exclude_days * 24 * 60 * 60 * 1000),
          tx,
        ),
        now,
      };

      // 1. the sub-topic's own pool
      let pool = await this.repo.candidatePool(auth.tenantId, auth.userId, [session.subtopicId], tx);
      let result = selectNextQuestion(state, pool, params);
      let widened = false;

      // 2. widen to the parent topic when the engine says the pool is too thin
      if ((result.exhausted || result.widenToParentTopic) && params.content_gap.widen_to_topic) {
        const siblings = await this.repo.siblingSubtopicIds(auth.tenantId, session.subtopicId, tx);
        if (siblings.length > 1) {
          // Only the *other* sub-topics: `siblings` includes this one, and querying the whole set
          // would re-read every row already in `pool` — each with its two per-question laterals over
          // `attempts` and `session_items`, the most expensive part of serving a question. The pool
          // is a pure per-question projection (no ORDER BY, no LIMIT, no cross-row aggregate), so
          // concatenating is exactly the set the single query returned, and selection breaks ties on
          // question id rather than on position, so the choice is unchanged either way.
          const others = siblings.filter((id) => id !== session.subtopicId);
          const widePool = [...pool, ...(await this.repo.candidatePool(auth.tenantId, auth.userId, others, tx))];
          const wideResult = selectNextQuestion(state, widePool, params);
          if (wideResult.selection && (!result.selection || wideResult.eligibleCount > result.eligibleCount)) {
            pool = widePool;
            result = { ...wideResult, contentGap: result.contentGap || wideResult.contentGap };
            widened = true;
          }
        }
      }

      // 3. the sub-topic is exhausted: serve the least recently seen question, labelled as such
      let selection: Selection | null = result.selection;
      if (!selection) selection = fallbackSelection(pool, state, params);
      if (!selection) {
        throw AppException.conflict(
          'This sub-topic has no published questions yet, so there is nothing to practise',
          'NO_ELIGIBLE_QUESTIONS',
        );
      }

      if (result.contentGap && params.content_gap.open_review_task) {
        await this.repo.openContentGapTask(auth.tenantId, session.subtopicId, tx);
      }

      const item = await this.repo.insertItem(
        {
          tenantId: auth.tenantId,
          sessionId: session.id,
          userId: auth.userId,
          subtopicId: session.subtopicId,
          questionId: selection.questionId,
          position: session.servedCount + 1,
          selectionReason: selection.reason,
          difficultyBAtServe: selection.difficultyBAtServe,
          thetaAtServe: selection.thetaAtServe,
          targetB: selection.targetB,
        },
        tx,
      );
      const updatedSession = await this.repo.updateSession(
        auth.tenantId,
        session.id,
        { servedCount: sql`${sessions.servedCount} + 1`, lastActivityAt: sql`now()` },
        tx,
      );

      return {
        session: updatedSession ?? session,
        item,
        ability,
        contentGap: result.contentGap
          ? { eligibleCount: result.eligibleCount, minEligible: params.content_gap.min_eligible, widenedToParentTopic: widened }
          : undefined,
      };
    });

    const question = await this.questions.studentView(auth.tenantId, served.item.questionId);
    return {
      item: {
        id: served.item.id,
        position: served.item.position,
        selectionReason: served.item.selectionReason,
        servedAt: served.item.servedAt.toISOString(),
      },
      question,
      session: await this.toSessionDto(served.session, { resumed: false }, params),
      progress: toProgressDto(served.ability),
      ...(served.contentGap ? { contentGap: served.contentGap } : {}),
    };
  }

  // ---------------------------------------------------------------- focus events

  async recordEvents(auth: AuthContext, sessionId: string, dto: SubmitSessionEventsDto): Promise<SessionEventsResultDto> {
    const session = await this.repo.findSession(auth.tenantId, auth.userId, sessionId);
    if (!session) throw AppException.notFound('Practice session not found');
    if (!session.focusTrackingEnabled) {
      throw AppException.conflict('Focus tracking is switched off for this session, so no events are stored', 'CONFLICT');
    }

    // One query for every item the batch names, rather than one per event.
    const itemIds = [...new Set(dto.events.map((e) => e.sessionItemId).filter((id): id is string => Boolean(id)))];
    const known = await this.repo.itemIdsInSession(auth.tenantId, sessionId, itemIds);
    if (known.size !== itemIds.length) {
      throw AppException.unprocessable('Unknown served item', 'REFERENCE_NOT_FOUND', [
        { field: 'events[].sessionItemId', message: 'not part of this session' },
      ]);
    }

    const accepted = await this.repo.insertEvents(
      dto.events.map((e) => ({
        tenantId: auth.tenantId,
        sessionId,
        userId: auth.userId,
        subtopicId: session.subtopicId,
        sessionItemId: e.sessionItemId ?? null,
        clientEventId: e.clientEventId,
        eventType: e.eventType,
        occurredAt: new Date(e.occurredAt),
        durationMs: e.durationMs ?? null,
      })),
    );
    return { accepted, received: dto.events.length };
  }

  // ---------------------------------------------------------------- shared

  /** The ability row, creating it on a cold start and decaying it after a long absence. */
  async abilityForSession(
    auth: AuthContext,
    subtopicId: string,
    config: ActiveEngineConfig,
    tx: Executor,
  ): Promise<{ ability: AbilityScoreRow; decayApplied: number }> {
    const existing = await this.repo.findAbility(auth.tenantId, auth.userId, subtopicId, tx, true);
    if (!existing) {
      const siblings = await this.repo.siblingThetas(auth.tenantId, auth.userId, subtopicId, tx);
      const parentTheta = parentTopicTheta(siblings);
      const theta = coldStartTheta(config.params, parentTheta);
      const ability = await this.repo.insertAbility(
        {
          tenantId: auth.tenantId,
          userId: auth.userId,
          subtopicId,
          theta,
          level: coldStartLevel(config.params, parentTheta),
          engineConfigId: config.id,
        },
        tx,
      );
      return { ability, decayApplied: 0 };
    }

    if (!existing.lastAttemptAt) return { ability: existing, decayApplied: 0 };
    // Decay is computed from the last *attempt*, so applying it twice for the same absence
    // would subtract the same points twice — and this runs on every session open and every
    // /next. One application per absence; answering a question is what arms it again
    // (DECISIONS.md §C, Phase 5). `inactivity_decay` beyond "after 21 days" is NOT SPECIFIED,
    // so this is the conservative reading: a student is never charged twice for one absence.
    if (existing.lastDecayAppliedAt && existing.lastDecayAppliedAt > existing.lastAttemptAt) {
      return { ability: existing, decayApplied: 0 };
    }
    const decay = applyInactivityDecay({ theta: existing.theta, lastPracticedAt: existing.lastAttemptAt, now: new Date() }, config.params);
    if (decay.decayed === 0) return { ability: existing, decayApplied: 0 };

    const decayed = await this.repo.updateAbility(
      auth.tenantId,
      existing.id,
      { theta: decay.theta, level: levelForTheta(decay.theta, config.params), lastDecayAppliedAt: sql`now()` },
      tx,
    );
    return { ability: decayed ?? existing, decayApplied: decay.decayed };
  }

  private async requireAbility(auth: AuthContext, subtopicId: string, config: ActiveEngineConfig, tx: Executor): Promise<AbilityScoreRow> {
    return (await this.abilityForSession(auth, subtopicId, config, tx)).ability;
  }

  private async requireVisibleSubtopic(auth: AuthContext, subtopicId: string): Promise<void> {
    const found = await this.syllabus.ancestry('subtopic', auth.tenantId, subtopicId, 'published');
    if (!found) throw AppException.notFound('Sub-topic not found');
  }

  /** Focus tracking is on only when the organisation allows it and the student has not opted out. */
  private async focusTrackingFor(auth: AuthContext): Promise<boolean> {
    const [tenant, user] = await Promise.all([this.tenants.findById(auth.tenantId), this.users.findById(auth.tenantId, auth.userId)]);
    return Boolean(tenant?.focusTrackingEnabled) && !user?.focusTrackingOptOut;
  }

  /**
   * The session as a client sees it.
   *
   * `params` and `tx` are not optional conveniences — they are what keeps this method from opening
   * a second pooled connection while its caller holds a transaction. Three of the call sites are
   * inside one, and with a pool of ten, ten concurrent session opens each holding one client and
   * waiting for another is mutual starvation until the statement timeout fires. Passing the
   * transaction also means the guess count is read in the caller's snapshot rather than outside it.
   *
   * `params` likewise: every caller already holds the active engine configuration, and re-reading
   * it here cost a second query plus a full zod validation of every adaptive tunable per request.
   */
  async toSessionDto(
    session: SessionRow,
    opts: { resumed: boolean },
    params?: EngineParams,
    tx: Executor = this.db,
  ): Promise<PracticeSessionDto> {
    const limit =
      params?.probable_guess.pause_session_after ??
      (await this.engineConfig.requireActive(session.tenantId)).params.probable_guess.pause_session_after;
    const flagged = await this.repo.countProbableGuesses(session.tenantId, session.id, tx);
    return {
      id: session.id,
      subtopicId: session.subtopicId,
      mode: session.mode,
      status: session.status,
      servedCount: session.servedCount,
      answeredCount: session.answeredCount,
      targetQuestionCount: session.targetQuestionCount,
      focusTrackingEnabled: session.focusTrackingEnabled,
      resumed: opts.resumed,
      paused: flagged >= limit,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
    };
  }

  async revealHint(auth: AuthContext, sessionId: string, dto: RevealHintDto): Promise<RevealedHintDto> {
    const session = await this.repo.findSession(auth.tenantId, auth.userId, sessionId);
    if (!session) throw AppException.notFound('Session not found');
    if (session.status !== 'active') throw AppException.conflict('This practice session is no longer active', 'INVALID_STATE');

    const item = await this.repo.findItem(auth.tenantId, dto.sessionItemId, this.db);
    if (!item || item.sessionId !== session.id || item.userId !== auth.userId) {
      throw AppException.notFound('Session item not found');
    }
    if (item.status !== 'served') {
      throw AppException.conflict('This question is already completed or skipped', 'INVALID_STATE');
    }

    const hints = await this.repo.findQuestionHints(item.questionId, this.db);
    const totalHints = hints.length;
    if (totalHints === 0) {
      throw AppException.notFound('No hints available for this question');
    }

    const requestedIndex = dto.hintIndex ?? 1;
    if (requestedIndex < 1 || requestedIndex > totalHints) {
      throw AppException.validation([{ field: 'hintIndex', message: `Hint index must be between 1 and ${totalHints}` }]);
    }

    const hintText = hints[requestedIndex - 1];
    if (!hintText) {
      throw AppException.notFound('Hint text not found');
    }

    return {
      hintIndex: requestedIndex,
      hintText,
      totalHints,
      hintsRemaining: totalHints - requestedIndex,
    };
  }
}

export function toProgressDto(ability: AbilityScoreRow): StudentProgressDto {
  return {
    theta: ability.theta,
    level: ability.level,
    attemptsCount: ability.attemptsCount,
    gradedCount: ability.gradedCount,
    correctCount: ability.correctCount,
    placementStatus: ability.placementStatus,
  };
}

/** Re-exported for the attempts service, which builds the same selection state shape. */
export type { Candidate, SelectionState };
