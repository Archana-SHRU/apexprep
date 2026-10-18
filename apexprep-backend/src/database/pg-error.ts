/**
 * Postgres errors arrive either directly from node-postgres or wrapped by Drizzle
 * (DrizzleQueryError keeps the driver error in `cause`). This finds the driver error.
 */
export interface PgError {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
  message: string;
}

export function asPgError(err: unknown): PgError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as Partial<PgError> & { severity?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code) && 'severity' in candidate) {
      return candidate as PgError;
    }
    current = candidate.cause;
  }
  return null;
}

export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  INVALID_TEXT_REPRESENTATION: '22P02',
  // custom SQLSTATEs raised by our triggers (see migrations 0001–0005)
  IMMUTABLE: 'AP001',
  NOT_PUBLISHABLE: 'AP002',
  FOCUS_TRACKING_DISABLED: 'AP003',
  INVALID_CROSS_ROW_STATE: 'AP004',
} as const;

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = asPgError(err);
  return !!pg && pg.code === PG.UNIQUE_VIOLATION && (!constraint || pg.constraint === constraint);
}
