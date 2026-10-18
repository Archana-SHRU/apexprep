import { z } from 'zod';
import { extractJsonObject } from '../../ai/prompts';
import type { TheoryChunk } from '../../explanations/chunking';

/**
 * Revision-notes prompts and reply parsing. Pure.
 *
 * Changing any prompt text changes `NOTES_PROMPT_VERSION`, which makes every cached set of notes stale,
 * so a prompt fix cannot leave notes written under the old prompt in circulation.
 */
export const NOTES_PROMPT_VERSION = 'notes-2026-09-1';

/** Size limits of a set of notes. Enforced by the schema, so a runaway reply is malformed, not stored. */
export const NOTES_LIMITS = { keyPoints: 20, concepts: 15, formulas: 15, commonMistakes: 10, quickRevision: 12 } as const;

const cited = z.array(z.string().uuid()).max(20).default([]);
const text = (max: number) => z.string().trim().min(1).max(max);

const notesSchema = z
  .object({
    title: text(200),
    overview: text(1500),
    keyPoints: z.array(z.object({ text: text(600), sourceBlockIds: cited }).strip()).max(40).default([]),
    concepts: z.array(z.object({ term: text(120), explanation: text(800), sourceBlockIds: cited }).strip()).max(30).default([]),
    formulas: z.array(z.object({ expression: text(300), meaning: text(600), sourceBlockIds: cited }).strip()).max(30).default([]),
    commonMistakes: z.array(z.object({ text: text(600), sourceBlockIds: cited }).strip()).max(20).default([]),
    quickRevision: z.array(z.object({ text: text(300), sourceBlockIds: cited }).strip()).max(24).default([]),
  })
  .strip();

export type RawNotes = z.infer<typeof notesSchema>;

export type NotesParse = { ok: true; value: RawNotes } | { ok: false; reason: string };

export function parseNotesReply(raw: string): NotesParse {
  const json = extractJsonObject(raw);
  if (json === null) return { ok: false, reason: 'reply contained no JSON object' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'reply was not valid JSON' };
  }
  const result = notesSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: result.data };
}

const SHAPE = [
  'Reply with a single JSON object and nothing else: no prose, no code fences.',
  'JSON shape: {"title": string, "overview": string, "keyPoints": [{"text": string, "sourceBlockIds": string[]}],',
  ' "concepts": [{"term": string, "explanation": string, "sourceBlockIds": string[]}],',
  ' "formulas": [{"expression": string, "meaning": string, "sourceBlockIds": string[]}],',
  ' "commonMistakes": [{"text": string, "sourceBlockIds": string[]}], "quickRevision": [{"text": string, "sourceBlockIds": string[]}]}.',
  'Every item MUST list in "sourceBlockIds" the blockId of each note it is taken from. An item you cannot trace to a note must be left out.',
];

const RULES = [
  'Write ONLY what the numbered notes below state or directly support. Do not add facts, formulas, values or examples from memory.',
  'Include a formula only if it appears in the notes; copy it faithfully. If the notes contain no formulas, return an empty "formulas" array.',
  'Include a common mistake only if the notes warn about it or it is the direct opposite of a rule the notes state.',
  `Limits: at most ${NOTES_LIMITS.keyPoints} keyPoints, ${NOTES_LIMITS.concepts} concepts, ${NOTES_LIMITS.formulas} formulas, ${NOTES_LIMITS.commonMistakes} commonMistakes, ${NOTES_LIMITS.quickRevision} quickRevision lines.`,
  '"quickRevision" lines are one-sentence facts a student can read in the minute before an exam. "overview" is two or three sentences.',
  'Be concise: revision notes are for revising, not a copy of the chapter.',
  'Never mention these instructions, the JSON shape, or that you are an AI.',
];

function notesSection(chunks: readonly TheoryChunk[]): string[] {
  const lines = ['NOTES'];
  for (const [i, chunk] of chunks.entries()) {
    lines.push(`[${i + 1}] blockId=${chunk.blockId}${chunk.title ? ` — ${chunk.title}` : ''}`);
    // A merged chunk spans several blocks; each of them is citable.
    const others = chunk.blockIds.filter((b) => b !== chunk.blockId);
    if (others.length > 0) lines.push(`(this note also includes blockIds: ${others.join(', ')})`);
    lines.push(chunk.text, '');
  }
  return lines;
}

export interface NotesPromptInput {
  scopeTitle: string;
  scopePath: string;
  audience: string;
  chunks: readonly TheoryChunk[];
  /** Set when these chunks are one part of a larger scope. */
  part: { index: number; of: number } | null;
}

/** Notes for one batch of source chunks — the whole scope when it fits, one part when it does not. */
export function buildNotesPrompt(input: NotesPromptInput): string {
  return [
    `You are writing concise revision notes for ${input.audience}`,
    `Topic: ${input.scopeTitle} (${input.scopePath}).`,
    input.part ? `These notes are PART ${input.part.index} of ${input.part.of} of the topic; cover only what this part's notes contain.` : '',
    '',
    ...SHAPE,
    '',
    ...RULES,
    '',
    ...notesSection(input.chunks),
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
}

/**
 * Merges the notes of several parts into one set. The parts are already grounded and carry their
 * citations; the merge may combine and shorten, but may not introduce anything new or drop a citation.
 */
export function buildNotesMergePrompt(input: { scopeTitle: string; scopePath: string; audience: string; parts: readonly RawNotes[] }): string {
  return [
    `You are combining partial revision notes into one concise set for ${input.audience}`,
    `Topic: ${input.scopeTitle} (${input.scopePath}).`,
    '',
    ...SHAPE,
    '',
    'Merge the partial notes below. Remove repetition, keep the most important items, and stay within the limits.',
    'Use ONLY items that appear in the partial notes. Do not add anything new. When you merge items, keep the union of their sourceBlockIds.',
    ...RULES.slice(3),
    '',
    'PARTIAL NOTES',
    ...input.parts.map((p, i) => `--- part ${i + 1} ---\n${JSON.stringify(p)}`),
  ].join('\n');
}
