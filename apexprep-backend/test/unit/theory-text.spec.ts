import { createHash } from 'node:crypto';
import {
  buildTheoryBlockContent,
  contentHash,
  estimateReadMinutes,
  normalizeText,
  renderBlock,
  READING_WORDS_PER_MINUTE,
} from '../../src/syllabus/theory-text';

describe('normalizeText', () => {
  it('normalises line endings, collapses spaces and trims', () => {
    expect(normalizeText('  L = I  ω \r\n  τ = dL/dt  ')).toBe('L = I ω\nτ = dL/dt');
  });

  it('keeps one blank line between paragraphs but no more', () => {
    expect(normalizeText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('applies Unicode NFC so equal-looking text hashes the same', () => {
    expect(normalizeText('éclair')).toBe('éclair');
    expect(contentHash(normalizeText('éclair'))).toBe(contentHash(normalizeText('éclair')));
  });
});

describe('contentHash', () => {
  it('is the SHA-256 hex of the text, matching the content_blocks CHECK', () => {
    expect(contentHash('abc')).toBe(createHash('sha256').update('abc', 'utf8').digest('hex'));
    expect(contentHash('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('estimateReadMinutes', () => {
  it('is zero with no text and at least one minute for any text', () => {
    expect(estimateReadMinutes([])).toBe(0);
    expect(estimateReadMinutes(['', '   '])).toBe(0);
    expect(estimateReadMinutes(['one two three'])).toBe(1);
  });

  it('rounds up at the configured reading speed', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    expect(estimateReadMinutes([words(READING_WORDS_PER_MINUTE)])).toBe(1);
    expect(estimateReadMinutes([words(READING_WORDS_PER_MINUTE + 1)])).toBe(2);
    expect(estimateReadMinutes([words(100), words(150)])).toBe(2);
  });
});

describe('buildTheoryBlockContent', () => {
  const fields = (r: ReturnType<typeof buildTheoryBlockContent>) => (r.ok ? [] : r.errors.map((e) => e.field));

  it('stores plain text for a paragraph and no structure', () => {
    const r = buildTheoryBlockContent({ format: 'paragraph', body: '  Rolling without slipping: v = ωR ' });
    expect(r).toEqual({ ok: true, value: { rawText: 'Rolling without slipping: v = ωR', contentJson: null } });
  });

  it.each(['paragraph', 'formula', 'callout', 'heading', 'example'] as const)('requires a body for a %s block', (format) => {
    expect(fields(buildTheoryBlockContent({ format }))).toContain('body');
    expect(fields(buildTheoryBlockContent({ format, body: '   ' }))).toContain('body');
  });

  it('stores list items as structure and as searchable text', () => {
    const r = buildTheoryBlockContent({ format: 'list', items: ['Thin ring: MR²', 'Solid sphere: ⅖MR²'] });
    expect(r.ok && r.value.contentJson).toEqual({ items: ['Thin ring: MR²', 'Solid sphere: ⅖MR²'] });
    expect(r.ok && r.value.rawText).toBe('Thin ring: MR²\nSolid sphere: ⅖MR²');
  });

  it('keeps an introduction alongside list items', () => {
    const r = buildTheoryBlockContent({ format: 'list', body: 'Standard results:', items: ['Ring: MR²'] });
    expect(r.ok && r.value.contentJson).toEqual({ intro: 'Standard results:', items: ['Ring: MR²'] });
  });

  it('rejects an empty list, a blank item, and items on a non-list block', () => {
    expect(fields(buildTheoryBlockContent({ format: 'list', items: [] }))).toContain('items');
    expect(fields(buildTheoryBlockContent({ format: 'list', items: ['ok', ' '] }))).toContain('items');
    expect(fields(buildTheoryBlockContent({ format: 'paragraph', body: 'x', items: ['a'] }))).toContain('items');
  });

  it('stores a table and rejects ragged rows, empty tables and non-string cells', () => {
    const ok = buildTheoryBlockContent({ format: 'table', table: { columns: ['Body', 'I'], rows: [['Ring', 'MR²']] } });
    expect(ok.ok && ok.value.contentJson).toEqual({ columns: ['Body', 'I'], rows: [['Ring', 'MR²']] });
    expect(ok.ok && ok.value.rawText).toBe('Body | I\nRing | MR²');
    expect(fields(buildTheoryBlockContent({ format: 'table', table: { columns: ['a', 'b'], rows: [['1']] } }))).toContain('table.rows');
    expect(fields(buildTheoryBlockContent({ format: 'table', table: { columns: [], rows: [] } }))).toEqual(
      expect.arrayContaining(['table.columns', 'table.rows']),
    );
    expect(fields(buildTheoryBlockContent({ format: 'table', table: { columns: ['a'], rows: [[1 as unknown as string]] } }))).toContain('table');
    expect(fields(buildTheoryBlockContent({ format: 'table' }))).toContain('table');
  });
});

describe('renderBlock', () => {
  it('returns items for a list block and an introduction when stored', () => {
    expect(renderBlock('list', 'a\nb', { items: ['a', 'b'] })).toEqual({ body: null, items: ['a', 'b'] });
    expect(renderBlock('list', 'a', { intro: 'Results:', items: ['a'] })).toEqual({ body: 'Results:', items: ['a'] });
  });

  it('returns a table for a table block', () => {
    expect(renderBlock('table', 'x', { columns: ['c'], rows: [['v']] })).toEqual({ body: null, table: { columns: ['c'], rows: [['v']] } });
  });

  it('falls back to plain text when a block has no usable structure (e.g. extracted content)', () => {
    expect(renderBlock('list', 'a. b. c', null)).toEqual({ body: 'a. b. c' });
    expect(renderBlock('table', 'raw text', { columns: 'nope' })).toEqual({ body: 'raw text' });
    expect(renderBlock('paragraph', 'text', { items: ['ignored'] })).toEqual({ body: 'text' });
  });
});
