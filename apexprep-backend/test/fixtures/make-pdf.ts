import { deflateSync } from 'node:zlib';

/**
 * Builds real PDF files for the ingestion tests.
 *
 * Not a mock: these are byte streams that a PDF reader would open, so `PdfDocument` parses them the
 * way it parses an uploaded textbook — header, cross-reference table, page tree, content streams
 * and `Tj` operators included. A fixture that faked the parse would prove nothing about extraction,
 * which is the one part of this pipeline with no library behind it.
 *
 * Deliberately small: one font, one page size, `WinAnsiEncoding`, and text placed line by line with
 * `Td`. That is the common shape of a digitally produced document, which is what the extractor
 * targets.
 */

export interface PdfOptions {
  /** One entry per page; each string is split on newlines into text lines. */
  pages: string[];
  /** Adds an `/Encrypt` dictionary, so the document reads as password-protected. */
  encrypted?: boolean;
  /** Compresses the page content streams with FlateDecode, as most real PDFs do. */
  compress?: boolean;
  /** The version in the `%PDF-` header. */
  version?: string;
  /**
   * Replaces each page's content stream with these exact bytes, marked `/FlateDecode`.
   * For fixtures that need a stream the text builder would never produce — see `makeBombPdf`.
   */
  rawContentStreams?: Buffer[];
}

/** A PDF whose pages carry the given text in their text layer. */
export function makePdf(options: PdfOptions): Buffer {
  const version = options.version ?? '1.7';
  const pageCount = options.pages.length;

  // Object numbering: 1 catalog, 2 pages, 3 font, then two objects per page (page, content).
  const firstPageObject = 4;
  const pageIds = options.pages.map((_, i) => firstPageObject + i * 2);
  const contentIds = pageIds.map((id) => id + 1);

  const objects: { number: number; body: string | Buffer }[] = [
    { number: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` },
    { number: 2, body: `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>` },
    { number: 3, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` },
  ];

  options.pages.forEach((text, index) => {
    const raw = options.rawContentStreams?.[index];
    const content = contentStream(text);
    const stream = raw ?? (options.compress ? deflateSync(content) : Buffer.from(content, 'latin1'));
    const compressed = raw !== undefined || Boolean(options.compress);
    objects.push({
      number: pageIds[index]!,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[index]!} 0 R >>`,
    });
    objects.push({
      number: contentIds[index]!,
      body: Buffer.concat([
        Buffer.from(`<< /Length ${stream.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'),
        stream,
        Buffer.from(`\nendstream`, 'latin1'),
      ]),
    });
  });

  return assemble(version, objects, options.encrypted ?? false);
}

/**
 * A file that announces itself as a PDF and then is not one: the header is intact, the body is
 * truncated before any page object. This is the "damaged upload" case — a transfer that stopped
 * part way, which is common enough to be worth refusing clearly.
 */
export function makeDamagedPdf(): Buffer {
  const whole = makePdf({ pages: ['Some text that will be cut off before the page tree.'] });
  return whole.subarray(0, 20);
}

/** Bytes that are not a PDF at all, whatever the client claims the content type is. */
export function makeNotAPdf(): Buffer {
  return Buffer.from('PK\u0003\u0004 this is a zip file wearing a pdf content type', 'latin1');
}

/**
 * A real decompression bomb: a small, valid PDF whose single content stream inflates to
 * `inflatedBytes`.
 *
 * Not a synthetic edge case. A page's content stream is FlateDecode-compressed, and zlib will
 * happily inflate a few hundred kilobytes into hundreds of megabytes, so an upload that passes every
 * size and page-count check can still exhaust the process's memory during extraction. The default
 * 200 MB at roughly 1000:1 is a ~200 KB file — well under any upload limit a person would set.
 */
export function makeBombPdf(inflatedBytes = 200 * 1024 * 1024): Buffer {
  // Spaces compress spectacularly and are valid inside a content stream.
  const inflated = Buffer.alloc(inflatedBytes, 0x20);
  return makePdf({ pages: [''], rawContentStreams: [deflateSync(inflated)] });
}

/**
 * A PDF with many pages and almost no text on each: cheap to build, and the way to exercise the
 * page-count limit without a large file.
 */
export function makeManyPagePdf(pageCount: number): Buffer {
  return makePdf({ pages: Array.from({ length: pageCount }, (_, i) => `Page ${i + 1}`) });
}

/**
 * One `Tm` per line, as many PDF producers emit.
 *
 * A blank source line consumes its vertical step but shows no text, which is what a real producer
 * does for a paragraph break: the break exists in the file as a larger gap between two baselines,
 * not as an empty string operator.
 */
function contentStream(text: string): string {
  const body = text
    .split('\n')
    .map((line, index) => (line.length === 0 ? null : `1 0 0 1 56 ${800 - index * 16} Tm\n(${escapeText(line)}) Tj`))
    .filter((chunk): chunk is string => chunk !== null)
    .join('\n');
  return `BT\n/F1 12 Tf\n14 TL\n${body}\nET\n`;
}

/** PDF string escaping: backslash, parentheses, and anything outside printable Latin-1. */
function escapeText(line: string): string {
  let out = '';
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    // Anything above Latin-1 has no WinAnsi code point; the fixtures stay inside it.
  }
  return out;
}

/** Lays the objects out with a real cross-reference table and trailer. */
function assemble(version: string, objects: { number: number; body: string | Buffer }[], encrypted: boolean): Buffer {
  const parts: Buffer[] = [Buffer.from(`%PDF-${version}\n%âãÏÓ\n`, 'latin1')];
  let offset = parts[0]!.length;
  const offsets = new Map<number, number>();

  for (const object of objects) {
    offsets.set(object.number, offset);
    const body = typeof object.body === 'string' ? Buffer.from(object.body, 'latin1') : object.body;
    const chunk = Buffer.concat([Buffer.from(`${object.number} 0 obj\n`, 'latin1'), body, Buffer.from(`\nendobj\n`, 'latin1')]);
    parts.push(chunk);
    offset += chunk.length;
  }

  const maxNumber = Math.max(...objects.map((o) => o.number));
  const xrefStart = offset;
  let xref = `xref\n0 ${maxNumber + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNumber; n += 1) {
    const at = offsets.get(n);
    xref += at === undefined ? `0000000000 65535 f \n` : `${String(at).padStart(10, '0')} 00000 n \n`;
  }
  // /Encrypt is what marks a document password-protected; the fixture needs no real cipher, because
  // the upload path refuses an encrypted document before it ever tries to read one.
  const encrypt = encrypted ? ` /Encrypt << /Filter /Standard /V 2 /R 3 /Length 128 /P -1 >>` : '';
  xref += `trailer\n<< /Size ${maxNumber + 1} /Root 1 0 R${encrypt} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}
