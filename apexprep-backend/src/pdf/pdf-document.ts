import { inflateSync } from 'node:zlib';

/**
 * Enough of the PDF format to validate an upload and read its text layer.
 *
 * Written against the file format rather than a library because no PDF package is installable in
 * this workspace (DECISIONS.md §D). That is a real constraint with a real consequence, stated
 * here rather than buried: this reads the **common case** — a digitally produced PDF whose pages
 * carry an uncompressed or Flate-compressed content stream — and it is deliberately
 * conservative everywhere else. Whatever it cannot read, it reports as thin or missing text so
 * the page goes to OCR or to a human; it never guesses at bytes it did not understand.
 *
 * What it does handle: the `%PDF-` header, encryption detection, page counting from the page
 * tree (and by object scan when the tree is unreadable), object streams, `FlateDecode` including
 * the `/Columns` predictor used by cross-reference streams, `Tj`/`TJ`/`'`/`"` text operators,
 * and `/ToUnicode` CMaps for fonts whose glyph codes are not ASCII.
 *
 * What it does not: encrypted documents (refused by policy anyway), `LZWDecode`, CCITT and JBIG2
 * images, Type 3 fonts, and text positioned by transformation matrices alone. Pure: no I/O, no
 * configuration, no clock.
 */

export interface PdfValidation {
  ok: boolean;
  /** A stable code, so the API's error body does not depend on a message string. */
  code?: 'not_a_pdf' | 'encrypted' | 'damaged' | 'no_pages' | 'too_many_pages';
  message?: string;
  pageCount: number;
  encrypted: boolean;
  /** The version from the header, e.g. "1.7". */
  version: string | null;
}

export interface PdfPageText {
  pageNumber: number;
  text: string;
  /** How the text was obtained, matching `extracted_pages.method`. */
  method: 'text_layer';
  /** True when the page yielded so little text that the caller should consider OCR. */
  thin: boolean;
}

const MIN_PAGE_CHARS = 40;

/**
 * The most any single compressed stream may decompress to (32 MiB).
 *
 * A page of text is a few kilobytes; a page of embedded font and image data is rarely more than a
 * few hundred. 32 MiB is far above anything legitimate and far below what it takes to hurt the
 * process, which is exactly where a bound belongs. It is a safety ceiling, not a tunable: a
 * document that trips it is malformed or hostile, and neither is a case for configuration.
 */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

/** A parsed indirect object: its number and the raw bytes between `obj` and `endobj`. */
interface RawObject {
  number: number;
  body: Buffer;
}

export class PdfDocument {
  private readonly objects = new Map<number, Buffer>();

  private constructor(
    private readonly bytes: Buffer,
    readonly version: string | null,
  ) {
    for (const object of scanObjects(bytes)) this.objects.set(object.number, object.body);
    // Objects inside object streams (PDF 1.5+) are only visible after inflating them.
    for (const body of [...this.objects.values()]) {
      if (!/\/Type\s*\/ObjStm/.test(head(body))) continue;
      for (const object of objectsInStream(body)) {
        if (!this.objects.has(object.number)) this.objects.set(object.number, object.body);
      }
    }
  }

  static parse(bytes: Buffer): PdfDocument {
    return new PdfDocument(bytes, headerVersion(bytes));
  }

  /**
   * Whether this file may be ingested at all. Order matters: a file that is not a PDF is not
   * examined further, and an encrypted one is refused before any attempt to read its contents.
   */
  validate(maxPages: number): PdfValidation {
    const base = { pageCount: 0, encrypted: false, version: this.version };
    if (headerVersion(this.bytes) === null) {
      return { ...base, ok: false, code: 'not_a_pdf', message: 'the file does not start with a %PDF- header' };
    }
    if (this.isEncrypted()) {
      return {
        ...base,
        ok: false,
        encrypted: true,
        code: 'encrypted',
        message: 'the PDF is encrypted or password-protected; remove the protection and upload it again',
      };
    }
    const pageCount = this.pageCount();
    if (pageCount === 0) {
      return { ...base, ok: false, code: this.objects.size === 0 ? 'damaged' : 'no_pages', message: 'no readable pages were found in the PDF' };
    }
    if (pageCount > maxPages) {
      return { ...base, pageCount, ok: false, code: 'too_many_pages', message: `the PDF has ${pageCount} pages; the limit is ${maxPages}` };
    }
    return { ...base, pageCount, ok: true };
  }

