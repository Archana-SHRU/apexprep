/**
 * Turning real values into the strings and bar widths the approved UI shows.
 *
 * This file exists so that two decisions live in exactly one place each:
 *
 * 1. **How "no data" is written.** A learner who has not practised something has no accuracy and no level.
 *    The API says `null`, and every screen renders the same em dash, so a blank never reads as a zero.
 * 2. **How an L1–L5 level becomes a bar.** The adaptive engine's mastery is a band, not a percentage. The
 *    existing progress-bar component takes 0–100, so a level is mapped onto it purely as a visual encoding:
 *    L1 → 20%, L2 → 40%, L3 → 60%, L4 → 80%, L5 → 100%. This is a drawing rule, not a score: nothing here
 *    computes mastery, and the number shown beside a bar is always the level ("L3"), never the width.
 */

/** What every screen shows where the backend has no value. */
export const NO_DATA = '—'

/** `L3`, or `—` when the learner has no level in that place yet. */
export function levelLabel(level: number | null | undefined): string {
  if (level === null || level === undefined) return NO_DATA
  // Subjects report a mean band to one decimal ("L3.4"); sub-topics report a whole band.
  return Number.isInteger(level) ? `L${level}` : `L${level.toFixed(1)}`
}

/**
 * The bar width for a level, on the 0–100 scale the Progress component expects.
 *
 * Returns 0 for "no level", which draws an empty track — the honest picture of nothing measured yet, and the
 * reason every caller pairs the bar with `levelLabel`'s em dash rather than letting the empty bar speak.
 */
export function levelToBar(level: number | null | undefined): number {
  if (level === null || level === undefined) return 0
  return Math.max(0, Math.min(100, level * 20))
}

/** `84.8%`, or `—`. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return NO_DATA
  return `${Number.isInteger(value) ? value : value.toFixed(digits)}%`
}

/** A plain count, or `—`. Zero is a real count and prints as `0`. */
export function num(value: number | null | undefined): string {
  return value === null || value === undefined ? NO_DATA : String(value)
}

/** `+3.2` / `−1.5` / `—`. The sign is the point, so it is always shown. */
export function delta(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return NO_DATA
  const rounded = Number(value.toFixed(digits))
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}`
}

/** `1m 52s` from seconds, or `—`. Used for pace, where the backend reports whole seconds. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return NO_DATA
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`
}

/** `1h 45m` from minutes, for today's study time. Zero minutes is a real answer and prints as `0m`. */
export function studyTime(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return NO_DATA
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  return h === 0 ? `${m}m` : `${h}h ${m % 60}m`
}

/** `today` / `yesterday` / `12 days ago`, or `—` when never practised. */
export function sinceDays(days: number | null | undefined): string {
  if (days === null || days === undefined) return NO_DATA
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
