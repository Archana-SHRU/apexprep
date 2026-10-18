import type { AiExplanation } from '../ai/ai-provider';
import { normalizeMath } from '../common/learning/math-text';
import type { ExplanationParams } from './explanation-params';
import type { ScoredCandidate } from './retrieval';

/**
 * How well a generated explanation is actually supported by the retrieved notes.
 *
 * The requirements give the **bands** — >= 0.75 notes-only, 0.50-0.75 mostly-notes, < 0.50
 * general knowledge plus a review task — but not the formula. This is the formula chosen, and
 * it is recorded as a default in docs/DECISIONS.md rather than presented as a requirement:
 *
 *   grounding = (content terms of the explanation that appear in the retrieved notes)
 *               ÷ (content terms of the explanation that are not already in the question)
 *
 * Three deliberate properties:
 *
 *   * **It measures the output, not the retrieval.** A confident retrieval that the model then
 *     ignored must not score well, so the score is computed after generation, from the text
 *     the student would read.
 *   * **Terms the question already supplies are excluded.** Restating the stem is not
 *     evidence; otherwise every explanation would score highly just by quoting the question.
 *   * **The model's own citations are not used.** `citedBlockIds` is kept as metadata for
 *     admins, because a model asserting that it used the notes is not evidence that it did.
 *
 * Pure and deterministic: the same explanation and notes always give the same score, so a
 * stored `grounding_score` can be re-derived and audited.
 */

/** Words too common to count as evidence either way. */
const STOPWORDS = new Set([
  'a','about','above','after','again','all','also','an','and','any','are','as','at','be','because','been','before','being','below','between','both','but','by',
  'can','cannot','could','did','do','does','doing','down','during','each','either','few','for','from','further','get','gives','go','had','has','have','having',
  'he','her','here','hers','him','his','how','however','i','if','in','into','is','it','its','itself','just','let','like','make','many','may','me','might','more',
  'most','must','my','no','nor','not','now','of','off','on','once','one','only','or','other','our','out','over','own','per','same','she','should','since','so',
  'some','such','than','that','the','their','them','then','there','therefore','these','they','this','those','through','thus','to','too','two','under','until',
  'up','use','used','using','very','was','we','well','were','what','when','where','which','while','who','whom','why','will','with','within','would','you','your',
  'step','steps','first','second','third','next','finally','thefore','answer','option','options','question','correct','incorrect','means','gives','given',
]);

/**
 * Content terms of a text: mathematical notation normalised (so `\omega`, `ω` and `omega` are one term, and
 * LaTeX commands are not mistaken for words), then lowercased, punctuation stripped, stopwords and
 * 1-character tokens dropped. Both sides of every comparison go through this, so it changes notation only.
 */
export function contentTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of normalizeMath(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue; // bare numbers are arithmetic, not subject matter
    terms.add(raw);
  }
  return terms;
}

export interface GroundingInput {
  explanation: AiExplanation;
  /** The chunks that were put in front of the model. */
  chunks: readonly ScoredCandidate[];
  /** The question stem (and option texts), whose terms are excluded from the denominator. */
  questionText: string;
}

export interface GroundingAssessment {
  /** 0-1, rounded to the 3 decimals `numeric(4,3)` stores so the stored value is the computed one. */
  score: number;
  /** Terms judged. Reported so an admin can see whether the score rested on much evidence. */
  claimTermCount: number;
  supportedTermCount: number;
  /** Blocks whose text actually supported at least one claim term. */
  supportingBlockIds: string[];
  /** What the model said it used, kept for comparison. Never feeds the score. */
  citedBlockIds: string[];
}

/** The text of an explanation that carries claims: the summary, the steps and the key concept. */
function claimText(explanation: AiExplanation): string {
  return [explanation.summary, ...explanation.steps, explanation.keyConcept ?? '', explanation.commonMistake ?? ''].join('\n');
}

export function assessGrounding(input: GroundingInput): GroundingAssessment {
  const questionTerms = contentTerms(input.questionText);
  const claimTerms = [...contentTerms(claimText(input.explanation))].filter((t) => !questionTerms.has(t));

  const perBlock = new Map<string, Set<string>>();
  for (const candidate of input.chunks) {
    const terms = contentTerms(candidate.chunk.text + ' ' + (candidate.chunk.title ?? ''));
    for (const blockId of candidate.chunk.blockIds) {
      const existing = perBlock.get(blockId);
      if (existing) for (const t of terms) existing.add(t);
      else perBlock.set(blockId, new Set(terms));
    }
  }

  const supporting = new Set<string>();
  let supported = 0;
  for (const term of claimTerms) {
    let found = false;
    for (const [blockId, terms] of perBlock) {
      if (terms.has(term)) {
        supporting.add(blockId);
        found = true;
      }
    }
    if (found) supported += 1;
  }

  // An explanation with nothing to check is not grounded. Scoring it 1 would let an empty
  // or purely question-restating answer pass as notes-only.
  const score = claimTerms.length === 0 ? 0 : supported / claimTerms.length;

  return {
    score: Math.round(score * 1000) / 1000,
    claimTermCount: claimTerms.length,
    supportedTermCount: supported,
    supportingBlockIds: [...supporting].sort(),
    citedBlockIds: [...input.explanation.citedBlockIds].sort(),
  };
}

export type GroundingBand = 'notes_only' | 'mostly_notes' | 'insufficient';

/** Which band a score falls in. The two boundaries come from the requirements. */
export function groundingBand(score: number, params: ExplanationParams): GroundingBand {
  const { notes_only_min: notesOnly, mostly_notes_min: mostlyNotes } = params.explanation.grounding;
  if (score >= notesOnly) return 'notes_only';
  if (score >= mostlyNotes) return 'mostly_notes';
  return 'insufficient';
}