  /**
   * True when the document declares encryption.
   *
   * `/Encrypt` in a trailer is the definitive marker, and it is what every producer writes for a
   * password-protected file — including one with an empty owner password, which opens without a
   * prompt but is still encrypted. The `/Encrypt` **dictionary** is matched as a trailer key, not
   * as a substring anywhere in the file, so an unrelated object containing that word is not
   * mistaken for encryption.
   */
  isEncrypted(): boolean {
    for (const trailer of trailerDictionaries(this.bytes)) {
      if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(trailer)) return true;
    }
    return false;
  }

  /** Pages from `/Type /Pages /Count`, falling back to counting `/Type /Page` objects. */
  pageCount(): number {
    let best = 0;
    for (const body of this.objects.values()) {
      const text = head(body);
      if (!/\/Type\s*\/Pages\b/.test(text)) continue;
      const count = /\/Count\s+(\d+)/.exec(text);
      // The root of the page tree carries the total, so the largest /Count is it.
      if (count) best = Math.max(best, Number(count[1]));
    }
    if (best > 0) return best;
    return this.pageObjects().length;
  }

  /** The page objects in document order, as far as the page tree can be followed. */
  private pageObjects(): { number: number; body: Buffer }[] {
    const pages: { number: number; body: Buffer }[] = [];
    for (const [number, body] of this.objects) {
      const text = head(body);
      if (/\/Type\s*\/Page\b/.test(text) && !/\/Type\s*\/Pages\b/.test(text)) pages.push({ number, body });
    }
    // Object order approximates document order well enough for extraction, and the page number
    // recorded on a block is only ever provenance a reviewer reads — never an index into logic.
    return pages.sort((a, b) => a.number - b.number);
  }

  /**
   * The text layer, page by page. A page whose content stream cannot be read comes back with
   * empty text and `thin: true`, which is exactly what routes it to OCR.
   */
  extractText(): PdfPageText[] {
    const fonts = this.toUnicodeMaps();
    return this.pageObjects().map((page, index) => {
      let text = '';
      try {
        text = normaliseWhitespace(this.pageContent(page.body).map((stream) => textFromContent(stream, fonts)).join('\n'));
      } catch {
        text = '';
      }
      return { pageNumber: index + 1, text, method: 'text_layer' as const, thin: text.length < MIN_PAGE_CHARS };
    });
  }

  /** Every content stream of a page, decoded. `/Contents` may be one stream or an array. */
  private pageContent(pageBody: Buffer): string[] {
    const text = head(pageBody);
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(text);
    if (!contents) return [];
    const refs = [...contents[1]!.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    return refs.flatMap((ref) => {
      const body = this.objects.get(ref);
      const decoded = body ? decodeStream(body) : null;
      return decoded ? [decoded.toString('latin1')] : [];
    });
  }

  /**
   * `/ToUnicode` CMaps, keyed by the font resource they belong to.
   *
   * A subset font often maps glyph code 1 to "A", so reading its bytes as ASCII yields control
   * characters. Where the producer supplied a CMap the codes are translated; where it did not,
   * the bytes are taken as Latin-1, which is right for the majority of simple fonts.
   */
  private toUnicodeMaps(): Map<string, Map<number, string>> {
    const maps = new Map<string, Map<number, string>>();
    for (const [number, body] of this.objects) {
      const text = head(body);
      if (!/\/Type\s*\/Font\b/.test(text)) continue;
      const toUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(text);
      if (!toUnicode) continue;
      const cmapBody = this.objects.get(Number(toUnicode[1]));
      const decoded = cmapBody ? decodeStream(cmapBody) : null;
      if (decoded) maps.set(String(number), parseCMap(decoded.toString('latin1')));
    }
    return maps;
  }
}

// ---------------------------------------------------------------------------- format helpers

function headerVersion(bytes: Buffer): string | null {
  // The header is allowed a little junk before it, so look in the first bytes rather than at 0.
  const start = bytes.subarray(0, 1024).toString('latin1');
  const match = /%PDF-(\d\.\d)/.exec(start);
  return match ? match[1]! : null;
}

/** The first 4 KiB of an object as text: enough for its dictionary, cheap for a large stream. */
function head(body: Buffer): string {
  return body.subarray(0, 4096).toString('latin1');
}

/** Every `N G obj … endobj` in the file. */
function scanObjects(bytes: Buffer): RawObject[] {
  const text = bytes.toString('latin1');
  const objects: RawObject[] = [];
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end === -1) continue;
    objects.push({ number: Number(match[1]), body: bytes.subarray(start, end) });
    pattern.lastIndex = end;
  }
  return objects;
}

