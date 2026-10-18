import { normalizeMath } from '../../common/learning/math-text';
import { contentTerms } from '../../explanations/grounding';
import { NOTES_LIMITS, type RawNotes } from './notes.prompt';

/**
 * The gate revision notes pass before they are stored or shown. Pure.
 *
 * Notes are *revision* material a student will trust, so the rule is stricter than for a single
 * explanation: every item must be traceable to the source it claims, item by item.
 *
 *   1. **Citations are real.** A cited block id that was not in the source is removed; an item left
 *      citing nothing is dropped — it may be true, but nothing shows it came from the course.
 *   2. **Each item is supported by what it cites.** Its content terms must mostly appear in the text
 *      of the blocks it cites (the same term measure the explanation grounding uses).
 *   3. **Formulas are checked symbol by symbol.** A formula is kept only when the notes it cites
 *      contain it — as written, or with every multi-letter symbol and most single-letter symbols
 *      present. A plausible formula the notes never state is exactly what must not appear.
 *   4. **Overall grounding** across everything kept must reach the configured band, and something
 *      must be left. Otherwise the notes are rejected as a whole.
 */

export interface NotesSource {
  blockId: string;
  title: string | null;
  text: string;
}

export interface NoteItem {
  text: string;
  sourceBlockIds: string[];
}

export interface ValidatedNotes {
  title: string;
  overview: string;
  keyPoints: NoteItem[];
  concepts: { term: string; explanation: string; sourceBlockIds: string[] }[];
  formulas: { expression: string; meaning: string; sourceBlockIds: string[] }[];
  commonMistakes: NoteItem[];
  quickRevision: NoteItem[];
}

export interface NotesValidation {
  ok: boolean;
  notes: ValidatedNotes;
  groundingScore: number;
  /** Why each dropped item was dropped; kept in diagnostics for review, never shown to students. */
  dropped: { section: string; text: string; reason: string }[];
  /** Why the notes as a whole were rejected, when they were. */
  rejectedBecause: string | null;
  usedBlockIds: string[];
}

/** An item is kept when at least this share of its content terms appear in the blocks it cites. */
export const ITEM_SUPPORT_MIN = 0.5;

