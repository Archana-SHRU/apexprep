import { PdfDocument, normaliseWhitespace, textFromContent } from '../../src/pdf/pdf-document';
import { OcrUnavailableError, UnavailableOcrProvider, withFormulaPlaceholders } from '../../src/pdf/ocr-provider';
import { makeBombPdf, makeDamagedPdf, makeManyPagePdf, makeNotAPdf, makePdf } from '../fixtures/make-pdf';

/**
 * Scenarios B, D, E, I and J (section 20), plus the math-content rules of section 5: what the PDF
 * layer accepts, what it refuses, and what it reads.
 *
 * The fixtures are real PDF byte streams (`test/fixtures/make-pdf.ts`), not stubs of the parser's
 * output — extraction is the one part of the pipeline with no library behind it, so a test that
 * mocked the parse would prove nothing.
 */

const PAGE = [
  "Newton's Second Law",
  '',
  'The acceleration of a body is proportional to the net force on it, so F = ma in any inertial frame.',
  '',
  '1. A 2 kg block is pushed with a net force of 10 N. Find its acceleration.',
  '(A) 2 m/s^2',
  '(B) 5 m/s^2',
  '(C) 10 m/s^2',
  '(D) 20 m/s^2',
  'Answer: B',
].join('\n');

describe('B. a file that is not a usable PDF is refused, with a stable code', () => {
  it('refuses bytes with no %PDF- header, whatever the client declared', () => {
    const validation = PdfDocument.parse(makeNotAPdf()).validate(1000);
    expect(validation.ok).toBe(false);
    expect(validation.code).toBe('not_a_pdf');
  });

  it('refuses a truncated file rather than reading half a document', () => {
    const validation = PdfDocument.parse(makeDamagedPdf()).validate(1000);
    expect(validation.ok).toBe(false);
    expect(validation.code).toBe('damaged');
    expect(validation.pageCount).toBe(0);
  });
});

describe('D. a password-protected PDF is refused', () => {
  it('detects /Encrypt and says what to do about it', () => {
    const validation = PdfDocument.parse(makePdf({ pages: ['secret'], encrypted: true })).validate(1000);
    expect(validation.encrypted).toBe(true);
    expect(validation.code).toBe('encrypted');
    expect(validation.message).toMatch(/password/i);
  });
});

describe('E. the page limit is enforced from the document itself', () => {
  it('counts pages and refuses a document over the limit', () => {
    const doc = PdfDocument.parse(makeManyPagePdf(12));
    expect(doc.pageCount()).toBe(12);
    expect(doc.validate(12).ok).toBe(true);
    const over = doc.validate(10);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('too_many_pages');
    expect(over.message).toContain('12');
  });
});

describe('I. native text extraction is the primary path', () => {
  it.each([false, true])('reads the text layer of a page (compressed: %s)', (compress) => {
    const pages = PdfDocument.parse(makePdf({ pages: [PAGE], compress })).extractText();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.method).toBe('text_layer');
    expect(pages[0]!.thin).toBe(false);
    expect(pages[0]!.text).toContain('F = ma');
    expect(pages[0]!.text).toContain('Answer: B');
  });

  it('keeps the document on separate lines, which is what segmentation needs', () => {
    const [page] = PdfDocument.parse(makePdf({ pages: [PAGE] })).extractText();
    const lines = page!.text.split('\n');
    expect(lines[0]).toBe("Newton's Second Law");
    expect(lines).toContain('(A) 2 m/s^2');
    expect(lines).toContain('Answer: B');
  });

  it('keeps the blank line between paragraphs, which is the chunk boundary', () => {
    const [page] = PdfDocument.parse(makePdf({ pages: [PAGE] })).extractText();
    expect(page!.text).toMatch(/Second Law\n\nThe acceleration/);
  });

  it('reads every page of a multi-page document, in order', () => {
    const pages = PdfDocument.parse(makePdf({ pages: ['Page one text here.', 'Page two text here.'] })).extractText();
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(pages[1]!.text).toContain('two');
  });
});

