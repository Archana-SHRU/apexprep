import { REPORTED_TIME_TOLERANCE_MS, trustedTimeMs } from '../../src/practice/attempts.service';

describe('trustedTimeMs', () => {
  it('keeps a reported time the clock can account for', () => {
    expect(trustedTimeMs(40_000, 90_000)).toBe(40_000);
  });

  it('keeps a reported time shorter than the question was open: the tab may have been elsewhere', () => {
    expect(trustedTimeMs(1_000, 600_000)).toBe(1_000);
  });

  it('allows the timer-rounding tolerance, and no more', () => {
    expect(trustedTimeMs(33_000, 30_000)).toBe(33_000);
    expect(trustedTimeMs(33_001, 30_000)).toBe(30_000 + REPORTED_TIME_TOLERANCE_MS);
  });

  it('cuts a time the server cannot account for to what it measured', () => {
    expect(trustedTimeMs(86_400_000, 12_000)).toBe(12_000 + REPORTED_TIME_TOLERANCE_MS);
  });

  it('believes the report when the server cannot measure (the item is gone)', () => {
    expect(trustedTimeMs(5_000, null)).toBe(5_000);
  });
});
