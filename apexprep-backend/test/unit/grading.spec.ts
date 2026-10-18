import {
  absDifference,
  compareDecimals,
  equalDecimals,
  isInteger,
  multiply,
  parseDecimal,
  withinTolerance,
} from '../../src/practice/decimal';
import { gradeResponse, revealedAnswer, type AnswerKey, type StudentResponse } from '../../src/practice/grading';

const d = (s: string) => parseDecimal(s)!;

describe('exact decimal arithmetic', () => {
  it('parses decimals into units and scale', () => {
    expect(parseDecimal('4.20')).toEqual({ units: 420n, scale: 2 });
    expect(parseDecimal('-0.005')).toEqual({ units: -5n, scale: 3 });
    expect(parseDecimal('12')).toEqual({ units: 12n, scale: 0 });
    expect(parseDecimal('+7.5')).toEqual({ units: 75n, scale: 1 });
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', 'abc', '1e5', '1.2.3', '--1', '0x10', ' 1 2 ']) expect(parseDecimal(bad)).toBeNull();
  });

  it('compares across different scales', () => {
    expect(equalDecimals(d('4.2'), d('4.20'))).toBe(true);
    expect(compareDecimals(d('4.19'), d('4.2'))).toBe(-1);
    expect(compareDecimals(d('4.21'), d('4.2'))).toBe(1);
  });

  it('gets tolerance right where floating point does not', () => {
    // 4.2 − 4.1 is 0.10000000000000053 in binary floating point, which would fail this.
    expect(withinTolerance(d('4.2'), d('4.1'), d('0.1'), 'absolute')).toBe(true);
    expect(withinTolerance(d('4.2001'), d('4.1'), d('0.1'), 'absolute')).toBe(false);
    expect(absDifference(d('4.2'), d('4.1'))).toEqual({ units: 1n, scale: 1 }); // 0.1 at the common scale
  });

  it('applies a relative tolerance as a fraction of the correct value', () => {
    // 1% of 200 is 2
    expect(withinTolerance(d('202'), d('200'), d('0.01'), 'relative')).toBe(true);
    expect(withinTolerance(d('202.01'), d('200'), d('0.01'), 'relative')).toBe(false);
    expect(multiply(d('0.01'), d('200'))).toEqual({ units: 200n, scale: 2 });
  });

  it('treats a zero tolerance as exact', () => {
    expect(withinTolerance(d('5'), d('5.00'), d('0'), 'absolute')).toBe(true);
    expect(withinTolerance(d('5.01'), d('5.00'), d('0'), 'absolute')).toBe(false);
  });

  it('knows whether a value is a whole number', () => {
    expect([isInteger(d('5')), isInteger(d('5.0')), isInteger(d('5.1'))]).toEqual([true, true, false]);
  });
});