/** Trailer dictionaries: the classic `trailer <<…>>` and the dictionary of any XRef stream. */
function trailerDictionaries(bytes: Buffer): string[] {
  const text = bytes.toString('latin1');
  const out: string[] = [];
  for (const match of text.matchAll(/trailer\s*<<([\s\S]{0,4096}?)>>/g)) out.push(match[1]!);
  for (const match of text.matchAll(/\/Type\s*\/XRef\b([\s\S]{0,4096}?)stream/g)) out.push(match[1]!);
  return out;
}

/**
 * Decodes an ASCII85 stream (ISO 32000-1 §7.4.3).
 */
function decodeAscii85(input: Buffer): Buffer {
  const text = input.toString('latin1').replace(/<~|~>|\s/g, '');
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === 'z' && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = text.charCodeAt(i);
    if (c < 33 || c > 117) continue;
    tuple = tuple * 85 + (c - 33);
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let j = count; j < 5; j += 1) tuple = tuple * 85 + 84;
    for (let k = 0; k < count - 1; k += 1) {
      out.push((tuple >>> (24 - k * 8)) & 255);
    }
  }
  return Buffer.from(out);
}

/**
 * Decodes an ASCIIHex stream (ISO 32000-1 §7.4.2).
 */
function decodeAsciiHex(input: Buffer): Buffer {
  const text = input.toString('latin1').replace(/>[\s\S]*$/, '').replace(/\s/g, '');
  const hex = text.length % 2 === 1 ? `${text}0` : text;
  return Buffer.from(hex, 'hex');
}

/**
 * The bytes between `stream` and `endstream`, with filters (`FlateDecode`, `ASCII85Decode`, `ASCIIHexDecode`) applied.
 *
 * Returns null rather than throwing for anything it cannot decode — an unsupported filter, a corrupt
 * stream — because an unreadable stream is a page that needs OCR, not a failed upload.
 */
export function decodeStream(body: Buffer): Buffer | null {
  const text = body.toString('latin1');
  const start = /stream\r\n|stream\n|stream\r/.exec(text);
  if (!start) return null;
  const from = start.index + start[0].length;
  const end = text.lastIndexOf('endstream');
  if (end <= from) return null;

  let current = body.subarray(from, end);
  const dict = text.slice(0, start.index);
  const filters = [...dict.matchAll(/\/Filter\s*(?:\[([^\]]*)\]|\/(\w+))/g)].flatMap((m) =>
    m[1] ? [...m[1].matchAll(/\/(\w+)/g)].map((f) => f[1]!) : [m[2]!],
  );

  if (filters.length === 0) return current;

  // In PDF (ISO 32000-1 §7.4), filters in an array are applied in the order they appear for decoding.
  for (const filter of filters) {
    if (filter === 'FlateDecode' || filter === 'Fl') {
      try {
        current = inflateSync(current, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        return null;
      }
      const columns = /\/Columns\s+(\d+)/.exec(dict);
      const predictor = /\/Predictor\s+(\d+)/.exec(dict);
      if (predictor && Number(predictor[1]) >= 10) {
        current = undoPngPredictor(current, columns ? Number(columns[1]) : 1);
      }
    } else if (filter === 'ASCII85Decode' || filter === 'A85') {
      try {
        current = decodeAscii85(current);
      } catch {
        return null;
      }
    } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
      try {
        current = decodeAsciiHex(current);
      } catch {
        return null;
      }
    } else {
      // Unsupported filter (e.g. LZWDecode, JBIG2)
      return null;
    }
  }

  return current;
}

/**
 * Reverses the PNG row predictor that cross-reference and object streams are usually written
 * with. Without it those streams inflate to bytes that look like noise.
 */
