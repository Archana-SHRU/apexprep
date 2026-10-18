/**
 * The pure arithmetic behind a learner's own figures.
 *
 * Separated from the repository so every number the learner sees is testable without a database, and so
 * the rules about *when a figure does not exist* live in one place. That second part is the reason this
 * file is worth having: the difference between "0%" and "no data yet" is the difference between telling a
 * new learner they got everything wrong and telling them they have not started.
 *
 * Every function here returns `null` rather than a made-up number when there is nothing to compute from.
 * Nothing is estimated, projected or smoothed.
 */

/** A graded attempt, reduced to the fields the figures need. */
export interface AttemptFact {
  /** Null while a long-form answer is awaiting marking; such an attempt is counted but not scored. */
  correct: boolean | null;
  totalTimeMs: number | null;
  difficultyLabel: number;
  /** When the learner answered, used for day and week buckets. */
  createdAt: Date;
  probableGuess: boolean;
}

/**
 * Accuracy as a percentage, 0-100, rounded to one decimal.
 *
 * `null` when nothing has been graded: a learner with no graded attempts has no accuracy, and reporting
 * 0% would be a statement about their ability rather than about the absence of data. The UI renders `—`.
 */
export function accuracyPct(correct: number, graded: number): number | null {
  if (graded <= 0) return null;
  return Math.round((correct / graded) * 1000) / 10;
}

/** Graded attempts only: an attempt awaiting marking is not evidence either way. */
export function gradedOf(attempts: readonly AttemptFact[]): AttemptFact[] {
  return attempts.filter((a) => a.correct !== null);
}

export function correctOf(attempts: readonly AttemptFact[]): number {
  return attempts.reduce((n, a) => n + (a.correct === true ? 1 : 0), 0);
}

/**
 * The median of a numeric sample, or null when the sample is empty.
 *
 * The median rather than the mean, for the same reason §6.4 chose it for expected time: one learner who
 * leaves a tab open for an hour moves a mean by minutes and a median not at all.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The learner's typical seconds per question: the median of `total_time_ms` over graded attempts,
 * excluding probable guesses.
 *
 * Guesses are excluded for the reason documented in DECISIONS.md B62 — an answer given in a fraction of
 * the expected time measures nothing about how long the question takes — and because a "your pace" figure
 * that guesses drag downwards would flatter the learner.
 */
export function paceSeconds(attempts: readonly AttemptFact[]): number | null {
  const times = attempts.filter((a) => !a.probableGuess && a.totalTimeMs !== null).map((a) => a.totalTimeMs!);
  const ms = median(times);
  return ms === null ? null : Math.round(ms / 1000);
}

/**
 * Accuracy per difficulty label, L1-L5.
 *
 * This is a **stated** requirement (§10: "Correct ÷ attempted, segmented by difficulty level"), which is
 * why it is reported as a real figure rather than left out. Every level appears in the result even with no
 * attempts, because the UI shows five rows and a missing level would silently shift the others; such a row
 * carries `attempted: 0` and `accuracy: null`.
 */
export function accuracyByLevel(attempts: readonly AttemptFact[]): { level: number; attempted: number; correct: number; accuracy: number | null }[] {
  return [1, 2, 3, 4, 5].map((level) => {
    const at = gradedOf(attempts).filter((a) => a.difficultyLabel === level);
    const correct = correctOf(at);
    return { level, attempted: at.length, correct, accuracy: accuracyPct(correct, at.length) };
  });
}

/** The UTC day an instant falls in, as YYYY-MM-DD. */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Consecutive days, ending today or yesterday, on which the learner attempted at least one question.
 *
 * Ending *yesterday* counts, because a streak should not be reported as broken until the day it is
 * actually missed — at 00:30 a learner who practised every day for a month has not practised "today", and
 * showing 0 would be wrong.
 *
 * Days are UTC days. This is a **decision, not a requirement**: the requirements do not define the
 * timezone a streak is counted in, and the server has no per-learner timezone to use. For a learner in
 * IST the day therefore rolls over at 05:30 local. Recorded here rather than buried in a query.
 */
export function streakDays(attemptDays: readonly string[], today: Date): number {
  if (attemptDays.length === 0) return 0;
  const days = new Set(attemptDays);
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  // Start from today if it counts, otherwise from yesterday; if neither, the streak is over.
  if (!days.has(dayKey(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!days.has(dayKey(cursor))) return 0;
  }

  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

/**
 * Whole days from `from` to `to`, or null when there is no target date.
 *
 * Negative when the date has passed, which the caller may show as "exam passed" — clamping to 0 would
 * quietly turn a stale profile into a countdown that says the exam is today, every day.
 */
export function daysUntil(to: Date | null, from: Date): number | null {
  if (to === null) return null;
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

/** The Monday (UTC) of the week an instant falls in. */
export function weekStart(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

/**
 * Weekly accuracy and volume over the requested number of weeks, oldest first.
 *
 * Every week in the window is present, including weeks the learner did nothing: a trend chart that omits
 * empty weeks draws a continuous line over a gap and invents progress that did not happen. Such a week
 * carries `questions: 0` and `accuracy: null`.
 */
export function weeklyTrend(
  attempts: readonly AttemptFact[],
  weeks: number,
  now: Date,
): { weekStart: string; questions: number; accuracy: number | null }[] {
  const buckets = new Map<string, AttemptFact[]>();
  const thisWeek = weekStart(now);
  const keys: string[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const d = new Date(thisWeek);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = dayKey(d);
    keys.push(key);
    buckets.set(key, []);
  }
  for (const a of attempts) {
    const key = dayKey(weekStart(a.createdAt));
    buckets.get(key)?.push(a);
  }
  return keys.map((key) => {
    const graded = gradedOf(buckets.get(key) ?? []);
    const correct = correctOf(graded);
    return { weekStart: key, questions: (buckets.get(key) ?? []).length, accuracy: accuracyPct(correct, graded.length) };
  });
}

/**
 * The percentage of published sub-topics the learner has practised enough to count as covered.
 *
 * §10 states this metric exactly: "% of published sub-topics with at least 10 attempts". The threshold is
 * the document's, not a choice made here. `null` when the track has no published sub-topics at all, since
 * a percentage of nothing is not 0%.
 */
export function coveragePct(subtopicAttemptCounts: readonly number[], publishedSubtopics: number, minAttempts = 10): number | null {
  if (publishedSubtopics <= 0) return null;
  const covered = subtopicAttemptCounts.filter((n) => n >= minAttempts).length;
  return Math.round((covered / publishedSubtopics) * 1000) / 10;
}