describe('J. a page with no usable text layer is marked thin, not silently empty', () => {
  it('flags a nearly empty page so the caller can decide about OCR', () => {
    const pages = PdfDocument.parse(makePdf({ pages: ['x'] })).extractText();
    expect(pages[0]!.thin).toBe(true);
    expect(pages[0]!.text).toBe('x');
  });
});

describe('text operators', () => {
  const noFonts = new Map<string, Map<number, string>>();

  it('treats a text matrix that moves down the page as a new line', () => {
    const content = 'BT /F1 12 Tf 1 0 0 1 56 800 Tm (first) Tj 1 0 0 1 56 784 Tm (second) Tj ET';
    expect(textFromContent(content, noFonts)).toBe('first\nsecond');
  });

  it('treats a text matrix at the same height as the same line', () => {
    const content = 'BT /F1 12 Tf 1 0 0 1 56 800 Tm (first) Tj 1 0 0 1 120 800 Tm (part) Tj ET';
    expect(textFromContent(content, noFonts)).toBe('first part');
  });

  it('reads a TJ array as one run of text, ignoring its kerning numbers', () => {
    const content = 'BT /F1 12 Tf [(Hel) -20 (lo) -15 ( world)] TJ ET';
    expect(textFromContent(content, noFonts)).toBe('Hello world');
  });

  it('collapses runs of blank lines but keeps a single one', () => {
    expect(normaliseWhitespace('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normaliseWhitespace('a\n\nb')).toBe('a\n\nb');
    expect(normaliseWhitespace('  a  b  \n  c ')).toBe('a b\nc');
  });
});

describe('a compressed content stream cannot exhaust memory', () => {
  /**
   * A 200 KB PDF whose content stream inflates to 200 MB. Every upload check passes it — it is
   * well inside any byte limit and has a single page — so the only place to stop it is at the
   * inflate itself, which is bounded by `maxOutputLength`.
   *
   * Regression test for a real availability defect: before the bound, this one small file grew the
   * heap by the full inflated size, and a handful of them concurrently would take the process down.
   */
  it('refuses to inflate a bomb, and reports the page as thin rather than crashing', () => {
    const bomb = makeBombPdf();
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024); // a small file by any upload limit

    const before = process.memoryUsage().heapUsed;
    const doc = PdfDocument.parse(bomb);
    expect(doc.validate(1000)).toMatchObject({ ok: true });
    const pages = doc.extractText();
    const grewMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

    // The bomb inflates to 200 MB; the cap is 32 MB. Well under either number proves it was
    // refused rather than merely truncated late.
    expect(grewMb).toBeLessThan(64);
    // The page yields no usable text, which is the honest outcome: the caller sees a thin page and
    // can send it to OCR or ask a person, exactly as for a scanned page.
    expect(pages[0]?.thin).toBe(true);
  });

  it('still reads a normally compressed document, so the bound is not a ban on compression', () => {
    const doc = PdfDocument.parse(makePdf({ pages: ['Ordinary compressed text.'], compress: true }));
    expect(doc.extractText()[0]?.text).toContain('Ordinary compressed text.');
  });
});

describe('J. the OCR boundary', () => {
  it('refuses rather than returning empty text when no provider is configured', async () => {
    const provider = new UnavailableOcrProvider();
    expect(provider.available).toBe(false);
    await expect(provider.recognise({ body: Buffer.alloc(1), contentType: 'application/pdf', pageNumber: 1 })).rejects.toBeInstanceOf(
      OcrUnavailableError,
    );
  });

  it('names itself, so a job can record which provider could not run', () => {
    expect(new UnavailableOcrProvider().name).toMatch(/\S/);
  });
});

describe('math content (section 5): formulas are preserved, never silently discarded', () => {
  it('leaves a placeholder where a formula was, so the text is not read as prose', () => {
    const text = withFormulaPlaceholders('The energy is E = mc^2 exactly.', [
      { source: 'E = mc^2', latex: 'E = mc^{2}', confidence: 0.9 },
    ]);
    expect(text).not.toContain('E = mc^2 exactly');
    expect(text).toMatch(/\[formula:\d+\]/);
    expect(text).toContain('The energy is');
  });

  it('leaves text untouched when there are no formulas', () => {
    expect(withFormulaPlaceholders('Plain prose.', [])).toBe('Plain prose.');
  });
});
