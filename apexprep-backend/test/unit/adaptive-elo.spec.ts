import { expectedScore, questionK, roundToStorage, studentK, targetDifficulty, updatedDifficulty, updatedTheta } from '../../src/adaptive/elo';
import { engineParams } from '../fixtures/engine-params';

const params = engineParams();

describe('expected score E = 1 / (1 + 10^((b − θ)/scale))', () => {
  it('uses an Elo scale of 400', () => {
    expect(params.elo_scale).toBe(400);
    // 400 points of advantage on a 400 scale → 10:1 odds.
    expect(expectedScore(1400, 1000, params)).toBeCloseTo(10 / 11, 12);
    expect(expectedScore(1000, 1400, params)).toBeCloseTo(1 / 11, 12);
  });

  it('is 0.5 when ability and difficulty are equal, and symmetric', () => {
    expect(expectedScore(1000, 1000, params)).toBeCloseTo(0.5, 12);
    expect(expectedScore(1000, 1200, params) + expectedScore(1200, 1000, params)).toBeCloseTo(1, 12);
  });

  it('follows the configured scale rather than a hard-coded 400', () => {
    expect(expectedScore(1100, 1000, engineParams({ elo_scale: 100 }))).toBeCloseTo(10 / 11, 12);
  });
});

describe('K_s: 32 for the first 20 attempts, then 16', () => {
  const calibrated = { questionCalibrationN: 50 };

  it.each([0, 1, 19])('is 32 at attempt %p in the sub-topic', (attemptsInSubtopic) => {
    expect(studentK({ attemptsInSubtopic, ...calibrated }, params)).toBe(32);
  });

  it.each([20, 21, 500])('is 16 from attempt %p onwards', (attemptsInSubtopic) => {
    expect(studentK({ attemptsInSubtopic, ...calibrated }, params)).toBe(16);
  });

  it('halves against a question with fewer than 10 calibrating attempts', () => {
    expect(studentK({ attemptsInSubtopic: 0, questionCalibrationN: 9 }, params)).toBe(16);
    expect(studentK({ attemptsInSubtopic: 0, questionCalibrationN: 10 }, params)).toBe(32);
    expect(studentK({ attemptsInSubtopic: 100, questionCalibrationN: 0 }, params)).toBe(8);
    expect(studentK({ attemptsInSubtopic: 100, questionCalibrationN: 10 }, params)).toBe(16);
  });

  it('reads all four numbers from configuration', () => {
    const custom = engineParams({ k_student: { initial: 40, initial_attempts: 5, steady: 10, low_calibration_threshold: 3, low_calibration_factor: 0.25 } });
    expect(studentK({ attemptsInSubtopic: 4, questionCalibrationN: 99 }, custom)).toBe(40);
    expect(studentK({ attemptsInSubtopic: 5, questionCalibrationN: 99 }, custom)).toBe(10);
    expect(studentK({ attemptsInSubtopic: 5, questionCalibrationN: 2 }, custom)).toBe(2.5);
  });
});

describe('K_q: 24 while calibration_n < 50, then 8', () => {
  it.each([0, 25, 49])('is 24 at calibration_n %p', (n) => {
    expect(questionK(n, params)).toBe(24);
  });

  it.each([50, 51, 1000])('is 8 at calibration_n %p', (n) => {
    expect(questionK(n, params)).toBe(8);
  });

  it('reads the schedule from configuration', () => {
    const custom = engineParams({ k_question: { uncalibrated: 30, calibrated_after: 10, steady: 5 } });
    expect([questionK(9, custom), questionK(10, custom)]).toEqual([30, 5]);
  });
});

describe('θ update: θ + K_s (S − E)', () => {
  it('moves up on a correct answer and down on a wrong one, by K × surprise', () => {
    const e = expectedScore(1000, 1000, params); // 0.5
    expect(updatedTheta(1000, 1, e, 32)).toBeCloseTo(1016, 10);
    expect(updatedTheta(1000, 0, e, 32)).toBeCloseTo(984, 10);
    expect(updatedTheta(1000, 1, e, 16)).toBeCloseTo(1008, 10);
  });

  it('barely moves when the outcome was expected, and moves most when it was not', () => {
    const easy = expectedScore(1400, 1000, params);
    expect(updatedTheta(1400, 1, easy, 32) - 1400).toBeLessThan(1400 - updatedTheta(1400, 0, easy, 32));
  });

  it('scales with the weight, so a probe or a probable guess can count less or not at all', () => {
    const e = expectedScore(1000, 1000, params);
    expect(updatedTheta(1000, 1, e, 32, 0)).toBe(1000);
    expect(updatedTheta(1000, 1, e, 32, 0.5) - 1000).toBeCloseTo(8, 10);
  });
});

describe('question difficulty update: b + K_q (E − S)', () => {
  it('makes a question easier when it is beaten and harder when it is missed', () => {
    const e = expectedScore(1000, 1000, params);
    expect(updatedDifficulty(1000, 1, e, 24)).toBeCloseTo(988, 10);
    expect(updatedDifficulty(1000, 0, e, 24)).toBeCloseTo(1012, 10);
  });

  it('moves the question in the opposite direction to the student', () => {
    const e = expectedScore(1200, 1000, params);
    expect(Math.sign(updatedTheta(1200, 1, e, 32) - 1200)).toBe(1);
    expect(Math.sign(updatedDifficulty(1000, 1, e, 24) - 1000)).toBe(-1);
  });
});

describe('target difficulty b* = θ + scale·log10(1/p − 1)', () => {
  it('aims at a 72% chance of success', () => {
    expect(params.target_success).toBe(0.72);
    for (const theta of [700, 1000, 1550]) {
      expect(expectedScore(theta, targetDifficulty(theta, params), params)).toBeCloseTo(0.72, 10);
    }
  });

  it('sits about 164 points below θ at that target', () => {
    expect(targetDifficulty(1000, params) - 1000).toBeCloseTo(-164.06, 1);
  });

  it('equals θ when the target is 50%', () => {
    expect(targetDifficulty(1000, engineParams({ target_success: 0.5 }))).toBeCloseTo(1000, 10);
  });
});

describe('roundToStorage', () => {
  it('rounds to the two decimals numeric(8,2) keeps', () => {
    expect(roundToStorage(1000.004)).toBe(1000);
    expect(roundToStorage(1000.005)).toBe(1000.01);
  });
});
