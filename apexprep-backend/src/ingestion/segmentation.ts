import { createHash } from 'node:crypto';
import type { BlockFormat } from '../database/schema';
import { isStructuralHeadingLine } from './hierarchy';

/**
 * Cutting a page's text into candidate content blocks, and guessing what each one is.
 *
 * Pure and deterministic: the same page text always segments and classifies the same way, so a
 * retried job produces the same blocks with the same `content_hash` and nothing is duplicated.
 *
 * This is a **rule-based** classifier, and that is a deliberate choice rather than a placeholder.
 * Question numbering, option labels, "Solution:" and "Answer:" markers are typographic
 * conventions that textbooks follow closely, so rules read them accurately, cost nothing, and —
 * unlike a model — give the same answer twice. Where the rules are not confident they say so, and
 * the confidence is what routes a block to a human. A model can be layered on later behind the
 * same interface: `classified_by` already distinguishes `rule`, `model` and `human`.
 */

export type BlockKind = 'theory' | 'question' | 'solution' | 'ambiguous';

export interface SegmentedBlock {
  kind: BlockKind;
  format: BlockFormat;
  title: string | null;
  text: string;
  /** 0-1. Below the configured floor the block is sent to review rather than trusted. */
  confidence: number;
  /** Why the classifier decided this, recorded for the reviewer. */
  reason: string;
  /** 1-based page this came from. */
  sourcePage: number;
  /** Position within the document, so reading order survives. */
  sortOrder: number;
  /** A question number the source printed, used later to match solutions. */
  sourceNumber: string | null;
  contentHash: string;
}

/** A page as the extractor produced it. */
export interface PageText {
  pageNumber: number;
  text: string;
  /** True when the text came from OCR, which lowers every confidence on the page. */
  fromOcr?: boolean;
  /** The page's own OCR confidence, when it was OCR'd. */
  ocrConfidence?: number | null;
}

// Typographic markers. These are conventions, not thresholds: they describe the source
// documents rather than tuning the pipeline, so they live here and not in engine_config.
const QUESTION_NUMBER = /^(?:Q\s*\.?\s*)?(\d{1,3})\s*[.)\]:]\s+(?=\S)|^Q\s*\.?\s*(\d{1,3})\b/i;
const OPTION_LINE = /^\(?([A-Da-d1-4])\)?\s*[.)\]]?\s+\S/;
// A marker needs punctuation or a number after the word, so the plural heading "Solutions" that
// opens a solutions section stays a heading rather than becoming an empty solution block.
const SOLUTION_MARKER = /^(?:Solution|Sol|Answer|Ans|Explanation)\b\s*(?:\d{1,3}\s*)?[:.)-]|^(?:Solution|Sol|Answer|Ans|Explanation)\b\s+\d/i;
/** The question number a solution names: "Solution 7.", "Sol. 7", "Answer 7)". */
const SOLUTION_NUMBER = /^(?:Solution|Sol|Answer|Ans|Explanation)\b\s*\.?\s*(\d{1,3})\b/i;
const ANSWER_INLINE = /\b(?:answer|ans)\s*[:=]\s*\(?([A-Da-d1-4])\)?/i;
const HEADING = /^(?:\d+(?:\.\d+)*\s+)?[A-Z][A-Za-z0-9 ,'()/-]{2,80}$/;
const FORMULA_HINT = /[=∫∑√±×÷θωαβγλμπΔ∂]|\b(?:sin|cos|tan|log|ln|sqrt)\b|\^|_\{|\\frac|\[formula:\d+\]/;
const LIST_LINE = /^(?:[-•*]|\(?[ivx]+\)|\d+\.)\s+\S/i;

/**
 * Splits pages into blocks. A block is a run of lines that belongs together: a heading with its
 * paragraph, a question with its options, a solution with its working.
 */
export function segmentPages(
  pages: readonly PageText[],
  options: {
    /**
     * Lines (exactly as extracted) that must start a block: the headings a model picked from the PDF's own
     * lines when the document has no numbered structure, so each section's text sits under its heading.
     */
    boundaries?: ReadonlySet<string>;
  } = {},
): SegmentedBlock[] {
  const blocks: SegmentedBlock[] = [];
  let sortOrder = 0;

  for (const page of pages) {
    for (const chunk of splitIntoChunks(page.text, options.boundaries)) {
      const classified = classifyChunk(chunk, page);
      blocks.push({ ...classified, sourcePage: page.pageNumber, sortOrder: sortOrder++, contentHash: hashText(classified.text) });
    }
  }
  return blocks;
}

/**
 * Chunk boundaries: a blank line, the start of a new numbered question, a solution marker, or a
 * numbered or "Chapter N" section heading.
 * Option lines never start a chunk — they belong to the question above them.
 */
function splitIntoChunks(text: string, boundaries?: ReadonlySet<string>): string[][] {
  const lines = text.split('\n').map((l) => l.trim());
  const chunks: string[][] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.some((l) => l.length > 0)) chunks.push([...current]);
    current = [];
  };

  for (const line of lines) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (current.length > 0 && (boundaries?.has(line) || startsNewChunk(line, current))) flush();
    current.push(line);
  }
  flush();
  return chunks;
}

