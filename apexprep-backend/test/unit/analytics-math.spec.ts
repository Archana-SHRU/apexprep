import {
  accuracyByLevel,
  accuracyPct,
  coveragePct,
  dayKey,
  daysUntil,
  median,
  paceSeconds,
  streakDays,
  weeklyTrend,
  weekStart,
  type AttemptFact,
} from '../../src/analytics/analytics.math';

const at = (iso: string, o: Partial<AttemptFact> = {}): AttemptFact => ({
  correct: true,
  totalTimeMs: 60_000,
  difficultyLabel: 3,
  createdAt: new Date(iso),
  probableGuess: false,
  ...o,
});

describe('a learner’s own figures', () => {
  /**
   * The whole reason this module exists. Every one of these would otherwise be a fabricated statistic
   * shown to a learner who has done nothing — "0% accuracy" on their first day being the worst of them.
   */
  describe('no data is null, never zero', () => {
    it('has no accuracy before anything is graded', () => {
      expect(accuracyPct(0, 0)).toBeNull();
      expect(accuracyPct(0, 1)).toBe(0); // a genuinely wrong answer IS 0%, and that is different
    });

    it('has no pace before anything is timed', () => {
      expect(paceSeconds([])).toBeNull();
      expect(median([])).toBeNull();
    });

    it('has no coverage when the track has no published sub-topics', () => {
      expect(coveragePct([], 0)).toBeNull();
      expect(coveragePct([], 10)).toBe(0); // ten sub-topics, none covered: genuinely 0%
    });

    it('has no exam countdown without a target date', () => {
      expect(daysUntil(null, new Date('2026-09-27T00:00:00Z'))).toBeNull();
    });

    it('reports every level even when four of them are untouched', () => {
      const rows = accuracyByLevel([at('2026-09-27T10:00:00Z', { difficultyLabel: 2 })]);
      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4, 5]);
      expect(rows[1]).toMatchObject({ level: 2, attempted: 1, correct: 1, accuracy: 100 });
      // The four untouched levels must be present with null, or the UI's five rows shift.
      expect(rows.filter((r) => r.accuracy === null)).toHaveLength(4);
      expect(rows[0]).toMatchObject({ attempted: 0, accuracy: null });
    });

    it('keeps an empty week in the trend rather than drawing over the gap', () => {
      const now = new Date('2026-09-27T12:00:00Z'); // a Sunday
      const trend = weeklyTrend([at('2026-09-21T09:00:00Z')], 3, now);
      expect(trend).toHaveLength(3);
      expect(trend.map((t) => t.weekStart)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
      expect(trend[2]).toMatchObject({ questions: 1, accuracy: 100 });
      expect(trend[0]).toMatchObject({ questions: 0, accuracy: null });
      expect(trend[1]).toMatchObject({ questions: 0, accuracy: null });
    });
  });

  describe('accuracy counts graded attempts only', () => {
    it('ignores an answer still awaiting marking', () => {
      // A long-form answer is an attempt but not evidence either way.
      const rows = accuracyByLevel([
        at('2026-09-27T10:00:00Z', { correct: true }),
        at('2026-09-27T10:05:00Z', { correct: null }),
      ]);
      expect(rows[2]).toMatchObject({ level: 3, attempted: 1, correct: 1, accuracy: 100 });
    });

    it('rounds to one decimal', () => {
      expect(accuracyPct(2, 3)).toBe(66.7);
      expect(accuracyPct(1, 3)).toBe(33.3);
    });
  });

  describe('pace is a median, and excludes guesses', () => {
    it('is not moved by one abandoned tab', () => {
      const attempts = [
        at('2026-09-27T10:00:00Z', { totalTimeMs: 50_000 }),
        at('2026-09-27T10:01:00Z', { totalTimeMs: 60_000 }),
        at('2026-09-27T10:02:00Z', { totalTimeMs: 70_000 }),
        at('2026-09-27T10:03:00Z', { totalTimeMs: 7_200_000 }), // two hours
      ];
      // Median of 50/60/70/7200 = 65 s. A mean would be over half an hour.
      expect(paceSeconds(attempts)).toBe(65);
    });

    it('leaves probable guesses out, so a rushed answer does not flatter the pace', () => {
      const attempts = [
        at('2026-09-27T10:00:00Z', { totalTimeMs: 100_000 }),
        at('2026-09-27T10:01:00Z', { totalTimeMs: 3_000, probableGuess: true }),
        at('2026-09-27T10:02:00Z', { totalTimeMs: 3_000, probableGuess: true }),
      ];
      expect(paceSeconds(attempts)).toBe(100);
    });

    it('interpolates an even-sized sample', () => {
      expect(median([10, 20])).toBe(15);
      expect(median([10, 20, 30])).toBe(20);
    });
  });

  describe('the streak', () => {
    const today = new Date('2026-09-27T12:00:00Z');

    it('counts consecutive days ending today', () => {
      expect(streakDays(['2026-09-27', '2026-09-26', '2026-09-25'], today)).toBe(3);
    });

    it('survives a day that has only just begun', () => {
      // At 00:30 a learner who practised daily for three days has not practised "today" yet. Reporting 0
      // would tell them they had lost a streak they still have.
      expect(streakDays(['2026-09-26', '2026-09-25', '2026-09-24'], today)).toBe(3);
    });

    it('is broken by a missed day', () => {
      expect(streakDays(['2026-09-25', '2026-09-24'], today)).toBe(0);
    });

    it('stops at the gap rather than counting every day ever', () => {
      expect(streakDays(['2026-09-27', '2026-09-26', '2026-09-20', '2026-09-19'], today)).toBe(2);
    });

    it('is zero for a learner who has never attempted anything', () => {
      expect(streakDays([], today)).toBe(0);
    });

    it('ignores duplicate days', () => {
      expect(streakDays(['2026-09-27', '2026-09-27', '2026-09-26'], today)).toBe(2);
    });
  });

  describe('dates', () => {
    it('counts whole days to a target, and past it', () => {
      const now = new Date('2026-09-27T23:00:00Z');
      expect(daysUntil(new Date('2026-09-28T01:00:00Z'), now)).toBe(1);
      expect(daysUntil(new Date('2026-09-27T01:00:00Z'), now)).toBe(0);
      // Negative rather than clamped: a stale profile must not read as "the exam is today", every day.
      expect(daysUntil(new Date('2026-09-20T01:00:00Z'), now)).toBe(-7);
    });

    it('takes Monday as the start of the week', () => {
      expect(dayKey(weekStart(new Date('2026-09-27T12:00:00Z')))).toBe('2026-09-21'); // Sunday → that Monday
      expect(dayKey(weekStart(new Date('2026-09-21T00:00:00Z')))).toBe('2026-09-21'); // Monday → itself
      expect(dayKey(weekStart(new Date('2026-09-22T23:59:59Z')))).toBe('2026-09-21');
    });
  });

  describe('coverage is the stated §10 metric', () => {
    it('counts sub-topics with at least ten attempts, over published sub-topics', () => {
      // 10 is the document's threshold, not a value chosen here.
      expect(coveragePct([12, 10, 9, 1], 8)).toBe(25);
      expect(coveragePct([12, 10], 2)).toBe(100);
    });
  });
});