describe('grading a response', () => {
  const optionKey = (correct: string[], all = ['A', 'B', 'C', 'D']): AnswerKey => ({
    type: 'single_correct',
    correctOptionKeys: correct,
    optionKeys: { single: all, left: [], right: [] },
    correctNumeric: null,
    numericTolerance: null,
    toleranceMode: null,
    matrixAnswer: null,
  });

  const grade = (key: AnswerKey, response: StudentResponse) => gradeResponse(key, response);

  describe('single correct', () => {
    it('marks the right option correct and stores what was chosen', () => {
      expect(grade(optionKey(['B']), { optionKeys: ['B'] })).toEqual({ ok: true, score: 1, outcome: 'correct', stored: { option_keys: ['B'] } });
    });

    it('marks any other option incorrect', () => {
      expect(grade(optionKey(['B']), { optionKeys: ['C'] })).toMatchObject({ score: 0, outcome: 'incorrect' });
    });

    it('refuses an empty, duplicated, unknown or multiple choice', () => {
      expect(grade(optionKey(['B']), { optionKeys: [] })).toMatchObject({ ok: false, field: 'response.optionKeys' });
      expect(grade(optionKey(['B']), { optionKeys: ['B', 'B'] })).toMatchObject({ ok: false });
      expect(grade(optionKey(['B']), { optionKeys: ['Z'] })).toMatchObject({ ok: false });
      expect(grade(optionKey(['B']), { optionKeys: ['A', 'B'] })).toMatchObject({ ok: false });
    });

    it('refuses a response of the wrong shape', () => {
      expect(grade(optionKey(['B']), { value: '4' })).toMatchObject({ ok: false, field: 'response.optionKeys' });
    });
  });

  /**
   * Regression tests. A response reaches grading having passed DTO validation, which accepts the
   * envelope but not the *type* of what is inside it: `{ optionKeys: "B" }` and
   * `{ optionKeys: [1, 2] }` both arrive here. Every one of these used to reach a string method on
   * a non-string and surface as a 500 — an unhandled server error for a malformed request, which
   * tells a client nothing and puts noise in the logs where a real fault should stand out.
   */
  describe('a malformed response is a bad request, never a server error', () => {
    const shapes: [string, unknown][] = [
      ['a string where a list of keys belongs', { optionKeys: 'B' }],
      ['numbers inside the list of keys', { optionKeys: [1, 2] }],
      ['null inside the list of keys', { optionKeys: [null] }],
      ['an object inside the list of keys', { optionKeys: [{ key: 'B' }] }],
      ['a nested list', { optionKeys: [['B']] }],
    ];

    it.each(shapes)('refuses %s with a field, not an exception', (_label, response) => {
      const result = grade(optionKey(['B']), response as StudentResponse);
      expect(result).toMatchObject({ ok: false, field: 'response.optionKeys' });
    });

    it('refuses a non-string numeric value rather than parsing an object', () => {
      const key: AnswerKey = {
        type: 'integer',
        correctOptionKeys: [],
        optionKeys: { single: [], left: [], right: [] },
        correctNumeric: '4',
        numericTolerance: null,
        toleranceMode: null,
        matrixAnswer: null,
      };
      expect(grade(key, { value: 4 } as unknown as StudentResponse)).toMatchObject({ ok: false, field: 'response.value' });
      expect(grade(key, { value: null } as unknown as StudentResponse)).toMatchObject({ ok: false });
      expect(grade(key, { value: { n: 4 } } as unknown as StudentResponse)).toMatchObject({ ok: false });
    });

    it('refuses a non-string long-form answer', () => {
      const key: AnswerKey = {
        type: 'long_form',
        correctOptionKeys: [],
        optionKeys: { single: [], left: [], right: [] },
        correctNumeric: null,
        numericTolerance: null,
        toleranceMode: null,
        matrixAnswer: null,
      };
      expect(grade(key, { text: 42 } as unknown as StudentResponse)).toMatchObject({ ok: false, field: 'response.text' });
    });
  });

  describe('multi correct', () => {
    const key = { ...optionKey(['A', 'C']), type: 'multi_correct' as const };

    it('needs the exact set: no partial credit', () => {
      expect(grade(key, { optionKeys: ['C', 'A'] })).toMatchObject({ score: 1, outcome: 'correct' });
      expect(grade(key, { optionKeys: ['A'] })).toMatchObject({ score: 0, outcome: 'incorrect' });
      expect(grade(key, { optionKeys: ['A', 'C', 'D'] })).toMatchObject({ score: 0, outcome: 'incorrect' });
    });

    it('stores the chosen keys in a stable order', () => {
      expect(grade(key, { optionKeys: ['C', 'A'] })).toMatchObject({ stored: { option_keys: ['A', 'C'] } });
    });
  });

  describe('integer and numeric', () => {
    const integer: AnswerKey = { ...optionKey([], []), type: 'integer', correctNumeric: '12', numericTolerance: '0', toleranceMode: 'absolute' };
    const numeric: AnswerKey = { ...optionKey([], []), type: 'numeric', correctNumeric: '4.20', numericTolerance: '0.05', toleranceMode: 'absolute' };

    it('accepts an exact integer in any equivalent form', () => {
      expect(grade(integer, { value: '12' })).toMatchObject({ outcome: 'correct' });
      expect(grade(integer, { value: '12.0' })).toMatchObject({ outcome: 'correct' });
      expect(grade(integer, { value: '13' })).toMatchObject({ outcome: 'incorrect' });
    });

    it('applies the tolerance for a numeric answer', () => {
      expect(grade(numeric, { value: '4.24' })).toMatchObject({ outcome: 'correct' });
      expect(grade(numeric, { value: '4.25' })).toMatchObject({ outcome: 'correct' });
      expect(grade(numeric, { value: '4.26' })).toMatchObject({ outcome: 'incorrect' });
      expect(grade(numeric, { value: '4.15' })).toMatchObject({ outcome: 'correct' });
    });

    it('refuses a value that is not a number', () => {
      expect(grade(numeric, { value: 'about four' })).toMatchObject({ ok: false, field: 'response.value' });
    });

    it('refuses to grade against a broken answer key instead of guessing', () => {
      const broken: AnswerKey = { ...numeric, numericTolerance: null };
      expect(grade(broken, { value: '4.2' })).toMatchObject({ ok: false });
    });
  });

  describe('matrix match', () => {
    const key: AnswerKey = {
      ...optionKey([], []),
      type: 'matrix_match',
      optionKeys: { single: [], left: ['A', 'B'], right: ['p', 'q'] },
      matrixAnswer: { A: ['q'], B: ['p', 'q'] },
    };

    it('needs every pairing to match', () => {
      expect(grade(key, { matrix: { A: ['q'], B: ['q', 'p'] } })).toMatchObject({ outcome: 'correct' });
      expect(grade(key, { matrix: { A: ['q'], B: ['p'] } })).toMatchObject({ outcome: 'incorrect' });
      expect(grade(key, { matrix: { A: ['q'] } })).toMatchObject({ outcome: 'incorrect' });
    });

    it('refuses unknown or repeated keys', () => {
      expect(grade(key, { matrix: { Z: ['q'] } })).toMatchObject({ ok: false, field: 'response.matrix.Z' });
      expect(grade(key, { matrix: { A: ['zz'], B: ['p'] } })).toMatchObject({ ok: false, field: 'response.matrix.A' });
      expect(grade(key, { matrix: { A: ['q', 'q'], B: ['p'] } })).toMatchObject({ ok: false, field: 'response.matrix.A' });
    });
  });

  describe('long form', () => {
    const key: AnswerKey = { ...optionKey([], []), type: 'long_form' };

    it('is stored ungraded, with no score', () => {
      expect(grade(key, { text: 'Taking torque about the contact point…' })).toEqual({
        ok: true,
        score: null,
        outcome: 'ungraded',
        stored: { text: 'Taking torque about the contact point…' },
      });
    });

    it('still refuses an empty answer', () => {
      expect(grade(key, { text: '   ' })).toMatchObject({ ok: false, field: 'response.text' });
    });
  });

  describe('revealed answer', () => {
    it('is the option keys, the numeric key with its tolerance, or the matrix', () => {
      expect(revealedAnswer(optionKey(['B']))).toEqual({ optionKeys: ['B'] });
      expect(revealedAnswer({ ...optionKey([], []), type: 'numeric', correctNumeric: '4.20', numericTolerance: '0.05', toleranceMode: 'absolute' })).toEqual({
        value: '4.20',
        tolerance: '0.05',
        mode: 'absolute',
      });
      expect(revealedAnswer({ ...optionKey([], []), type: 'matrix_match', matrixAnswer: { A: ['q'] } })).toEqual({ matrix: { A: ['q'] } });
      expect(revealedAnswer({ ...optionKey([], []), type: 'long_form' })).toEqual({});
    });
  });
});
