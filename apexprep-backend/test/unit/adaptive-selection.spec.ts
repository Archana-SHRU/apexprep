import { targetDifficulty } from '../../src/adaptive/elo';
import {
  fallbackSelection,
  filterEligible,
  probeTargetB,
  selectNextQuestion,
  selectionReason,
  type Candidate,
  type SelectionState,
} from '../../src/adaptive/selection';
import { engineParams } from '../fixtures/engine-params';

const params = engineParams();
const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const candidate = (id: string, difficultyB: number, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  difficultyB,
  difficultyLabel: 2,
  duplicateGroupId: null,
  lastAttemptedAt: null,
  lastSkippedAt: null,
  ...extra,
});

const state = (extra: Partial<SelectionState> = {}): SelectionState => ({
  position: 1,
  theta: 1000,
  level: 2,
  attemptsInSubtopic: 20,
  now: NOW,
  ...extra,
});

describe('selection reason', () => {
  it('is a cold start for the student’s very first question in the sub-topic', () => {
    expect(selectionReason(state({ position: 1, attemptsInSubtopic: 0 }), params)).toBe('cold_start');
  });

  it('is placement until the configured number of questions has been answered', () => {
    expect(selectionReason(state({ position: 2, attemptsInSubtopic: 1 }), params)).toBe('placement');
    expect(selectionReason(state({ position: 8, attemptsInSubtopic: 7 }), params)).toBe('placement');
    expect(selectionReason(state({ position: 9, attemptsInSubtopic: 8 }), params)).toBe('adaptive');
  });

  it('skips placement entirely when it is switched off', () => {
    const noPlacement = engineParams({ placement: { enabled: false } });
    expect(selectionReason(state({ position: 2, attemptsInSubtopic: 1 }), noPlacement)).toBe('adaptive');
  });

  it('makes every n-th question of the session a probe', () => {
    for (const position of [5, 10, 15]) expect(selectionReason(state({ position }), params)).toBe('probe');
    for (const position of [4, 6, 9]) expect(selectionReason(state({ position }), params)).toBe('adaptive');
    expect(selectionReason(state({ position: 3 }), engineParams({ probe: { every_n: 3 } }))).toBe('probe');
  });

  it('prefers placement over the probe cadence', () => {
    expect(selectionReason(state({ position: 5, attemptsInSubtopic: 4 }), params)).toBe('placement');
  });
});

describe('eligibility', () => {
  it('excludes a question attempted in the last 30 days and lets it back afterwards', () => {
    expect(params.exclusion_days).toBe(30);
    const recent = candidate('recent', 1000, { lastAttemptedAt: daysAgo(10) });
    const old = candidate('old', 1000, { lastAttemptedAt: daysAgo(31) });
    expect(filterEligible([recent, old], state(), params).map((c) => c.id)).toEqual(['old']);
  });

  it('excludes skipped questions only when the configuration says so', () => {
    const skipped = candidate('skipped', 1000, { lastSkippedAt: daysAgo(5) });
    expect(filterEligible([skipped], state(), params)).toEqual([]);
    const allowSkipped = engineParams({ exclusion_includes_skipped: false });
    expect(filterEligible([skipped], state(), allowSkipped).map((c) => c.id)).toEqual(['skipped']);
  });

  it('excludes near-duplicates of a question the student has already seen', () => {
    const twin = candidate('twin', 1000, { duplicateGroupId: 'group-1' });
    const other = candidate('other', 1000, { duplicateGroupId: 'group-2' });
    const seen = state({ seenDuplicateGroups: [{ groupId: 'group-1', seenAt: daysAgo(3) }] });
    expect(filterEligible([twin, other], seen, params).map((c) => c.id)).toEqual(['other']);
  });

  it('lets a near-duplicate back once its window has passed', () => {
    const twin = candidate('twin', 1000, { duplicateGroupId: 'group-1' });
    const seen = state({ seenDuplicateGroups: [{ groupId: 'group-1', seenAt: daysAgo(31) }] });
    expect(filterEligible([twin], seen, params).map((c) => c.id)).toEqual(['twin']);
  });

  it('follows the configured window length', () => {
    const recent = candidate('recent', 1000, { lastAttemptedAt: daysAgo(10) });
    expect(filterEligible([recent], state(), engineParams({ exclusion_days: 7 })).map((c) => c.id)).toEqual(['recent']);
    expect(filterEligible([recent], state(), engineParams({ exclusion_days: 0 })).map((c) => c.id)).toEqual(['recent']);
  });
});