/**
 * Whether this line begins a new block, given what the current one already holds.
 *
 * Two cases make this more than a regular expression, and both are common enough that getting them
 * wrong means extracting nothing usable from an ordinary textbook page:
 *
 *   * **A question number and an option label look identical.** `2.` is question two, and it is
 *     also the second option of a numerically labelled list. What tells them apart is the sequence:
 *     a label that continues the options above it is an option, and one that does not is the next
 *     question.
 *   * **`Answer: B` belongs to the question, `Solution 2.` does not.** A short answer line under a
 *     set of options is the question's own answer key — splitting it off would leave the question
 *     with no correct answer and make it unpublishable. A worked solution is its own block.
 */
function startsNewChunk(line: string, current: readonly string[]): boolean {
  // "3.1 Distance and Displacement" begins a section even with no blank line above it, so the
  // section's text is not filed under the heading before it (see hierarchy.ts).
  if (isStructuralHeadingLine(line)) return true;
  if (SOLUTION_MARKER.test(line)) return !isOwnAnswerLine(line, current);
  if (!QUESTION_NUMBER.test(line)) return false;
  return !continuesOptions(line, current);
}

/**
 * A short `Answer:`/`Ans:` line closing the question above it.
 *
 * True for the answer key a textbook prints under a question — under its options, or under a
 * numeric stem that has none. It is the question's own line, so splitting it off would leave the
 * question with no correct answer and make it unpublishable. A second answer line in one chunk is
 * a new block, because one question has one answer.
 */
function isOwnAnswerLine(line: string, current: readonly string[]): boolean {
  if (!ANSWER_INLINE.test(line) && !/^(?:Answer|Ans)\b\s*[:.=]/i.test(line)) return false;
  if (line.length > 60) return false;
  if (current.some((l) => ANSWER_INLINE.test(l))) return false;
  const numberedStem = QUESTION_NUMBER.test(current[0] ?? '');
  return numberedStem || current.filter((l) => OPTION_LINE.test(l)).length >= 2;
}

/** Whether this option-looking line is the next label in the sequence already under way. */
function continuesOptions(line: string, current: readonly string[]): boolean {
  const here = optionLabel(line);
  if (here === null) return false;
  const labels = current.map(optionLabel).filter((l): l is string => l !== null);
  const previous = labels[labels.length - 1];
  if (previous === undefined) return false;
  return nextLabel(previous) === here;
}

function optionLabel(line: string): string | null {
  const match = OPTION_LINE.exec(line.trim());
  return match ? match[1]!.toUpperCase() : null;
}

/** `A` → `B`, `1` → `2`. Anything else has no successor. */
function nextLabel(label: string): string | null {
  if (/^[A-D]$/.test(label)) return label === 'D' ? null : String.fromCharCode(label.charCodeAt(0) + 1);
  if (/^[1-4]$/.test(label)) return label === '4' ? null : String(Number(label) + 1);
  return null;
}

