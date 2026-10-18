import {
  clampTheta,
  coldStartLevel,
  coldStartTheta,
  evaluateLevel,
  levelForTheta,
  parentTopicTheta,
  type LadderAttempt,
} from '../../src/adaptive/levels';
import { engineParams } from '../fixtures/engine-params';

const params = engineParams();

/** Ladder entries, newest first. */
const fast = (correct: boolean): LadderAttempt => ({ correct, withinExpectedTime: true, isProbe: false });
const slow = (correct: boolean): LadderAttempt => ({ correct, withinExpectedTime: false, isProbe: false });
const probe = (correct: boolean): LadderAttempt => ({ correct, withinExpectedTime: true, isProbe: true });

describe('levelForTheta', () => {
  it.each([
    [500, 1],
    [899.99, 1],
    [900, 2],
    [1100, 3],
    [1300, 4],
    [1500, 5],
  ])('θ %p falls in L%p', (theta, level) => {
    expect(levelForTheta(theta, params)).toBe(level);
  });
});

describe('cold start', () => {
  it('starts a new student at L2', () => {
    expect(params.cold_start.level).toBe(2);
    expect(levelForTheta(coldStartTheta(params), params)).toBe(2);
    expect(coldStartTheta(params)).toBe(1000);
  });

  it('seeds θ from the parent topic when the student has practised its other sub-topics', () => {
    expect(coldStartTheta(params, 1280)).toBe(1280);
    expect(coldStartLevel(params, 1280)).toBe(3); // 1280 sits in the L3 band
    expect(coldStartLevel(params, 1320)).toBe(4);
  });

  it('falls back to L2 when there is no parent-topic ability', () => {
    expect(coldStartTheta(params, null)).toBe(1000);
    expect(coldStartLevel(params, null)).toBe(2);
  });

  it('ignores the parent topic when seeding is switched off', () => {
    const off = engineParams({ cold_start: { seed_from_parent_topic: false } });
    expect(coldStartTheta(off, 1280)).toBe(1000);
    expect(coldStartLevel(off, 1280)).toBe(2);
  });

  it('takes the parent-topic ability as the mean of the sibling sub-topics', () => {
    expect(parentTopicTheta([1000, 1200, 1100])).toBe(1100);
    expect(parentTopicTheta([])).toBeNull();
  });
});

describe('clampTheta', () => {
  it('does nothing when no θ floor or cap is configured', () => {
    expect(params.l1_protection.theta_floor).toBeNull();
    expect(clampTheta(100, params)).toBe(100);
    expect(clampTheta(5000, params)).toBe(5000);
  });

  it('applies a floor and a cap when they are configured', () => {
    const bounded = engineParams({ l1_protection: { theta_floor: 600 }, l5_ceiling: { theta_cap: 1800 } });
    expect(clampTheta(400, bounded)).toBe(600);
    expect(clampTheta(2000, bounded)).toBe(1800);
  });
});

describe('promotion: 2 consecutive correct within 1.25× expected time, OR 3 of the last 4', () => {
  it('promotes on two quick correct answers in a row', () => {
    expect(params.promotion).toMatchObject({ consecutive_correct: 2, within_expected_time_factor: 1.25, window: 4, correct_in_window: 3 });
    expect(evaluateLevel(2, [fast(true), fast(true)], params)).toMatchObject({ level: 3, change: 'promoted', rule: 'consecutive_correct' });
  });

  it('does not promote on two correct answers that took too long', () => {
    expect(evaluateLevel(2, [slow(true), slow(true)], params)).toMatchObject({ change: 'unchanged' });
    expect(evaluateLevel(2, [fast(true), slow(true)], params)).toMatchObject({ change: 'unchanged' });
  });

  it('promotes on 3 correct out of the last 4, however long they took', () => {
    expect(evaluateLevel(2, [slow(true), slow(false), slow(true), slow(true)], params)).toMatchObject({
      level: 3,
      change: 'promoted',
      rule: 'correct_in_window',
    });
  });

  it('does not promote on 2 correct out of 4', () => {
    expect(evaluateLevel(2, [slow(true), slow(false), slow(true), slow(false)], params)).toMatchObject({ change: 'unchanged' });
  });

  it('waits until the window is full', () => {
    expect(evaluateLevel(2, [slow(true), slow(true), slow(true)], params)).toMatchObject({ change: 'unchanged' });
  });

  it('never promotes above L5', () => {
    expect(evaluateLevel(5, [fast(true), fast(true)], params)).toMatchObject({ level: 5, change: 'unchanged', blockedBy: 'l5_ceiling' });
  });
});

describe('demotion: 2 consecutive incorrect, OR 3 incorrect of the last 5', () => {
  it('demotes on two wrong answers in a row', () => {
    expect(params.demotion).toMatchObject({ consecutive_incorrect: 2, window: 5, incorrect_in_window: 3 });
    expect(evaluateLevel(3, [fast(false), fast(false)], params)).toMatchObject({ level: 2, change: 'demoted', rule: 'consecutive_incorrect' });
  });

  it('demotes on 3 wrong out of the last 5', () => {
    expect(evaluateLevel(3, [fast(false), fast(true), fast(false), fast(true), fast(false)], params)).toMatchObject({
      level: 2,
      change: 'demoted',
      rule: 'incorrect_in_window',
    });
  });

  it('leaves the middle ground alone', () => {
    expect(evaluateLevel(3, [fast(true), fast(false), fast(true), fast(false), fast(true)], params)).toMatchObject({ change: 'unchanged' });
  });

  it('never demotes below L1', () => {
    expect(evaluateLevel(1, [fast(false), fast(false)], params)).toMatchObject({ level: 1, change: 'unchanged', blockedBy: 'l1_protection' });
  });

  it('prefers promotion when both rules could fire', () => {
    // 3 correct of the last 4 and 3 incorrect of the last 5 cannot both hold, but the
    // consecutive rules can overlap at a boundary; promotion is checked first.
    expect(evaluateLevel(3, [fast(true), fast(true), fast(false), fast(false), fast(false)], params)).toMatchObject({ change: 'promoted' });
  });
});

describe('probes on the ladder', () => {
  it('counts a probe towards promotion', () => {
    expect(params.probe.counts_towards_promotion).toBe(true);
    expect(evaluateLevel(2, [probe(true), fast(true)], params)).toMatchObject({ change: 'promoted', rule: 'consecutive_correct' });
  });

  it('does not let a failed probe feed the demotion counters', () => {
    expect(params.probe.counts_towards_demotion).toBe(false);
    expect(evaluateLevel(3, [probe(false), fast(false)], params)).toMatchObject({ change: 'unchanged' });
    expect(evaluateLevel(3, [probe(false), probe(false), fast(false), fast(false)], params)).toMatchObject({ change: 'demoted' });
  });

  it('skips probes when counting the demotion window too', () => {
    // Four real attempts, three of them wrong, with probes interleaved: still a demotion.
    const history = [fast(false), probe(false), fast(true), probe(false), fast(false), fast(false), fast(true)];
    expect(evaluateLevel(4, history, params)).toMatchObject({ change: 'demoted', level: 3 });
  });

  it('can be configured to count towards demotion as well', () => {
    const strict = engineParams({ probe: { counts_towards_demotion: true } });
    expect(evaluateLevel(3, [probe(false), fast(false)], strict)).toMatchObject({ change: 'demoted' });
  });
});
