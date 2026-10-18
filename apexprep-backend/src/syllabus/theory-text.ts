import { createHash } from 'node:crypto';
import type { ErrorDetail } from '../common/errors/app-exception';
import type { BlockFormat } from '../database/schema';

/**
 * Pure helpers for theory blocks: text normalisation, the content hash used for
 * duplicate detection, the reading-time estimate, and the per-format content shape.
 * No Nest or database imports, so they are unit-tested directly.
 */

/** Unicode NFC, LF line endings, collapsed spaces, at most one blank line, trimmed. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** SHA-256 (lowercase hex) of the normalised text. Matches content_blocks.content_hash. */
export function contentHash(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Reading speed for the "N min read" label. The frontend shows `readMinutes` but no
 * requirement defines it; 200 words per minute is a conventional figure for technical
 * prose (DECISIONS.md §B22). Any non-empty text reads in at least one minute.
 */
export const READING_WORDS_PER_MINUTE = 200;

export function estimateReadMinutes(texts: readonly string[], wordsPerMinute = READING_WORDS_PER_MINUTE): number {
  const words = texts.reduce((n, t) => n + (t.match(/\S+/g)?.length ?? 0), 0);
  return words === 0 ? 0 : Math.max(1, Math.ceil(words / wordsPerMinute));
}

/** Formats an admin can author by hand. `figure` needs an uploaded image (content ingestion, Phase 7). */
export const AUTHORABLE_FORMATS = ['heading', 'paragraph', 'formula', 'callout', 'list', 'table', 'example'] as const;
export type AuthorableFormat = (typeof AUTHORABLE_FORMATS)[number];

export const THEORY_LIMITS = {
  bodyMax: 20000,
  titleMax: 300,
  listItemsMax: 100,
  listItemMax: 2000,
  tableColumnsMax: 20,
  tableRowsMax: 200,
  tableCellMax: 1000,
} as const;

export interface TableContent {
  columns: string[];
  rows: string[][];
}

export interface TheoryBlockInput {
  format: AuthorableFormat;
  body?: string | null;
  items?: string[] | null;
  table?: TableContent | null;
}

export interface TheoryBlockContent {
  rawText: string;
  contentJson: Record<string, unknown> | null;
}

/**
 * Validates the content fields a format needs and builds what is stored:
 * `raw_text` (searchable plain text) and `content_json` (structure for lists and tables).
 * Returns either the content or field-level errors.
 */
export function buildTheoryBlockContent(input: TheoryBlockInput): { ok: true; value: TheoryBlockContent } | { ok: false; errors: ErrorDetail[] } {
  const errors: ErrorDetail[] = [];
  const body = input.body == null ? null : normalizeText(input.body);
  const structured = input.format === 'list' || input.format === 'table';

  if (input.format !== 'list' && input.items != null) errors.push({ field: 'items', message: 'items are only allowed on list blocks' });
  if (input.format !== 'table' && input.table != null) errors.push({ field: 'table', message: 'table is only allowed on table blocks' });
  if (!structured && !body) errors.push({ field: 'body', message: `a ${input.format} block needs a non-blank body` });
  if (body && body.length > THEORY_LIMITS.bodyMax) errors.push({ field: 'body', message: `body must be at most ${THEORY_LIMITS.bodyMax} characters` });

  let contentJson: Record<string, unknown> | null = null;
  let structuredText = '';

  if (input.format === 'list') {
    const items = (input.items ?? []).map(normalizeText);
    if (items.length === 0) errors.push({ field: 'items', message: 'a list block needs at least one item' });
    if (items.length > THEORY_LIMITS.listItemsMax) errors.push({ field: 'items', message: `at most ${THEORY_LIMITS.listItemsMax} items` });
    if (items.some((i) => i.length === 0 || i.length > THEORY_LIMITS.listItemMax)) {
      errors.push({ field: 'items', message: `each item must be 1-${THEORY_LIMITS.listItemMax} characters` });
    }
    contentJson = body ? { intro: body, items } : { items };
    structuredText = items.join('\n');
  }

  if (input.format === 'table') {
    const table = input.table;
    const wellFormed =
      table != null &&
      Array.isArray(table.columns) &&
      table.columns.every((c) => typeof c === 'string') &&
      Array.isArray(table.rows) &&
      table.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'));
    if (!table) {
      errors.push({ field: 'table', message: 'a table block needs a table' });
    } else if (!wellFormed) {
      errors.push({ field: 'table', message: 'columns must be strings and rows must be arrays of strings' });
    } else {
      const columns = table.columns.map(normalizeText);
      const rows = table.rows.map((r) => r.map(normalizeText));
      if (columns.length === 0 || columns.length > THEORY_LIMITS.tableColumnsMax) {
        errors.push({ field: 'table.columns', message: `a table needs 1-${THEORY_LIMITS.tableColumnsMax} columns` });
      }
      if (rows.length === 0 || rows.length > THEORY_LIMITS.tableRowsMax) {
        errors.push({ field: 'table.rows', message: `a table needs 1-${THEORY_LIMITS.tableRowsMax} rows` });
      }
      if (rows.some((r) => r.length !== columns.length)) {
        errors.push({ field: 'table.rows', message: 'every row must have one cell per column' });
      }
      if ([...columns, ...rows.flat()].some((c) => c.length > THEORY_LIMITS.tableCellMax)) {
        errors.push({ field: 'table', message: `each cell must be at most ${THEORY_LIMITS.tableCellMax} characters` });
      }
      contentJson = body ? { intro: body, columns, rows } : { columns, rows };
      structuredText = [columns.join(' | '), ...rows.map((r) => r.join(' | '))].join('\n');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const rawText = [body, structuredText].filter((t): t is string => Boolean(t)).join('\n');
  return { ok: true, value: { rawText, contentJson } };
}

/** What a reader sees for one stored block. Tolerates blocks produced by ingestion. */
export interface RenderedBlock {
  body: string | null;
  items?: string[];
  table?: TableContent;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function renderBlock(format: BlockFormat, text: string, contentJson: unknown): RenderedBlock {
  const json = contentJson && typeof contentJson === 'object' && !Array.isArray(contentJson) ? (contentJson as Record<string, unknown>) : {};
  const intro = typeof json.intro === 'string' ? json.intro : null;
  if (format === 'list' && isStringArray(json.items)) return { body: intro, items: json.items };
  if (format === 'table' && isStringArray(json.columns) && Array.isArray(json.rows) && json.rows.every(isStringArray)) {
    return { body: intro, table: { columns: json.columns, rows: json.rows } };
  }
  return { body: text };
}
