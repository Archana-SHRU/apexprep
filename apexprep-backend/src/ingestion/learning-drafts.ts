import type { ValidatedNotes } from '../learning-ai/notes/notes.validation';

/**
 * Drafts of learning material, as the ingestion preview carries them. Pure helpers; the service that asks a model
 * and stores the result is `learning-drafts.service.ts`.
 *
 * A draft is stored as an ordinary `content_blocks` row (`kind = theory`, `format = callout`) so it travels through
 * the same preview, editing, rejecting and approving as everything else in the document — with one difference that
 * is the whole point: its provenance is `ai_generated`, and publishing it does **not** make it a theory block.
 * Notes a model wrote must never become the "source material" that the tutor, the explanations and later revision
 * notes are grounded in, or a model would end up citing itself. An approved draft becomes the sub-topic's
 * revision notes (the table the learner-facing feature already reads), nothing else.
 */

export interface RevisionNotesDraft {
  kind: 'revision_notes';
  notes: ValidatedNotes;
  /** The blocks the notes cite. */
  sourceBlockIds: string[];
  /** Every theory block the model was shown. An approved draft is only activated when these are all the sub-topic has. */
  coveredBlockIds: string[];
  /** What group of blocks it was written from: a sub-topic id, or the path the PDF's headings propose. */
  groupKey: string;
  groundingScore: number;
  promptVersion: string;
  provider: string;
  model: string;
  /** A person edited the notes after they were written. The grounding score then describes the model's version. */
  edited?: boolean;
  /** Set when the draft was approved: the revision-notes row it became, or why it was not activated. */
  activation?: Record<string, unknown>;
}

export function isRevisionNotesDraft(value: unknown): value is RevisionNotesDraft {
  return value !== null && typeof value === 'object' && (value as { kind?: unknown }).kind === 'revision_notes';
}

/** The draft stored on a block's `content_json`, or null when the block is not one. */
export function draftOf(contentJson: unknown): RevisionNotesDraft | null {
  const draft = contentJson !== null && typeof contentJson === 'object' ? (contentJson as { draft?: unknown }).draft : undefined;
  return isRevisionNotesDraft(draft) ? draft : null;
}

/** Readable text for a set of notes: what is listed beside the document's own text and searched in the review list. */
export function renderNotesText(notes: ValidatedNotes): string {
  const lines: string[] = [notes.title, '', notes.overview];
  const section = (heading: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push('', heading, ...items.map((i) => `- ${i}`));
  };
  section('Key points', notes.keyPoints.map((k) => k.text));
  section('Concepts', notes.concepts.map((c) => `${c.term}: ${c.explanation}`));
  section('Formulas', notes.formulas.map((f) => `${f.expression} — ${f.meaning}`));
  section('Common mistakes', notes.commonMistakes.map((m) => m.text));
  section('Quick revision', notes.quickRevision.map((q) => q.text));
  return lines.join('\n');
}

/** Whether `notes` has the shape an edit may submit: strings where strings belong, arrays of items, nothing else. */
export function isNotesShape(value: unknown): value is ValidatedNotes {
  if (value === null || typeof value !== 'object') return false;
  const n = value as Record<string, unknown>;
  const str = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const ids = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const list = (v: unknown, each: (item: Record<string, unknown>) => boolean): boolean =>
    Array.isArray(v) && v.length <= 40 && v.every((item) => item !== null && typeof item === 'object' && each(item as Record<string, unknown>));
  return (
    str(n.title, 200) &&
    str(n.overview, 1500) &&
    list(n.keyPoints, (i) => str(i.text, 600) && ids(i.sourceBlockIds)) &&
    list(n.concepts, (i) => str(i.term, 120) && str(i.explanation, 800) && ids(i.sourceBlockIds)) &&
    list(n.formulas, (i) => str(i.expression, 300) && str(i.meaning, 600) && ids(i.sourceBlockIds)) &&
    list(n.commonMistakes, (i) => str(i.text, 600) && ids(i.sourceBlockIds)) &&
    list(n.quickRevision, (i) => str(i.text, 300) && ids(i.sourceBlockIds))
  );
}