describe('choosing the question', () => {
  it('serves the question closest to the target difficulty for this student', () => {
    const target = targetDifficulty(1000, params); // ≈ 836
    const pool = [candidate('easy', 600), candidate('near', 850), candidate('hard', 1400)];
    const result = selectNextQuestion(state({ position: 2, attemptsInSubtopic: 20 }), pool, params);
    expect(result.selection).toMatchObject({ questionId: 'near', reason: 'adaptive', thetaAtServe: 1000, difficultyBAtServe: 850 });
    expect(result.selection!.targetB).toBeCloseTo(target, 6);
  });

  it('aims half a level above the usual target on a probe turn', () => {
    expect(params.probe).toMatchObject({ every_n: 5, levels_above_target: 0.5 });
    // Bands are 200 wide here, so half a level is 100 points above b* (≈836) → ≈936.
    const expected = targetDifficulty(1000, params) + 0.5 * 200;
    expect(probeTargetB(1000, 2, params)).toBeCloseTo(expected, 10);

    const pool = [candidate('at-target', 836), candidate('half-level-up', 936)];
    const result = selectNextQuestion(state({ position: 5 }), pool, params);
    expect(result.selection).toMatchObject({ questionId: 'half-level-up', reason: 'probe' });
  });

  it('takes the probe offset from configuration', () => {
    const flat = engineParams({ probe: { levels_above_target: 0 } });
    expect(probeTargetB(1000, 2, flat)).toBeCloseTo(targetDifficulty(1000, flat), 10);
    const wide = engineParams({ probe: { levels_above_target: 1 } });
    expect(probeTargetB(1000, 2, wide) - probeTargetB(1000, 2, flat)).toBeCloseTo(200, 10);
  });

  it('is deterministic when two questions are equally close', () => {
    const pool = [candidate('bbb', 900), candidate('aaa', 900)];
    const first = selectNextQuestion(state({ position: 2 }), pool, params).selection;
    const again = selectNextQuestion(state({ position: 2 }), [...pool].reverse(), params).selection;
    expect(first!.questionId).toBe('aaa');
    expect(again!.questionId).toBe('aaa');
  });

  it('never serves an excluded question', () => {
    const pool = [candidate('seen', 840, { lastAttemptedAt: daysAgo(2) }), candidate('fresh', 1200)];
    expect(selectNextQuestion(state({ position: 2 }), pool, params).selection!.questionId).toBe('fresh');
  });

  it('flags a content gap under 5 eligible questions, asks to widen to the parent topic and to alert admins', () => {
    expect(params.content_gap).toMatchObject({ min_eligible: 5, widen_to_topic: true, open_review_task: true });
    const pool = [candidate('a', 900), candidate('b', 950)];
    const result = selectNextQuestion(state({ position: 2 }), pool, params);
    expect(result).toMatchObject({
      contentGap: true,
      eligibleCount: 2,
      widenToParentTopic: true,
      raiseContentGapAlert: true,
      exhausted: false,
    });
    expect(result.selection).not.toBeNull();
  });

  it('does not flag a gap once 5 or more are eligible', () => {
    const pool = Array.from({ length: 5 }, (_, i) => candidate(`q${i}`, 900 + i));
    expect(selectNextQuestion(state({ position: 2 }), pool, params)).toMatchObject({
      contentGap: false,
      eligibleCount: 5,
      widenToParentTopic: false,
      raiseContentGapAlert: false,
    });
  });

  it('follows the configured responses to a gap', () => {
    const quiet = engineParams({ content_gap: { widen_to_topic: false, open_review_task: false } });
    expect(selectNextQuestion(state({ position: 2 }), [candidate('a', 900)], quiet)).toMatchObject({
      contentGap: true,
      widenToParentTopic: false,
      raiseContentGapAlert: false,
    });
  });

  it('reports exhaustion instead of serving something the student just saw', () => {
    const pool = [candidate('a', 900, { lastAttemptedAt: daysAgo(1) })];
    const result = selectNextQuestion(state({ position: 2 }), pool, params);
    expect(result).toMatchObject({ selection: null, eligibleCount: 0, contentGap: true, widenToParentTopic: true, exhausted: true });
  });
});

describe('content-gap fallback', () => {
  it('picks the question seen longest ago and labels it as a fallback', () => {
    const pool = [
      candidate('recent', 900, { lastAttemptedAt: daysAgo(2) }),
      candidate('older', 1000, { lastAttemptedAt: daysAgo(20) }),
    ];
    expect(fallbackSelection(pool, state(), params)).toMatchObject({ questionId: 'older', reason: 'content_gap_fallback' });
  });

  it('prefers a never-seen question', () => {
    const pool = [candidate('seen', 900, { lastAttemptedAt: daysAgo(2) }), candidate('unseen', 1000)];
    expect(fallbackSelection(pool, state(), params)!.questionId).toBe('unseen');
  });

  it('returns nothing when the sub-topic has no questions at all', () => {
    expect(fallbackSelection([], state(), params)).toBeNull();
  });
});