function undoPngPredictor(data: Buffer, columns: number): Buffer {
  const rowLength = columns + 1;
  if (columns < 1 || data.length < rowLength) return data;
  const rows = Math.floor(data.length / rowLength);
  const out = Buffer.alloc(rows * columns);
  let previous = Buffer.alloc(columns);
  for (let r = 0; r < rows; r += 1) {
    const type = data[r * rowLength]!;
    const row = Buffer.from(data.subarray(r * rowLength + 1, r * rowLength + 1 + columns));
    for (let i = 0; i < columns; i += 1) {
      const left = i === 0 ? 0 : row[i - 1]!;
      const up = previous[i]!;
      if (type === 1) row[i] = (row[i]! + left) & 0xff;
      else if (type === 2) row[i] = (row[i]! + up) & 0xff;
      else if (type === 3) row[i] = (row[i]! + ((left + up) >> 1)) & 0xff;
      else if (type === 4) row[i] = (row[i]! + paeth(left, up, i === 0 ? 0 : previous[i - 1]!)) & 0xff;
    }
    row.copy(out, r * columns);
    previous = row;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Objects packed inside an `/ObjStm`: a header of `number offset` pairs, then the bodies. */
function objectsInStream(body: Buffer): RawObject[] {
  const decoded = decodeStream(body);
  if (!decoded) return [];
  const text = head(body);
  const n = /\/N\s+(\d+)/.exec(text);
  const first = /\/First\s+(\d+)/.exec(text);
  if (!n || !first) return [];

  const content = decoded.toString('latin1');
  const pairs = content.slice(0, Number(first[1])).trim().split(/\s+/).map(Number);
  const out: RawObject[] = [];
  for (let i = 0; i < Number(n[1]); i += 1) {
    const number = pairs[i * 2];
    const offset = pairs[i * 2 + 1];
    if (number === undefined || offset === undefined || !Number.isFinite(number)) continue;
    const start = Number(first[1]) + offset;
    const nextOffset = pairs[i * 2 + 3];
    const end = nextOffset === undefined ? decoded.length : Number(first[1]) + nextOffset;
    out.push({ number, body: decoded.subarray(start, Math.min(end, decoded.length)) });
  }
  return out;
}

// ---------------------------------------------------------------------------- text operators

/**
 * Pulls the strings out of a content stream.
 *
 * Only the text-showing operators are interpreted — `Tj`, `TJ`, `'` and `"` — plus `Tf` to know
 * which font's CMap applies and `Td`/`TD`/`T*`/`ET` to know where a line ends. Positioning is
 * deliberately ignored beyond that: guessing column order from transformation matrices is how
 * naive extractors produce interleaved nonsense out of a two-column page, and a reviewer reading
 * scrambled text is worse served than one reading a page marked for review.
 */
export function textFromContent(content: string, fonts: Map<string, Map<number, string>>): string {
  /** Each finished line with the baseline it sat on, so paragraph breaks can be recovered after. */
  const lines: { text: string; y: number | null }[] = [];
  let current = '';
  let currentY: number | null = null;
  let cmap: Map<number, string> | undefined;
  /** The y the text cursor was last placed at, so a move that changes it is a new line. */
  let lastY: number | null = null;
  /** Operands seen since the last operator. PDF is postfix, so they arrive before it. */
  const operands: number[] = [];

  const pattern =
    /\/(\w+)\s+[-\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]*)>|\[((?:[^\\\][]|\\.)*)\]\s*TJ|(-?\d*\.\d+|-?\d+)|(T\*|Tm|Td|TD|ET|BT|Tj|'|")/g;
  let match: RegExpExecArray | null;
  const pending: string[] = [];

  const flushLine = () => {
    const line = current.trim();
    if (line.length > 0) lines.push({ text: line, y: currentY });
    current = '';
    currentY = lastY;
  };

  /**
   * Where a positioning operator put the cursor. The same y as before means the producer is still
   * on one line and only advanced horizontally — a space, not a break. A different y is a new line.
   *
   * This is what makes a document laid out with `Tm` per line come out as lines. Plenty of PDF
   * producers position every line with its own text matrix rather than `Td`, and reading those as
   * one unbroken run would destroy the structure everything downstream depends on: a question would
   * arrive glued to the paragraph above it and to its own options.
   */
  const moveTo = (y: number | null) => {
    if (y !== null && lastY !== null && Math.abs(y - lastY) < 0.01) {
      if (current.length > 0 && !current.endsWith(' ')) current += ' ';
      return;
    }
    lastY = y;
    flushLine();
  };

  while ((match = pattern.exec(content)) !== null) {
    const [token, fontName, hex, array, number, operator] = match;

    if (fontName !== undefined) {
      cmap = fonts.get(fontName) ?? [...fonts.values()][0];
      continue;
    }
    if (array !== undefined) {
      // A TJ array alternates strings and kerning numbers; the numbers are spacing, not text.
      for (const piece of array.matchAll(/\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]*)>/g)) {
        current += piece[1] === undefined ? decodeLiteral(piece[0]) : decodeHex(piece[1], cmap);
      }
      operands.length = 0;
      continue;
    }
    if (token.startsWith('(')) {
      pending.push(decodeLiteral(token));
      continue;
    }
    if (hex !== undefined) {
      pending.push(decodeHex(hex, cmap));
      continue;
    }
    if (number !== undefined) {
      operands.push(Number(number));
      continue;
    }
    if (operator === 'Tj' || operator === "'" || operator === '"') {
      // `'` and `"` move to the next line before showing their text.
      if (operator !== 'Tj') flushLine();
      if (currentY === null) currentY = lastY;
      current += pending.pop() ?? '';
      pending.length = 0;
      operands.length = 0;
      continue;
    }
    if (operator === 'Tm') {
      // `a b c d e f Tm` — `f` is the y translation.
      moveTo(operands.length >= 6 ? operands[operands.length - 1]! : null);
      operands.length = 0;
      continue;
    }
    if (operator === 'Td' || operator === 'TD') {
      // `tx ty Td` is relative, so a zero ty is still the same line.
      const dy = operands.length >= 2 ? operands[operands.length - 1]! : null;
      const from: number | null = lastY;
      if (dy === null || Math.abs(dy) >= 0.01) {
        if (from !== null && dy !== null) lastY = from + dy;
        flushLine();
      } else if (current.length > 0 && !current.endsWith(' ')) {
        current += ' ';
      }
      operands.length = 0;
      continue;
    }
    if (operator === 'T*' || operator === 'ET' || operator === 'BT') {
      flushLine();
      if (operator !== 'T*') lastY = null;
      operands.length = 0;
      continue;
    }
  }
  flushLine();
  return joinWithParagraphBreaks(lines);
}

