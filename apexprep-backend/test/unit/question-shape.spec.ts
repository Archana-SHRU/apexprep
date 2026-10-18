import { validateQuestionShape, type QuestionShapeInput } from '../../src/questions/question-shape';

const opts = (...keys: string[]) => keys.map((k) => ({ key: k, text: `option ${k}` }));
const correct = (key: string, ...keys: string[]) => opts(key, ...keys).map((o, i) => ({ ...o, isCorrect: i === 0 }));

function expectOk(input: QuestionShapeInput) {
  const outcome = validateQuestionShape(input);
  if (!outcome.ok) throw new Error(`expected valid, got: ${JSON.stringify(outcome.errors)}`);
  return outcome.value;
}

function expectFields(input: QuestionShapeInput): string[] {
  const outcome = validateQuestionShape(input);
  expect(outcome.ok).toBe(false);
  return outcome.ok ? [] : outcome.errors.map((e) => e.field ?? '');
}

describe('question shape: option types', () => {
  it('accepts single_correct with exactly one correct option and normalises it for storage', () => {
    const value = expectOk({ type: 'single_correct', options: correct('A', 'B', 'C', 'D') });
    expect(value.options).toEqual([
      { optionKey: 'A', side: 'single', body: 'option A', isCorrect: true, sortOrder: 0 },
      { optionKey: 'B', side: 'single', body: 'option B', isCorrect: false, sortOrder: 1 },
      { optionKey: 'C', side: 'single', body: 'option C', isCorrect: false, sortOrder: 2 },
      { optionKey: 'D', side: 'single', body: 'option D', isCorrect: false, sortOrder: 3 },
    ]);
    expect(value.correctNumeric).toBeNull();
    expect(value.matrixAnswer).toBeNull();
  });

  it.each(['single_correct', 'assertion_reason'] as const)('rejects %s with none or several correct options', (type) => {
    expect(expectFields({ type, options: opts('A', 'B') })).toContain('options');
    expect(expectFields({ type, options: opts('A', 'B').map((o) => ({ ...o, isCorrect: true })) })).toContain('options');
  });

  it('accepts multi_correct with several correct options but not with none', () => {
    expect(expectOk({ type: 'multi_correct', options: opts('A', 'B', 'C').map((o, i) => ({ ...o, isCorrect: i < 2 })) }).options).toHaveLength(3);
    expect(expectFields({ type: 'multi_correct', options: opts('A', 'B') })).toContain('options');
  });

  it('rejects fewer than two options, duplicate keys, bad keys and blank text', () => {
    expect(expectFields({ type: 'single_correct', options: correct('A') })).toContain('options');
    expect(expectFields({ type: 'single_correct', options: [...correct('A'), { key: 'A', text: 'again' }] })).toContain('options');
    expect(expectFields({ type: 'single_correct', options: [...correct('A'), { key: 'toolong', text: 'x' }] })).toContain('options[1].key');
    expect(expectFields({ type: 'single_correct', options: [...correct('A'), { key: 'B', text: '   ' }] })).toContain('options[1].text');
  });

  it('rejects matrix sides on ordinary option questions', () => {
    expect(expectFields({ type: 'single_correct', options: [...correct('A'), { key: 'B', text: 'x', side: 'left' }] })).toContain('options');
  });
});

