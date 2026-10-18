import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { AppException } from '../errors/app-exception';

/**
 * Keyset (cursor) pagination over (created_at DESC, id DESC).
 *
 * The cursor is opaque to clients: base64url of {"t": timestamp, "i": uuid}. The timestamp
 * keeps Postgres' full microsecond precision (a JS Date would truncate to milliseconds and
 * silently skip rows created within the same millisecond). Stable under concurrent inserts.
 */
export interface CursorPosition {
  ts: string; // e.g. 2026-09-22T04:36:01.123456Z
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MICRO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(pos: CursorPosition): string {
  return Buffer.from(JSON.stringify({ t: pos.ts, i: pos.id })).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== 'string' || !MICRO_TS.test(parsed.t) || typeof parsed.i !== 'string' || !UUID.test(parsed.i)) {
      throw new Error('bad cursor');
    }
    return { ts: parsed.t, id: parsed.i };
  } catch {
    throw AppException.validation([{ field: 'cursor', message: 'cursor is invalid' }]);
  }
}

/** Select this alongside rows to build the next cursor with full precision. */
export function cursorTimestamp(createdAt: AnyColumn): SQL<string> {
  return sql<string>`to_char(${createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** WHERE clause for "rows after this cursor" in (created_at DESC, id DESC) order. */
export function afterCursor(createdAt: AnyColumn, id: AnyColumn, pos: CursorPosition): SQL {
  return sql`(${createdAt}, ${id}) < (${pos.ts}::timestamptz, ${pos.id}::uuid)`;
}

export class CursorQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page (`nextCursor`)' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/, { message: 'cursor is invalid' })
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Query limit + 1 rows, then call this to trim the extra row and compute nextCursor. */
export function toPage<R extends { cursorTs: string; id: string }, T>(rows: R[], limit: number, map: (row: R) => T): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: pageRows.map(map), nextCursor: hasMore && last ? encodeCursor({ ts: last.cursorTs, id: last.id }) : null };
}
