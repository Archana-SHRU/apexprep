/**
 * Exact decimal comparison for numeric answers, on BigInt — never on floats.
 *
 * A tolerance check like |4.2 − 4.1| ≤ 0.1 is false in binary floating point
 * (0.10000000000000053 > 0.1), which would mark a correct answer wrong. Answer keys are
 * stored as `numeric` strings for the same reason, so grading keeps them as strings too.
 */

export interface Decimal {
  /** Unscaled value: 4.20 → 420n with scale 2. */
  units: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^[+-]?\d{1,20}(\.\d{1,12})?$/;

export function parseDecimal(input: string): Decimal | null {
  const text = input.trim();
  if (!DECIMAL_PATTERN.test(text)) return null;
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(`${whole!}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

function rescale(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

/** Aligns two decimals to a common scale. */
function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return { a: rescale(a, scale), b: rescale(b, scale), scale };
}

export function compareDecimals(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const { a: x, b: y } = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function equalDecimals(a: Decimal, b: Decimal): boolean {
  return compareDecimals(a, b) === 0;
}

export function absDifference(a: Decimal, b: Decimal): Decimal {
  const { a: x, b: y, scale } = align(a, b);
  const diff = x - y;
  return { units: diff < 0n ? -diff : diff, scale };
}

export function multiply(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function absolute(value: Decimal): Decimal {
  return { units: value.units < 0n ? -value.units : value.units, scale: value.scale };
}

export function isInteger(value: Decimal): boolean {
  return value.scale === 0 || value.units % 10n ** BigInt(value.scale) === 0n;
}

/**
 * Whether `given` is within `tolerance` of `correct`.
 *  - absolute: |given − correct| ≤ tolerance
 *  - relative: |given − correct| ≤ tolerance × |correct|
 */
export function withinTolerance(given: Decimal, correct: Decimal, tolerance: Decimal, mode: 'absolute' | 'relative'): boolean {
  const difference = absDifference(given, correct);
  const allowed = mode === 'relative' ? multiply(tolerance, absolute(correct)) : tolerance;
  return compareDecimals(difference, allowed) <= 0;
}