/**
 * Joins the lines, putting a blank line where the author left vertical white space.
 *
 * The blank line matters because it is segmentation's primary block boundary: without it a heading
 * arrives glued to the paragraph under it and a question to the paragraph above it. It cannot be
 * decided while reading, because the first gaps in a page are as likely to be paragraph breaks as
 * line breaks — the line height is only knowable once the whole page has been seen. So the gaps are
 * collected first and the typical one (the median) is taken as the line height; a gap half again
 * larger than that is white space the author put there.
 */
function joinWithParagraphBreaks(lines: readonly { text: string; y: number | null }[]): string {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1]!.y;
    const b = lines[i]!.y;
    if (a !== null && b !== null && a > b) gaps.push(a - b);
  }
  if (gaps.length === 0) return lines.map((l) => l.text).join('\n');

  const sorted = [...gaps].sort((x, y) => x - y);
  const lineHeight = sorted[Math.floor(sorted.length / 2)]!;

  let out = lines[0]?.text ?? '';
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1]!.y;
    const b = lines[i]!.y;
    const paragraph = a !== null && b !== null && a - b > lineHeight * 1.5;
    out += paragraph ? `\n\n${lines[i]!.text}` : `\n${lines[i]!.text}`;
  }
  return out;
}

/** A `(…)` string: PDF escapes, octal escapes, and a line continuation. */
function decodeLiteral(token: string): string {
  const body = token.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    const simple: Record<string, string> = { n: '\n', r: '\n', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
    if (next === '\n' || next === '\r') {
      i += 1; // a backslash at end of line continues the string
      continue;
    }
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      out += String.fromCharCode(parseInt(octal, 8));
      i += octal.length;
      continue;
    }
    out += simple[next] ?? next;
    i += 1;
  }
  return out;
}

/** A `<…>` string: two hex digits per byte, or the font's CMap when one applies. */
function decodeHex(hex: string, cmap?: Map<number, string>): string {
  const clean = hex.replace(/\s+/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  if (cmap && cmap.size > 0) {
    // CMaps in practice are 2-byte; a 1-byte map is read a byte at a time.
    const width = [...cmap.keys()].some((code) => code > 0xff) ? 4 : 2;
    let out = '';
    for (let i = 0; i + width <= padded.length; i += width) {
      const code = parseInt(padded.slice(i, i + width), 16);
      out += cmap.get(code) ?? '';
    }
    return out;
  }
  let out = '';
  for (let i = 0; i + 2 <= padded.length; i += 2) out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  return out;
}

/** `beginbfchar`/`beginbfrange` entries of a `/ToUnicode` CMap. */
export function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1]!, 16), utf16From(pair[2]!));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const from = parseInt(range[1]!, 16);
      const to = parseInt(range[2]!, 16);
      const base = parseInt(range[3]!, 16);
      // A range is usually a handful of codes; a malformed one is ignored rather than trusted.
      if (to < from || to - from > 4096) continue;
      for (let code = from; code <= to; code += 1) map.set(code, String.fromCodePoint(base + (code - from)));
    }
  }
  return map;
}

function utf16From(hex: string): string {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out.length > 0 ? out : String.fromCharCode(parseInt(hex, 16));
}

/** Collapses the runs of spaces a text layer produces, keeping line structure. */
export function normaliseWhitespace(text: string): string {
  return (
    text
      .replace(/\0/g, '')
      .split('\n')
      .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
      .join('\n')
      // A run of blank lines collapses to one, but a single blank line **survives**: it is the
      // paragraph break, and segmentation uses it as its primary chunk boundary. Dropping empty
      // lines here would hand the segmenter one undifferentiated run of text per page.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
