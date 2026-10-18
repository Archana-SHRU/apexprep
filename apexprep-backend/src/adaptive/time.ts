/** Calendar arithmetic shared by the engine. Unit conversions only — no tunables here. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}