export function validateNotes(raw: RawNotes, sources: readonly NotesSource[], minGrounding: number): NotesValidation {
  const byId = new Map(sources.map((s) => [s.blockId, s]));
  const termsById = new Map(sources.map((s) => [s.blockId, contentTerms(`${s.title ?? ''} ${s.text}`)]));
  const dropped: NotesValidation['dropped'] = [];

  const citationsOf = (ids: readonly string[]): string[] => [...new Set(ids.filter((id) => byId.has(id)))];

  const supported = (text: string, ids: readonly string[]): boolean => {
    const terms = [...contentTerms(text)];
    if (terms.length === 0) return true; // nothing to check, e.g. a pure symbol line; citations still required
    const available = new Set<string>();
    for (const id of ids) for (const t of termsById.get(id) ?? []) available.add(t);
    return terms.filter((t) => available.has(t)).length / terms.length >= ITEM_SUPPORT_MIN;
  };

  const keep = <T extends { sourceBlockIds: string[] }>(section: string, items: readonly T[], textOf: (item: T) => string, limit: number): T[] => {
    const out: T[] = [];
    for (const item of items) {
      const ids = citationsOf(item.sourceBlockIds);
      if (ids.length === 0) {
        dropped.push({ section, text: textOf(item).slice(0, 200), reason: 'cites no note that was in the source' });
        continue;
      }
      if (!supported(textOf(item), ids)) {
        dropped.push({ section, text: textOf(item).slice(0, 200), reason: 'not supported by the notes it cites' });
        continue;
      }
      if (out.length >= limit) {
        dropped.push({ section, text: textOf(item).slice(0, 200), reason: `over the limit of ${limit}` });
        continue;
      }
      out.push({ ...item, sourceBlockIds: ids });
    }
    return out;
  };

  const formulas: ValidatedNotes['formulas'] = [];
  for (const f of raw.formulas) {
    const ids = citationsOf(f.sourceBlockIds);
    if (ids.length === 0) {
      dropped.push({ section: 'formulas', text: f.expression, reason: 'cites no note that was in the source' });
      continue;
    }
    const citedText = ids.map((id) => byId.get(id)!.text).join('\n');
    if (!formulaAppearsIn(f.expression, citedText)) {
      dropped.push({ section: 'formulas', text: f.expression, reason: 'the formula does not appear in the notes it cites' });
      continue;
    }
    if (formulas.length >= NOTES_LIMITS.formulas) continue;
    formulas.push({ ...f, sourceBlockIds: ids });
  }

  const notes: ValidatedNotes = {
    title: raw.title,
    overview: raw.overview,
    keyPoints: keep('keyPoints', raw.keyPoints, (i) => i.text, NOTES_LIMITS.keyPoints),
    concepts: keep('concepts', raw.concepts, (i) => `${i.term} ${i.explanation}`, NOTES_LIMITS.concepts),
    formulas,
    commonMistakes: keep('commonMistakes', raw.commonMistakes, (i) => i.text, NOTES_LIMITS.commonMistakes),
    quickRevision: keep('quickRevision', raw.quickRevision, (i) => i.text, NOTES_LIMITS.quickRevision),
  };

  // Overall grounding: every claim term across what was kept (overview included), against all sources.
  const allTerms = new Set<string>();
  for (const terms of termsById.values()) for (const t of terms) allTerms.add(t);
  const claimText = [
    notes.overview,
    ...notes.keyPoints.map((i) => i.text),
    ...notes.concepts.map((i) => `${i.term} ${i.explanation}`),
    ...notes.formulas.map((i) => i.meaning),
    ...notes.commonMistakes.map((i) => i.text),
    ...notes.quickRevision.map((i) => i.text),
  ].join('\n');
  const claimTerms = [...contentTerms(claimText)];
  const groundingScore = claimTerms.length === 0 ? 0 : Math.round((claimTerms.filter((t) => allTerms.has(t)).length / claimTerms.length) * 1000) / 1000;

  const itemCount = notes.keyPoints.length + notes.concepts.length + notes.formulas.length + notes.commonMistakes.length + notes.quickRevision.length;
  let rejectedBecause: string | null = null;
  if (itemCount === 0) rejectedBecause = 'no item of the notes could be traced to the source content';
  else if (notes.keyPoints.length === 0 && notes.concepts.length === 0) rejectedBecause = 'no key point or concept survived the grounding checks';
  else if (groundingScore < minGrounding) rejectedBecause = `grounding ${groundingScore} is below the configured ${minGrounding}`;

  const used = new Set<string>();
  for (const section of [notes.keyPoints, notes.concepts, notes.formulas, notes.commonMistakes, notes.quickRevision]) {
    for (const item of section) for (const id of item.sourceBlockIds) used.add(id);
  }

  return { ok: rejectedBecause === null, notes, groundingScore, dropped, rejectedBecause, usedBlockIds: [...used].sort() };
}

/** Symbols of a formula: words (Greek letters by name, however written) and numbers. */
function symbolsOf(text: string): string[] {
  return (normalizeMath(text).match(/[\p{L}]+|\d+(?:\.\d+)?/gu) ?? []).map((s) => s.toLowerCase());
}

/**
 * Notation and whitespace removed, so "F = m a", "F=ma" and "$F = m\cdot a$" compare equal, and a LaTeX
 * formula can be found in plain-text notes.
 */
function squash(text: string): string {
  return normalizeMath(text)
    .toLowerCase()
    .replace(/[×·*]/g, '')
    .replace(/\s+/g, '');
}

/**
 * Whether a formula is stated in a text: verbatim (modulo spacing and multiplication signs), or with
 * every multi-letter symbol and at least three quarters of all symbols present as standalone tokens.
 */
export function formulaAppearsIn(expression: string, text: string): boolean {
  if (squash(text).includes(squash(expression))) return true;
  const symbols = symbolsOf(expression);
  if (symbols.length === 0) return false;
  const available = new Set(symbolsOf(text));
  if (symbols.some((s) => s.length > 1 && !/^\d/.test(s) && !available.has(s))) return false;
  return symbols.filter((s) => available.has(s)).length / symbols.length >= 0.75;
}
