import { applyInactivityDecay } from '../../src/adaptive/decay';
import { assessGuess, shouldPauseSession } from '../../src/adaptive/guess';
import { engineParams } from '../fixtures/engine-params';

const params = engineParams();
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n, 12));

describe('probable guess: incorrect AND under 25% of the expected time', () => {
  it('uses a 25% threshold', () => {
    expect(params.probable_guess.max_time_fraction_of_expected).toBe(0.25);
    expect(assessGuess({ correct: false, totalTimeMs: 10_000, expectedTimeSeconds: 60 }, params).thresholdSeconds).toBe(15);
  });

  it('flags a wrong answer given in under a quarter of the expected time', () => {
    expect(assessGuess({ correct: false, totalTimeMs: 10_000, expectedTimeSeconds: 60 }, params).isProbableGuess).toBe(true);
  });

  it('does not flag a wrong answer the student spent time on', () => {
    expect(assessGuess({ correct: false, totalTimeMs: 20_000, expectedTimeSeconds: 60 }, params).isProbableGuess).toBe(false);
  });

  it('does not flag a fast CORRECT answer — speed alone is not a guess', () => {
    const quickCorrect = assessGuess({ correct: true, totalTimeMs: 2_000, expectedTimeSeconds: 60 }, params);
    expect(quickCorrect).toMatchObject({ isProbableGuess: false, tooFast: true, thetaWeight: 1, countsTowardsLevel: true });
  });

  it('can be configured to flag on time alone', () => {
    const timeOnly = engineParams({ probable_guess: { requires_incorrect: false } });
    expect(assessGuess({ correct: true, totalTimeMs: 2_000, expectedTimeSeconds: 60 }, timeOnly).isProbableGuess).toBe(true);
  });

  it('excludes a flagged attempt from the ability update and from the ladder', () => {
    expect(assessGuess({ correct: false, totalTimeMs: 1_000, expectedTimeSeconds: 60 }, params)).toMatchObject({
      isProbableGuess: true,
      thetaWeight: 0,
      questionWeight: 0,
      countsTowardsLevel: false,
    });
  });

  it('gives a normal attempt full weight', () => {
    expect(assessGuess({ correct: false, totalTimeMs: 90_000, expectedTimeSeconds: 60 }, params)).toMatchObject({
      isProbableGuess: false,
      thetaWeight: 1,
      questionWeight: 1,
      countsTowardsLevel: true,
    });
  });
});

describe('three flagged guesses pause the session', () => {
  it('pauses at the third flag, not before', () => {
    expect(params.probable_guess.pause_session_after).toBe(3);
    expect(shouldPauseSession(2, params)).toBe(false);
    expect(shouldPauseSession(3, params)).toBe(true);
    expect(shouldPauseSession(4, params)).toBe(true);
  });

  it('reads the limit from configuration', () => {
    expect(shouldPauseSession(2, engineParams({ probable_guess: { pause_session_after: 2 } }))).toBe(true);
  });
});

describe('inactivity decay after 21 days', () => {
  it('does nothing inside the 21-day grace window', () => {
    expect(params.inactivity_decay.after_days).toBe(21);
    expect(applyInactivityDecay({ theta: 1200, lastPracticedAt: day(0), now: day(20) }, params)).toMatchObject({ theta: 1200, decayed: 0, periods: 0 });
  });

  it('starts decaying once the window has passed', () => {
    expect(applyInactivityDecay({ theta: 1200, lastPracticedAt: day(0), now: day(21) }, params).periods).toBe(1);
    expect(applyInactivityDecay({ theta: 1200, lastPracticedAt: day(0), now: day(28) }, params).periods).toBe(2);
  });

  it('applies the configured amount per period, capped', () => {
    // Amount and cap are NOT specified by the requirements: this asserts the configured
    // values are used, not any particular number.
    const configured = engineParams({ inactivity_decay: { per_period_days: 10, theta_points_per_period: 25, max_total_points: 40 } });
    expect(applyInactivityDecay({ theta: 1200, lastPracticedAt: day(0), now: day(21) }, configured).theta).toBe(1175);
    expect(applyInactivityDecay({ theta: 1200, lastPracticedAt: day(0), now: day(300) }, configured).decayed).toBe(40);
  });

  it('respects a floor when one is configured', () => {
    const floored = engineParams({ inactivity_decay: { theta_points_per_period: 500, max_total_points: null, floor_theta: 600 } });
    expect(applyInactivityDecay({ theta: 900, lastPracticedAt: day(0), now: day(60) }, floored).theta).toBe(600);
  });

  it('depends only on the elapsed time, so repeating it gives the same θ', () => {
    const input = { theta: 1200, lastPracticedAt: day(0), now: day(35) };
    expect(applyInactivityDecay(input, params)).toEqual(applyInactivityDecay(input, params));
  });

  it('is switched off by a zero decay rate', () => {
    const off = engineParams({ inactivity_decay: { theta_points_per_period: 0 } });
    expect(applyInactivityDecay({ theta: 1200, lastPracticedAt: day(0), now: day(365) }, off)).toMatchObject({ theta: 1200, decayed: 0 });
  });
});
