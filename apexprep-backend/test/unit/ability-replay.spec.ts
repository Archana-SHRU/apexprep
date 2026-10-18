import { expectedScore, studentK, type EngineParams } from '../../src/adaptive';
import { replayAbility, type ReplayAttempt } from '../../src/practice/ability-replay';
import { engineParams } from '../fixtures/engine-params';

const CONFIG = 'cfg-1';

describe('rebuilding the ability projection from attempts', () => {
  const params = engineParams();
  const paramsFor = () => params;

  let clock = Date.UTC(2026, 0, 1, 9, 0, 0);
  const at = (): Date => new Date((clock += 60_000));

  function attempt(patch: Partial<ReplayAttempt> = {}): ReplayAttempt {
    return {
      id: `a-${Math.random().toString(16).slice(2)}`,
      createdAt: at(),
      outcome: 'correct',
      score: 1,
      totalTimeMs: 30_000,
      thetaBefore: 1000,
      difficultyBAtAttempt: 1000,
      calibrationNAtAttempt: 50,
      expectedTimeSecondsAtAttempt: 60,
      probableGuess: false,
      selectionReason: 'adaptive',
      engineConfigId: CONFIG,
      ...patch,
    };
  }

  /** Chains θ the way the live path does: each attempt starts where the last one left off. */
  function chain(specs: Partial<ReplayAttempt>[], startTheta = 1000): ReplayAttempt[] {
    let theta = startTheta;
    let graded = 0;
    return specs.map((spec) => {
      const row = attempt({ ...spec, thetaBefore: theta });
      const e = expectedScore(theta, row.difficultyBAtAttempt, params);
      const k = studentK({ attemptsInSubtopic: graded, questionCalibrationN: row.calibrationNAtAttempt! }, params);
      if (row.score !== null) {
        const weight = row.probableGuess ? 0 : 1;
        theta = Math.round((theta + weight * k * (row.score - e)) * 100) / 100;
        graded += 1;
      }
      return row;
    });
  }

  it('refuses to replay an empty history rather than inventing a cold start', () => {
    expect(() => replayAbility([], paramsFor)).toThrow(/at least one attempt/);
  });

  it('reproduces θ, the counters and the level from one correct answer', () => {
    const result = replayAbility([attempt({ selectionReason: 'cold_start' })], paramsFor);
    expect(result.ability).toMatchObject({
      theta: 1016, // 1000 + 32 × (1 − 0.5)
      level: 2,
      attemptsCount: 1,
      gradedCount: 1,
      correctCount: 1,
      consecutiveCorrect: 1,
      consecutiveIncorrect: 0,
      placementAnswered: 1,
      placementStatus: 'in_progress',
      ladderResetAt: null,
    });
    expect(result).toMatchObject({ exact: true, unreplayableAttempts: 0, outOfBandThetaAdjustment: 0, guessVerdictMismatches: 0 });
  });

  it('starts at the band the cold-start θ falls in, so a parent-seeded student starts higher', () => {
    const seeded = replayAbility([attempt({ thetaBefore: 1320, selectionReason: 'cold_start' })], paramsFor);
    expect(seeded.ability.level).toBe(4);
  });

  it('promotes on the ladder and records where the new level started', () => {
    const rows = chain([{ selectionReason: 'cold_start' }, {}]);
    const result = replayAbility(rows, paramsFor);
    expect(result.ability.level).toBe(3);
    expect(result.ability.ladderResetAt).toEqual(rows[1]!.createdAt);
  });

  it('does not let the attempt that caused a promotion count towards the next one', () => {
    const rows = chain([{ selectionReason: 'cold_start' }, {}, {}]);
    const result = replayAbility(rows, paramsFor);
    expect(result.ability.level).toBe(3); // promoted once at row 2, not again at row 3
    expect(result.ability.ladderResetAt).toEqual(rows[1]!.createdAt);
  });

  it('keeps a probable guess out of θ and out of the ladder, but counts the attempt', () => {
    const rows = chain([
      { selectionReason: 'cold_start' },
      { outcome: 'incorrect', score: 0, probableGuess: true, totalTimeMs: 5_000 },
    ]);
    const result = replayAbility(rows, paramsFor);
    expect(result.ability).toMatchObject({ theta: 1016, attemptsCount: 2, gradedCount: 2, correctCount: 1, consecutiveCorrect: 1 });
    expect(result.guessVerdictMismatches).toBe(0);
  });

  it('flags a stored guess verdict the parameters no longer agree with', () => {
    // Recorded as a guess, but 30s is half the expected time: over the 25% threshold.
    const result = replayAbility([attempt({ outcome: 'incorrect', score: 0, probableGuess: true, totalTimeMs: 30_000 })], paramsFor);
    expect(result.guessVerdictMismatches).toBe(1);
  });

  it('reports inactivity decay as an out-of-band adjustment and follows the recorded θ', () => {
    const first = attempt({ selectionReason: 'cold_start' }); // θ 1000 → 1016
    const second = attempt({ thetaBefore: 986 }); // 30 points of decay landed in between
    const result = replayAbility([first, second], paramsFor);
    expect(result.outOfBandThetaAdjustment).toBe(-30);
    // 986 against b = 1000 gives E ≈ 0.4799, so θ' = 986 + 32 × (1 − 0.4799)
    expect(result.ability.theta).toBeCloseTo(1002.64, 2);
    expect(result.exact).toBe(true); // decay is accounted for, not unknown
  });

  it('re-derives the level from θ when decay drops it out of the band', () => {
    const rows = [
      attempt({ thetaBefore: 1120, selectionReason: 'cold_start' }),
      attempt({ thetaBefore: 1040, outcome: 'incorrect', score: 0 }),
    ];
    const result = replayAbility(rows, paramsFor);
    // started in the L3 band; the θ the second attempt recorded is back inside L2
    expect(result.ability.level).toBe(2);
    expect(result.outOfBandThetaAdjustment).toBeLessThan(0);
  });

  it('will not guess at an attempt that predates the engine-input snapshot', () => {
    const result = replayAbility([attempt({ calibrationNAtAttempt: null }), attempt({ thetaBefore: 1000 })], paramsFor);
    expect(result).toMatchObject({ exact: false, unreplayableAttempts: 1 });
    expect(result.ability.attemptsCount).toBe(2);
  });

  it('replays each attempt under the engine configuration it was graded with', () => {
    const slow: EngineParams = engineParams({ k_student: { initial: 8 } });
    const byId = (id: string): EngineParams => (id === 'cfg-slow' ? slow : params);
    const fast = replayAbility([attempt({ selectionReason: 'cold_start' })], byId);
    const gentle = replayAbility([attempt({ selectionReason: 'cold_start', engineConfigId: 'cfg-slow' })], byId);
    expect(fast.ability.theta).toBe(1016);
    expect(gentle.ability.theta).toBe(1004);
  });

  it('completes placement after the configured number of placement questions', () => {
    const three = engineParams({ placement: { question_count: 3 } });
    const rows = chain([{ selectionReason: 'cold_start' }, { selectionReason: 'placement' }, { selectionReason: 'placement' }, {}]);
    const result = replayAbility(rows, () => three);
    expect(result.ability).toMatchObject({ placementAnswered: 3, placementStatus: 'completed' });
  });

  it('leaves an ungraded long-form answer out of every count but the attempt count', () => {
    const rows = [attempt({ selectionReason: 'cold_start', outcome: 'ungraded', score: null })];
    const result = replayAbility(rows, paramsFor);
    expect(result.ability).toMatchObject({ theta: 1000, attemptsCount: 1, gradedCount: 0, correctCount: 0, consecutiveCorrect: 0 });
  });

  it('carries the last attempt forward so the projection can point at it', () => {
    const rows = chain([{ selectionReason: 'cold_start' }, { outcome: 'incorrect', score: 0 }]);
    const result = replayAbility(rows, paramsFor);
    expect(result.ability.lastAttemptId).toBe(rows[1]!.id);
    expect(result.ability.lastAttemptAt).toEqual(rows[1]!.createdAt);
    expect(result.ability.engineConfigId).toBe(CONFIG);
  });
});
