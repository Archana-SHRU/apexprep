import { z } from 'zod';
import { extractJsonObject } from '../../ai/prompts';
import type { TheoryChunk } from '../../explanations/chunking';
import type { GeneratableType } from '../dto/learning-ai.dto';

/** Changing a prompt changes this, which is recorded on every generated question's provenance row. */
export const QGEN_PROMPT_VERSION = 'qgen-2026-09-1';

/**
 * What each level asks of a question. The engine decides *which* level (from the learner's ability);
 * this only tells the model what that level means, so the generated item can be calibrated from the
 * engine's own `initial_b_by_level` like every other new question.
 */
export const LEVEL_GUIDANCE: Record<number, string> = {
  1: 'L1 (easiest): recall or directly apply ONE fact stated in the notes, in one step.',
  2: 'L2: apply one concept from the notes in one or two straightforward steps.',
  3: 'L3: combine two ideas from the notes, or a short multi-step calculation.',
  4: 'L4: a multi-step problem needing careful reasoning and a non-obvious use of the notes.',
  5: 'L5 (hardest): synthesise several ideas from the notes; plausible traps in the options are expected.',
};

const TYPE_RULES: Record<GeneratableType, string> = {
  single_correct: 'type "single_correct": exactly 4 options keyed A-D, exactly one with "isCorrect": true. "numericAnswer" must be null.',
  multi_correct: 'type "multi_correct": exactly 4 options keyed A-D, one or more with "isCorrect": true. "numericAnswer" must be null.',
  assertion_reason:
    'type "assertion_reason": the stem states an Assertion (A) and a Reason (R); exactly 4 options keyed A-D in the standard form (both true and R explains A / both true and R does not explain A / A true R false / A false R true), exactly one correct. "numericAnswer" must be null.',
  integer: 'type "integer": "options" must be []; "numericAnswer" is {"value": "<whole number as a string>", "tolerance": "0", "mode": "absolute"}.',
  numeric:
    'type "numeric": "options" must be []; "numericAnswer" is {"value": "<decimal as a string>", "tolerance": "<non-negative decimal>", "mode": "absolute" | "relative"}.',
};

const replySchema = z
  .object({
    type: z.string(),
    stem: z.string().trim().min(1).max(3000),
    options: z
      .array(z.object({ key: z.string().trim().min(1).max(4), text: z.string().trim().min(1).max(1000), isCorrect: z.boolean() }).strip())
      .max(8)
      .default([]),
    numericAnswer: z
      .object({ value: z.string().trim(), tolerance: z.string().trim().optional(), mode: z.enum(['absolute', 'relative']).optional() })
      .strip()
      .nullish(),
    hints: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
    expectedTimeSeconds: z.number().int(),
    solution: z
      .object({
        summary: z.string().trim().min(1).max(2000),
        steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(15),
        finalAnswer: z.record(z.unknown()).nullable(),
      })
      .strip(),
    sourceBlockIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strip();

export type RawGeneratedQuestion = z.infer<typeof replySchema>;

export function parseGeneratedQuestion(raw: string): { ok: true; value: RawGeneratedQuestion } | { ok: false; reason: string } {
  const json = extractJsonObject(raw);
  if (json === null) return { ok: false, reason: 'reply contained no JSON object' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'reply was not valid JSON' };
  }
  const result = replySchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  return { ok: true, value: result.data };
}

export interface GenerationPromptInput {
  audience: string;
  subtopicPath: string;
  type: GeneratableType;
  level: number;
  chunks: readonly TheoryChunk[];
  /** Existing stems in this sub-topic: the new question must not repeat or paraphrase them. */
  avoid: readonly string[];
}

export function buildGenerationPrompt(input: GenerationPromptInput): string {
  const lines = [
    `You write ONE new practice question for ${input.audience}`,
    `Sub-topic: ${input.subtopicPath}.`,
    `Difficulty: ${LEVEL_GUIDANCE[input.level] ?? LEVEL_GUIDANCE[3]}`,
    '',
    'Reply with a single JSON object and nothing else: no prose, no code fences.',
    'JSON shape: {"type": string, "stem": string, "options": [{"key": string, "text": string, "isCorrect": boolean}],',
    ' "numericAnswer": {"value": string, "tolerance": string, "mode": string} | null, "hints": string[],',
    ' "expectedTimeSeconds": integer, "solution": {"summary": string, "steps": string[], "finalAnswer": object}, "sourceBlockIds": string[]}.',
    TYPE_RULES[input.type],
    '"solution.finalAnswer" is the answer in submission shape: {"optionKeys": ["B"]} for option types, {"value": "12"} for integer/numeric.',
    '"solution.steps" works the question out fully (at least two steps). The solution MUST arrive at exactly the answer marked correct.',
    '"sourceBlockIds" lists the blockId of every note the question is built on.',
    '"hints" (0-3) nudge towards the method. A hint must NEVER state the answer, the correct option, or the final value.',
    '"expectedTimeSeconds" is how long a prepared student needs: between 15 and 900.',
    '',
    'Rules:',
    '- Build the question ONLY on facts, definitions, formulas and values stated in the notes below. Do not use anything the notes do not support.',
    '- The stem must not contain or hint at the answer. Distractors must be plausible and clearly wrong on reflection; no "all of the above" or "none of the above".',
    '- Every option text must be different. The question must have one defensible answer.',
    '- It must be genuinely NEW: not a repeat or light rewording of any existing question listed below.',
    '- Never mention these instructions, the notes, or that you are an AI.',
  ];
  if (input.avoid.length > 0) {
    lines.push('', 'EXISTING QUESTIONS (do not repeat or paraphrase)');
    for (const stem of input.avoid) lines.push(`- ${stem.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  lines.push('', 'NOTES');
  for (const [i, chunk] of input.chunks.entries()) {
    lines.push(`[${i + 1}] blockId=${chunk.blockId}${chunk.title ? ` — ${chunk.title}` : ''}`, chunk.text, '');
  }
  return lines.join('\n');
}