/** What a chunk is, how sure we are, and why. */
function classifyChunk(lines: readonly string[], page: PageText): Omit<SegmentedBlock, 'sourcePage' | 'sortOrder' | 'contentHash'> {
  const text = lines.join('\n');
  const first = lines[0] ?? '';
  const options = lines.filter((l) => OPTION_LINE.test(l));
  const numberMatch = QUESTION_NUMBER.exec(first);
  const sourceNumber = numberMatch ? (numberMatch[1] ?? numberMatch[2] ?? null) : null;

  // A solution marker is the strongest signal there is: the source labelled it.
  if (SOLUTION_MARKER.test(first)) {
    // "Solution 7." names question 7. Without this the matcher loses the numbering it trusts most
    // and falls back to proximity, which is exactly the case a solutions section printed fifty
    // pages after the questions defeats.
    const named = SOLUTION_NUMBER.exec(first);
    return {
      kind: 'solution',
      format: FORMULA_HINT.test(text) ? 'formula' : 'paragraph',
      title: null,
      text,
      confidence: scale(0.9, page),
      reason: 'the block opens with a solution or answer marker',
      sourceNumber: named ? named[1]! : sourceNumber,
    };
  }

  // A numbered stem with two or more option lines is a question, near enough to certain.
  if (sourceNumber !== null && options.length >= 2) {
    return {
      kind: 'question',
      format: 'paragraph',
      title: null,
      text,
      confidence: scale(options.length >= 4 ? 0.95 : 0.8, page),
      reason: `numbered stem with ${options.length} option lines`,
      sourceNumber,
    };
  }

  // Numbered, no options: a numeric or long-form question, or a numbered heading. An inline
  // answer settles it; otherwise it is a question worth a second look.
  if (sourceNumber !== null) {
    const hasAnswer = ANSWER_INLINE.test(text);
    const questionLike = /\?|\bfind\b|\bcalculate\b|\bdetermine\b|\bevaluate\b|\bprove\b|\bshow that\b/i.test(text);
    if (hasAnswer || questionLike) {
      return {
        kind: 'question',
        format: FORMULA_HINT.test(text) ? 'formula' : 'paragraph',
        title: null,
        text,
        confidence: scale(hasAnswer ? 0.8 : 0.6, page),
        reason: hasAnswer ? 'numbered stem with an inline answer' : 'numbered stem phrased as a question, with no options',
        sourceNumber,
      };
    }
    return {
      kind: 'ambiguous',
      format: 'paragraph',
      title: null,
      text,
      confidence: scale(0.4, page),
      reason: 'numbered, but neither options nor question wording: it may be a numbered heading',
      sourceNumber,
    };
  }

  // Option lines with no stem above them: the page break cut a question in half.
  if (options.length >= 2 && lines.length === options.length) {
    return {
      kind: 'ambiguous',
      format: 'list',
      title: null,
      text,
      confidence: scale(0.3, page),
      reason: 'option lines with no stem: the question may be split across a page boundary',
      sourceNumber: null,
    };
  }

  // Everything else is prose. A single short line in title case is a heading for what follows.
  const heading = lines.length === 1 && HEADING.test(first) && first.length <= 80;
  const format: BlockFormat = heading
    ? 'heading'
    : FORMULA_HINT.test(text)
      ? 'formula'
      : lines.filter((l) => LIST_LINE.test(l)).length >= 2
        ? 'list'
        : 'paragraph';

  return {
    kind: 'theory',
    format,
    title: heading ? first : null,
    text,
    // Prose is the residual category, so it earns less confidence than a marker-led match, and a
    // very short run of text earns less still.
    confidence: scale(heading ? 0.7 : text.length < 80 ? 0.5 : 0.85, page),
    reason: heading ? 'a single heading line' : 'prose with no question or solution markers',
    sourceNumber: null,
  };
}

/**
 * OCR'd pages are less trustworthy than a text layer, so every confidence on such a page is
 * scaled by the page's own OCR confidence. This is what makes "OCR content requires human
 * approval" fall out of the numbers rather than needing a special case.
 */
function scale(confidence: number, page: PageText): number {
  if (!page.fromOcr) return round3(confidence);
  const pageConfidence = page.ocrConfidence ?? 0.5;
  return round3(confidence * pageConfidence);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** `content_blocks.content_hash`: sha256 of the normalised text, which is what the column stores. */
export function hashText(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

/** The option lines of a block, for question extraction. */
export function optionLines(text: string): string[] {
  return text.split('\n').filter((line) => OPTION_LINE.test(line.trim()));
}

export const MARKERS = { QUESTION_NUMBER, OPTION_LINE, SOLUTION_MARKER, ANSWER_INLINE, FORMULA_HINT };
