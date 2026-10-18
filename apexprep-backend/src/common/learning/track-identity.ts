/**
 * What the safety rules need to know about a track.
 *
 * Two requirements single out Olympiad content — generated explanations need a human before a
 * student sees them (FR-6.x), and L5 Olympiad content can never be auto-approved (FR-7.x) — so
 * something has to decide whether a track *is* an Olympiad track.
 *
 * Phases 6 and 7 had nothing in the schema to ask, so both rules matched configured substrings
 * against the track's **slug** (docs/DECISIONS.md §B47). That was the only option at the time and
 * it was documented as a compromise, but it makes a safety rule depend on a name: renaming
 * `maths-olympiad` to `maths-imo` silently switches off human review, and nothing fails.
 *
 * Migration 0013 adds `tracks.kind`, so the question now has a real answer and
 * `kind = 'olympiad'` is the authoritative signal.
 *
 * The slug patterns are kept as a **fallback, not as the rule**:
 *
 *   * `kind` is NULL on every track that existed before 0013, and 0013 deliberately back-fills
 *     nothing (inventing a category for existing rows is exactly what the brief forbids). If
 *     `kind = 'olympiad'` were the only signal, applying the migration would *remove* human review
 *     from every Olympiad track already in the database. That is a safety regression shipped by a
 *     schema change, which is the worst kind.
 *   * A track whose slug says Olympiad but whose `kind` says something else is a contradiction, and
 *     the two possible readings are "hold it for a human" and "show it to a student". This module
 *     takes the first. Over-triggering costs an admin a click; under-triggering is the harm the
 *     requirement exists to prevent.
 *
 * So: `kind = 'olympiad'` is sufficient on its own and independent of any name, which is what makes
 * it the actual check. The slug match survives only to keep uncategorised and mislabelled tracks
 * protected, and it can be switched off per organisation by emptying the pattern list — at which
 * point `kind` is the whole rule.
 *
 * Pure: no database, no configuration of its own, no clock.
 */

/** The `kind` value that marks an Olympiad track. Mirrors migration 0013's CHECK constraint. */
export const OLYMPIAD_TRACK_KIND = 'olympiad';

export interface TrackIdentity {
  /** `tracks.slug`. */
  slug: string;
  /** `tracks.kind`, or null for a track that has not been categorised (every pre-0013 track). */
  kind: string | null;
}

/**
 * Whether this track is one the Olympiad safety rules apply to.
 *
 * @param track       the track's slug and kind, as stored
 * @param slugPatterns the configured fallback patterns, used only as described above
 */
export function isOlympiadTrack(track: TrackIdentity, slugPatterns: readonly string[]): boolean {
  // Authoritative, whatever the track is called.
  if (track.kind === OLYMPIAD_TRACK_KIND) return true;
  return matchesSlugPattern(track.slug, slugPatterns);
}

/** Whether a track's slug contains one of the configured patterns, case-insensitively. */
export function matchesSlugPattern(trackSlug: string, patterns: readonly string[]): boolean {
  const slug = trackSlug.toLowerCase();
  return patterns.some((p) => slug.includes(p.toLowerCase()));
}
