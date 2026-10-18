import type { FullQuestionKey } from '../../src/mock-tests/mock-tests.repository';
import { gradePaper, isBlankResponse, type GradableItem } from '../../src/mock-tests/mock-test-grading';

/**
 * The marking scheme, pinned. These are the figures the product has always produced (+4 / −1, unanswered 0,
 * total floored at 0) — the tests exist so a refactor cannot change them silently.
 */
describe('gradePaper', () => {
  const mcq = (id: string, correct: string): FullQuestionKey => ({
    id,
    stem: 'stem',
    stemJson: null,
    type: 'single_correct',
    correctOptionKeys: [correct],
    optionKeys: { single: ['A', 'B', 'C', 'D'], left: [], right: [] },
    options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: key, isCorrect: key === correct, side: 'single' })),
    correctNumeric: null,
    numericTolerance: null,
    toleranceMode: null,
    matrixAnswer: null,
  });
  const numeric = (id: string): FullQuestionKey => ({
    id,
    stem: 'g?',
    stemJson: null,
    type: 'numeric',
    correctOptionKeys: [],
    optionKeys: { single: [], left: [], right: [] },
    options: [],
    correctNumeric: '9.8',
    numericTolerance: '0.1',
    toleranceMode: 'absolute',
    matrixAnswer: null,
  });
  const longForm = (id: string): FullQuestionKey => ({ ...mcq(id, 'A'), type: 'long_form', correctOptionKeys: [], optionKeys: { single: [], left: [], right: [] }, options: [] });

  const item = (id: string, response: unknown, positive = 4, negative = 1): GradableItem => ({
    testItemId: `item-${id}`,
    questionId: `q-${id}`,
    positiveMarks: positive,
    negativeMarks: negative,
    response,
  });

  const keys = new Map<string, FullQuestionKey>([
    ['q-1', mcq('q-1', 'A')],
    ['q-2', numeric('q-2')],
    ['q-3', mcq('q-3', 'C')],
    ['q-4', longForm('q-4')],
  ]);

  it('awards positive marks, deducts negative marks and leaves unanswered at zero', () => {
    const paper = gradePaper([item('1', { optionKeys: ['A'] }), item('2', { value: '12.5' }), item('3', null)], keys);
    expect(paper.items).toEqual([
      { testItemId: 'item-1', isCorrect: true, score: 4, outcome: 'correct' },
      { testItemId: 'item-2', isCorrect: false, score: -1, outcome: 'incorrect' },
      { testItemId: 'item-3', isCorrect: false, score: 0, outcome: 'unattempted' },
    ]);
    expect(paper).toMatchObject({ rawScore: 3, totalScore: 3, maxScore: 12, correctCount: 1, incorrectCount: 1, unattemptedCount: 1, accuracy: 50 });
  });

  it('floors the total at zero but reports the unfloored score beside it', () => {
    const paper = gradePaper([item('1', { optionKeys: ['B'] }), item('3', { optionKeys: ['A'] })], keys);
    expect(paper.rawScore).toBe(-2);
    expect(paper.totalScore).toBe(0);
    expect(paper.items.map((i) => i.score)).toEqual([-1, -1]);
  });

  it('honours each item\'s own marks rather than a global scheme', () => {
    const paper = gradePaper([item('1', { optionKeys: ['A'] }, 3, 0), item('3', { optionKeys: ['A'] }, 4, 2)], keys);
    expect(paper.rawScore).toBe(1);
    expect(paper.maxScore).toBe(7);
  });

  it('does not score long-form or malformed answers, and does not count them as attempts', () => {
    const paper = gradePaper([item('4', { text: 'a derivation' }), item('1', { optionKeys: 'A' }), item('3', { optionKeys: ['A', 'B'] })], keys);
    expect(paper.rawScore).toBe(0);
    expect(paper.correctCount + paper.incorrectCount).toBe(0);
    expect(paper.unattemptedCount).toBe(3);
  });

  it('treats an item whose question has no key as unattempted rather than failing the paper', () => {
    const paper = gradePaper([item('9', { optionKeys: ['A'] })], keys);
    expect(paper.unattemptedCount).toBe(1);
    expect(paper.rawScore).toBe(0);
  });

  it('has zero accuracy, not NaN, when nothing was attempted', () => {
    expect(gradePaper([item('1', null), item('3', {})], keys).accuracy).toBe(0);
  });

  describe('isBlankResponse', () => {
    it.each([
      [null, true],
      [undefined, true],
      ['A', true],
      [['A'], true],
      [{}, true],
      [{ optionKeys: [] }, true],
      [{ value: '  ' }, true],
      [{ text: '' }, true],
      [{ matrix: {} }, true],
      [{ optionKeys: ['A'] }, false],
      [{ value: '0' }, false],
      [{ text: 'x' }, false],
      [{ matrix: { A: ['p'] } }, false],
    ])('%j → blank: %s', (response, blank) => {
      expect(isBlankResponse(response)).toBe(blank);
    });
  });
});
