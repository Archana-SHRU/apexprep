import { applyAttempt, type AttemptInput } from '../../src/adaptive/attempt-update';
import { expectedScore } from '../../src/adaptive/elo';
import type { LadderAttempt } from '../../src/adaptive/levels';
import { engineParams } from '../fixtures/engine-params';

const params = engineParams();

const attempt = (extra: Partial<AttemptInput> = {}): AttemptInput => ({
  score: 1,
  theta: 1000,
  level: 2,
  difficultyB: 1000,
  questionCalibrationN: 50, // calibrated, so K_s is not halved and K_q is at its steady value
  attemptsInSubtopic: 25, // past the first 20, so K_s = 16
  totalTimeMs: 60_000,
  expectedTimeSeconds: 60,
  selectionReason: 'adaptive',
  ladderHistory: [],
  ...extra,
});

const fast = (correct: boolean): LadderAttempt => ({ correct, withinExpectedTime: true, isProbe: false });

describe('applying one graded attempt', () => {
  it('uses the stepped K values and records which ones it applied', () => {
    const experienced = applyAttempt(attempt(), params);
    expect(experienced).toMatchObject({ kStudent: 16, kQuestion: 8, thetaBefore: 1000, difficultyBBefore: 1000 });
    expect(experienced.expectedScore).toBeCloseTo(0.5, 12);
    expect(experienced.theta).toBe(1008); // 1000 + 16 × 0.5
    expect(experienced.difficultyB).toBe(996); // 1000 − 8 × 0.5

    const newcomer = applyAttempt(attempt({ attemptsInSubtopic: 3 }), params);
    expect(newcomer).toMatchObject({ kStudent: 32, theta: 1016 });
  });

  it('halves the ability update against a barely calibrated question, which itself moves faster', () => {
    const update = applyAttempt(attempt({ questionCalibrationN: 4 }), params);
    expect(update).toMatchObject({ kStudent: 8, kQuestion: 24 }); // 16 halved; 24 while under 50
    expect(update.theta).toBe(1004);
    expect(update.difficultyB).toBe(988);
  });

  it('moves θ down and the question up on a wrong answer', () => {
    const update = applyAttempt(attempt({ score: 0 }), params);
    expect(update).toMatchObject({ theta: 992, difficultyB: 1004 });
  });

  it('leaves everything untouched for an ungraded (long-form) response', () => {
    expect(applyAttempt(attempt({ score: null }), params)).toMatchObject({
      graded: false,
      theta: 1000,
      difficultyB: 1000,
      kStudent: 0,
      kQuestion: 0,
      ladderEntry: null,
    });
  });

  describe('probable guesses', () => {
    const guessed = attempt({ score: 0, totalTimeMs: 5_000 }); // wrong, in 5s of an expected 60s

    it('is excluded from the ability update', () => {
      const update = applyAttempt(guessed, params);
      expect(update.guess.isProbableGuess).toBe(true);
      expect(update).toMatchObject({ theta: 1000, difficultyB: 1000, thetaWeight: 0, questionWeight: 0 });
    });

    it('never reaches the ladder, so it cannot cause a demotion', () => {
      const update = applyAttempt({ ...guessed, ladderHistory: [fast(false)] }, params);
      expect(update.ladderEntry).toBeNull();
      expect(update.level).toMatchObject({ change: 'unchanged' });
    });

    it('does update θ when the same wrong answer took real time', () => {
      const update = applyAttempt({ ...guessed, totalTimeMs: 45_000 }, params);
      expect(update.guess.isProbableGuess).toBe(false);
      expect(update.theta).toBe(992);
    });

    it('pauses the session on the third flagged guess', () => {
      expect(applyAttempt({ ...guessed, flaggedGuessesInSession: 1 }, params).pauseSession).toBe(false);
      expect(applyAttempt({ ...guessed, flaggedGuessesInSession: 2 }, params).pauseSession).toBe(true);
    });

    it('does not count a normal attempt towards the pause limit', () => {
      expect(applyAttempt(attempt({ flaggedGuessesInSession: 2 }), params).pauseSession).toBe(false);
    });
  });

  describe('probes', () => {
    const probe = attempt({ selectionReason: 'probe' });

    it('updates θ', () => {
      expect(params.probe.updates_theta).toBe(true);
      expect(applyAttempt(probe, params).theta).toBe(1008);
    });

    it('marks its ladder entry as a probe, which the demotion counters skip', () => {
      const failed = applyAttempt({ ...probe, score: 0, ladderHistory: [fast(false)] }, params);
      expect(failed.ladderEntry).toMatchObject({ isProbe: true, correct: false });
      expect(failed.level).toMatchObject({ change: 'unchanged' }); // two wrong in a row, but one was a probe
      expect(failed.theta).toBe(992); // …θ still moved
    });

    it('still counts towards promotion', () => {
      const passed = applyAttempt({ ...probe, ladderHistory: [fast(true)] }, params);
      expect(passed.level).toMatchObject({ change: 'promoted', level: 3, rule: 'consecutive_correct' });
    });

    it('can be configured to leave θ alone', () => {
      const quiet = engineParams({ probe: { updates_theta: false, updates_question_b: false } });
      expect(applyAttempt(probe, quiet)).toMatchObject({ theta: 1000, difficultyB: 1000 });
    });
  });

  describe('the ladder', () => {
    it('records whether the answer was inside 1.25× the expected time', () => {
      expect(applyAttempt(attempt({ totalTimeMs: 75_000 }), params).ladderEntry).toMatchObject({ withinExpectedTime: true });
      expect(applyAttempt(attempt({ totalTimeMs: 75_001 }), params).ladderEntry).toMatchObject({ withinExpectedTime: false });
    });

    it('promotes on two quick correct answers in a row', () => {
      expect(applyAttempt(attempt({ ladderHistory: [fast(true)] }), params).level).toMatchObject({ change: 'promoted', level: 3 });
    });

    it('does not promote when the second answer was slow', () => {
      const slowCorrect = applyAttempt(attempt({ totalTimeMs: 200_000, ladderHistory: [fast(true)] }), params);
      expect(slowCorrect.level).toMatchObject({ change: 'unchanged' });
    });

    it('demotes on two wrong answers in a row, but not below L1', () => {
      expect(applyAttempt(attempt({ score: 0, level: 3, ladderHistory: [fast(false)] }), params).level).toMatchObject({ change: 'demoted', level: 2 });
      expect(applyAttempt(attempt({ score: 0, level: 1, ladderHistory: [fast(false)] }), params).level).toMatchObject({
        change: 'unchanged',
        blockedBy: 'l1_protection',
      });
    });
  });

  it('reports the band θ now sits in alongside the working level', () => {
    const update = applyAttempt(attempt({ theta: 1098, difficultyB: 1400, attemptsInSubtopic: 0, questionCalibrationN: 50 }), params);
    expect(update.theta).toBeGreaterThanOrEqual(1100);
    expect(update.bandLevel).toBe(3);
    expect(update.level.level).toBe(2);
  });

  it('converges: answering at the target difficulty keeps θ near where it started', () => {
    let theta = 1000;
    for (let i = 0; i < 100; i += 1) {
      const score = i % 4 === 3 ? 0 : 1; // 75% success, close to the 72% target
      theta = applyAttempt(attempt({ score, theta, difficultyB: 836 }), params).theta;
    }
    expect(Math.abs(theta - 1000)).toBeLessThan(60);
  });

  it('uses expected score as the reference point, so beating a hard question moves θ most', () => {
    const easy = applyAttempt(attempt({ difficultyB: 600 }), params);
    const hard = applyAttempt(attempt({ difficultyB: 1400 }), params);
    expect(hard.theta - 1000).toBeGreaterThan(easy.theta - 1000);
    expect(easy.expectedScore).toBeCloseTo(expectedScore(1000, 600, params), 12);
  });
});
