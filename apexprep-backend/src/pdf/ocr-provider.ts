/**
 * The OCR boundary.
 *
 * OCR is the *fallback*, not the default: a page is sent here only when its text layer is too
 * thin to use, because OCR costs money and per-page latency and is less accurate than a text
 * layer that already exists.
 *
 * Two things this interface insists on, both from the requirements:
 *
 *   * **Formulas survive.** A provider that can read mathematics returns it in `formulas` with a
 *     LaTeX normalisation where it can manage one, and the `text` keeps whatever the provider
 *     actually read. Nothing downstream is allowed to drop a formula it did not understand — a
 *     mangled equation silently published as prose is worse than a page held for review.
 *   * **The original is kept.** `rawText` is the provider's own output before any normalisation,
 *     stored so a reviewer can see what the machine saw rather than only what the pipeline made
 *     of it.
 */

export interface OcrFormula {
  /** The expression as the provider read it. */
  source: string;
  /** LaTeX, when the provider produced or could be normalised to it. */
  latex: string | null;
  /** 0-1, per formula: a formula read badly should not be trusted because the page scored well. */
  confidence: number | null;
}

export interface OcrPageResult {
  /** The page text after the provider's own layout reconstruction. */
  text: string;
  /** What the provider returned before any normalisation here. Never overwritten. */
  rawText: string;
  /** 0-1 for the page. Low confidence forces human review (quality gates). */
  confidence: number;
  formulas: OcrFormula[];
  /** The provider and model, for provenance on `extracted_pages`. */
  provider: string;
  model: string | null;
}

export interface OcrPageInput {
  /** The rendered page image, or the source PDF bytes when the provider takes PDFs directly. */
  body: Buffer;
  contentType: string;
  pageNumber: number;
  /** A hint: whether the page looked mathematical, so a formula-capable model can be chosen. */
  mathHint?: boolean;
}

export interface OcrProvider {
  readonly name: string;
  /** False when OCR cannot run at all; callers then record the page as needing review. */
  readonly available: boolean;
  /** Whether this provider preserves mathematics rather than flattening it into prose. */
  readonly supportsFormulas: boolean;
  recognise(input: OcrPageInput): Promise<OcrPageResult>;
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

export class OcrUnavailableError extends Error {
  constructor(readonly provider: string, message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

/**
 * The default: no OCR configured.
 *
 * It refuses rather than returning empty text, because empty text is indistinguishable from a
 * genuinely blank page. The pipeline catches the refusal, records the page as unreadable and
 * opens a review task, so a scanned document produces a queue of pages a human can deal with
 * instead of a silently empty set of blocks.
 */
export class UnavailableOcrProvider implements OcrProvider {
  readonly name = 'none';
  readonly available = false;
  readonly supportsFormulas = false;

  recognise(input: OcrPageInput): Promise<OcrPageResult> {
    return Promise.reject(
      new OcrUnavailableError('none', `no OCR provider is configured (OCR_PROVIDER=none), so page ${input.pageNumber} cannot be read`),
    );
  }
}

/**
 * Turns a provider's formulas into the placeholders the block text carries.
 *
 * The text keeps a marker where each formula sits rather than the formula's characters, so a
 * later classifier or a `tsvector` never sees half-parsed mathematics as prose, and the formulas
 * travel beside the text in `content_blocks.content_json`. Both halves are preserved; neither
 * is the only copy.
 */
export function withFormulaPlaceholders(text: string, formulas: readonly OcrFormula[]): string {
  let out = text;
  for (const [index, formula] of formulas.entries()) {
    if (formula.source.length === 0) continue;
    out = out.split(formula.source).join(`[formula:${index + 1}]`);
  }
  return out;
}