describe('question shape: numeric types', () => {
  it('forces an exact absolute tolerance for integer answers', () => {
    const value = expectOk({ type: 'integer', numericAnswer: { value: '12' } });
    expect(value).toMatchObject({ correctNumeric: '12', numericTolerance: '0', toleranceMode: 'absolute' });
  });

  it('rejects a fractional integer answer or a non-zero tolerance', () => {
    expect(expectFields({ type: 'integer', numericAnswer: { value: '1.5' } })).toContain('numericAnswer.value');
    expect(expectFields({ type: 'integer', numericAnswer: { value: '2', tolerance: '0.1' } })).toContain('numericAnswer.tolerance');
    expect(expectFields({ type: 'integer', numericAnswer: { value: '2', mode: 'relative' } })).toContain('numericAnswer.mode');
  });

  it('keeps a numeric answer exactly as written, with its tolerance and mode', () => {
    expect(expectOk({ type: 'numeric', numericAnswer: { value: '4.20', tolerance: '0.05', mode: 'absolute' } })).toMatchObject({
      correctNumeric: '4.20',
      numericTolerance: '0.05',
      toleranceMode: 'absolute',
    });
  });

  it('requires a value, a tolerance and a mode for numeric answers', () => {
    expect(expectFields({ type: 'numeric' })).toContain('numericAnswer');
    expect(expectFields({ type: 'numeric', numericAnswer: { value: '4.2' } })).toEqual(
      expect.arrayContaining(['numericAnswer.tolerance', 'numericAnswer.mode']),
    );
    expect(expectFields({ type: 'numeric', numericAnswer: { value: '4.2', tolerance: '-1', mode: 'absolute' } })).toContain('numericAnswer.tolerance');
    expect(expectFields({ type: 'numeric', numericAnswer: { value: 'abc', tolerance: '0', mode: 'absolute' } })).toContain('numericAnswer.value');
  });

  it('rejects options on numeric and long-form questions', () => {
    expect(expectFields({ type: 'integer', numericAnswer: { value: '1' }, options: opts('A', 'B') })).toContain('options');
    expect(expectFields({ type: 'long_form', options: opts('A', 'B') })).toContain('options');
  });

  it('accepts a long_form question with nothing but a stem', () => {
    expect(expectOk({ type: 'long_form' })).toMatchObject({ options: [], correctNumeric: null, matrixAnswer: null });
  });
});

describe('question shape: matrix_match', () => {
  const matrixOptions = [
    { key: 'A', text: 'left A', side: 'left' as const },
    { key: 'B', text: 'left B', side: 'left' as const },
    { key: 'p', text: 'right p', side: 'right' as const },
    { key: 'q', text: 'right q', side: 'right' as const },
  ];

  it('accepts consistent left/right items with an answer for every left item', () => {
    const value = expectOk({ type: 'matrix_match', options: matrixOptions, matrixAnswer: { A: ['q'], B: ['p', 'q'] } });
    expect(value.matrixAnswer).toEqual({ A: ['q'], B: ['p', 'q'] });
    expect(value.options.map((o) => o.side)).toEqual(['left', 'left', 'right', 'right']);
    expect(value.options.every((o) => !o.isCorrect)).toBe(true);
  });

  it('rejects an unanswered left item, an unknown key and an unknown value', () => {
    expect(expectFields({ type: 'matrix_match', options: matrixOptions, matrixAnswer: { A: ['q'] } })).toContain('matrixAnswer');
    expect(expectFields({ type: 'matrix_match', options: matrixOptions, matrixAnswer: { A: ['q'], B: ['p'], Z: ['p'] } })).toContain('matrixAnswer.Z');
    expect(expectFields({ type: 'matrix_match', options: matrixOptions, matrixAnswer: { A: ['zz'], B: ['p'] } })).toContain('matrixAnswer.A');
    expect(expectFields({ type: 'matrix_match', options: matrixOptions, matrixAnswer: { A: [], B: ['p'] } })).toContain('matrixAnswer.A');
    expect(expectFields({ type: 'matrix_match', options: matrixOptions, matrixAnswer: { A: ['p', 'p'], B: ['p'] } })).toContain('matrixAnswer.A');
  });

  it('needs at least two items on each side and no isCorrect flags', () => {
    expect(expectFields({ type: 'matrix_match', options: matrixOptions.slice(0, 3), matrixAnswer: { A: ['p'], B: ['p'] } })).toContain('options');
    expect(
      expectFields({
        type: 'matrix_match',
        options: matrixOptions.map((o) => (o.key === 'A' ? { ...o, isCorrect: true } : o)),
        matrixAnswer: { A: ['q'], B: ['p'] },
      }),
    ).toContain('options');
  });

  it('requires a matrix answer, and rejects one on other types', () => {
    expect(expectFields({ type: 'matrix_match', options: matrixOptions })).toContain('matrixAnswer');
    expect(expectFields({ type: 'single_correct', options: correct('A', 'B'), matrixAnswer: { A: ['p'] } })).toContain('matrixAnswer');
  });
});
