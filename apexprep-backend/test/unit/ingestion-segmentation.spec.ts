import { PdfDocument } from '../../src/pdf/pdf-document';
import { hashText, optionLines, segmentPages } from '../../src/ingestion/segmentation';
import { extractQuestion, readSourceDifficulty, sourceDifficultyToLabel } from '../../src/ingestion/question-extraction';
import { matchSolutions } from '../../src/ingestion/solution-matching';
import { makePdf } from '../fixtures/make-pdf';

/**
 * Scenarios K, L, M, P, Q, R, S and T (section 20): what the classifier decides, what the extractor
 * reads, and how a solution finds its question.
 *
 * Every assertion is on the pure modules, so these tests describe behaviour rather than plumbing.
 * The first block runs the real extractor over a real PDF first, because the interesting failures
 * live in the seam between the two: text that parses fine and segments into nonsense.
 */

const TEXTBOOK = [
  "Newton's Second Law",
  '',
  'The acceleration of a body is directly proportional to the net force acting on it and inversely proportional to its mass.',
  '',
  '1. A 2 kg block is pushed with a net force of 10 N. Find its acceleration.',
  '(A) 2 m/s^2',
  '(B) 5 m/s^2',
  '(C) 10 m/s^2',
  '(D) 20 m/s^2',
  'Answer: B',
  'Difficulty: easy',
  '',
  '2. A particle covers a displacement of 12 m in 4 s. Calculate its average speed in m/s.',
  'Answer: 3',
  'Difficulty: L2',
].join('\n');

const SOLUTIONS = ['Solutions', '', 'Solution 1. Using F = ma, a = 10 / 2 = 5 m/s^2. Ans: B', '', 'Solution 2. Speed is 12 / 4 = 3 m/s. Ans: 3'].join(
  '\n',
);

function pagesOf(...texts: string[]): { pageNumber: number; text: string }[] {
  return PdfDocument.parse(makePdf({ pages: texts, compress: true }))
    .extractText()
    .map((p) => ({ pageNumber: p.pageNumber, text: p.text }));
}

describe('K/L. blocks are classified with a reason, from a real extracted page', () => {
  const blocks = segmentPages(pagesOf(TEXTBOOK, SOLUTIONS));

  it('separates the heading, the prose, the questions and the solutions', () => {
    expect(blocks.map((b) => b.kind)).toEqual(['theory', 'theory', 'question', 'question', 'theory', 'solution', 'solution']);
  });

  it('records why each block was classified as it was', () => {
    for (const block of blocks) expect(block.reason).toMatch(/\S/);
    expect(blocks[2]!.reason).toContain('option lines');
    expect(blocks[5]!.reason).toContain('marker');
  });

  it('keeps reading order and the source page, so provenance survives', () => {
    expect(blocks.map((b) => b.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(blocks.map((b) => b.sourcePage)).toEqual([1, 1, 1, 1, 2, 2, 2]);
  });

  it('keeps the answer line with its own question rather than splitting it off', () => {
    expect(blocks[2]!.text).toContain('Answer: B');
    expect(blocks[3]!.text).toContain('Answer: 3');
  });

  it('reads the number a question printed, and the number a solution names', () => {
    expect(blocks[2]!.sourceNumber).toBe('1');
    expect(blocks[3]!.sourceNumber).toBe('2');
    expect(blocks[5]!.sourceNumber).toBe('1');
    expect(blocks[6]!.sourceNumber).toBe('2');
  });

  it('treats a plural "Solutions" heading as a heading, not an empty solution', () => {
    expect(blocks[4]).toMatchObject({ kind: 'theory', format: 'heading', title: 'Solutions' });
  });

  it('hashes the normalised text, so a re-run produces the same blocks', () => {
    const again = segmentPages(pagesOf(TEXTBOOK, SOLUTIONS));
    expect(again.map((b) => b.contentHash)).toEqual(blocks.map((b) => b.contentHash));
  });

  it('hashes past whitespace differences but not past content differences', () => {
    expect(hashText('a  b\n c ')).toBe(hashText('a b c'));
    expect(hashText('a b c')).not.toBe(hashText('a b d'));
  });
});

describe('M. a block the rules cannot place is ambiguous, not guessed', () => {
  it('marks a numbered line that is neither a question nor a heading as ambiguous', () => {
    const [block] = segmentPages([{ pageNumber: 1, text: '3. Thermodynamic Processes' }]);
    expect(block!.kind).toBe('ambiguous');
    expect(block!.confidence).toBeLessThan(0.5);
    expect(block!.reason).toMatch(/numbered heading/);
  });

  it('marks orphan option lines as ambiguous and says the page break is the likely cause', () => {
    const [block] = segmentPages([{ pageNumber: 2, text: '(A) 12 J\n(B) 24 J\n(C) 36 J' }]);
    expect(block!.kind).toBe('ambiguous');
    expect(block!.reason).toMatch(/split across a page boundary/);
  });

  it('scales every confidence on an OCR page by the page confidence', () => {
    const clean = segmentPages([{ pageNumber: 1, text: '1. Find x when 2x = 8.\n(A) 2\n(B) 4\nAnswer: B' }]);
    const ocr = segmentPages([{ pageNumber: 1, text: '1. Find x when 2x = 8.\n(A) 2\n(B) 4\nAnswer: B', fromOcr: true, ocrConfidence: 0.5 }]);
    expect(ocr[0]!.confidence).toBeCloseTo(clean[0]!.confidence * 0.5, 3);
  });
});

describe('P/Q. question extraction reuses the Phase 3 validator and reads every supported type', () => {
  it('reads a single-correct question, its options and its answer key', () => {
    const question = extractQuestion(
      ['1. A 2 kg block is pushed with a net force of 10 N. Find its acceleration.', '(A) 2 m/s^2', '(B) 5 m/s^2', '(C) 10 m/s^2', '(D) 20 m/s^2', 'Answer: B'].join('\n'),
    );
    expect(question.type).toBe('single_correct');
    expect(question.stem).toContain('2 kg block');
    expect(question.stem).not.toMatch(/^1\./);
    expect(question.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(question.options.filter((o) => o.isCorrect).map((o) => o.key)).toEqual(['B']);
    expect(question.gaps).toEqual([]);
    expect(question.shapeValid).toBe(true);
  });

  it('reads a multi-correct question when the answer line names two options', () => {
    const question = extractQuestion(
      ['4. Which of these are vectors?', '(A) velocity', '(B) mass', '(C) force', '(D) temperature', 'Answer: A and C'].join('\n'),
    );
    expect(question.type).toBe('multi_correct');
    expect(question.options.filter((o) => o.isCorrect).map((o) => o.key)).toEqual(['A', 'C']);
  });

  it('reads an integer question and marks it exact', () => {
    const question = extractQuestion('7. How many moles are in 44 g of CO2? Answer: 1');
    expect(question.type).toBe('integer');
    expect(question.numericAnswer).toEqual({ value: '1', tolerance: '0', mode: 'absolute' });
    expect(question.shapeValid).toBe(true);
  });

  it('reads a numeric question with a stated tolerance', () => {
    const question = extractQuestion('8. Find g at the surface in m/s^2. Answer: 9.81 tolerance 0.02');
    expect(question.type).toBe('numeric');
    expect(question.numericAnswer).toMatchObject({ value: '9.81', tolerance: '0.02' });
  });

  it('reads an assertion-reason question', () => {
    const question = extractQuestion(
      ['9. Assertion: iron rusts in damp air. Reason: oxidation needs water.', '(A) both true, reason explains', '(B) both true, reason does not explain', 'Answer: A'].join('\n'),
    );
    expect(question.type).toBe('assertion_reason');
  });

  it('does not guess matrix_match from a plain text layer', () => {
    const question = extractQuestion('10. Match column I with column II and prove the correspondence.');
    expect(question.type).not.toBe('matrix_match');
  });

  it('reports a gap instead of inventing a correct answer', () => {
    const question = extractQuestion(['2. Which is the SI unit of force?', '(A) newton', '(B) joule'].join('\n'));
    expect(question.gaps).toContain('no answer line identified the correct option');
    expect(question.options.some((o) => o.isCorrect)).toBe(false);
    expect(question.confidence).toBeLessThan(0.5);
  });

  it('reports the Phase 3 validator’s own errors rather than a second opinion', () => {
    const question = extractQuestion('11. Prove that the series converges.');
    expect(question.type).toBe('long_form');
    expect(question.shapeValid).toBe(true);
  });
});

describe('P. option text is read, including a label that continues onto the next line', () => {
  it('joins a wrapped option onto the option above it', () => {
    const question = extractQuestion(
      ['3. Which statement is correct?', '(A) the first option whose text', 'continues on a second line', '(B) the second option', 'Answer: A'].join('\n'),
    );
    expect(question.options).toHaveLength(2);
    expect(question.options[0]!.text).toBe('the first option whose text continues on a second line');
  });

  it('ignores a repeated label rather than creating a fifth option', () => {
    const question = extractQuestion(['5. Pick one.', '(A) first', '(B) second', '(A) a stray repeat', 'Answer: B'].join('\n'));
    expect(question.options.map((o) => o.key)).toEqual(['A', 'B']);
  });

  it('finds option lines in a block', () => {
    expect(optionLines('stem here\n(A) one\n(B) two\ntrailing prose')).toEqual(['(A) one', '(B) two']);
  });
});

describe('T. difficulty comes from the source or not at all', () => {
  it.each([
    ['Difficulty: easy', 'easy', 1],
    ['Difficulty: moderate', 'moderate', 3],
    ['Level: hard', 'hard', 4],
    ['Difficulty: L5', 'L5', 5],
    ['difficulty = olympiad', 'olympiad', 5],
  ])('reads %s as %s → L%s', (line, source, label) => {
    expect(readSourceDifficulty(`1. A question.\n${line}`)).toBe(source);
    expect(sourceDifficultyToLabel(source)).toBe(label);
  });

  it('returns null rather than inventing a level when the source says nothing', () => {
    const question = extractQuestion('1. A question with no stated difficulty at all. Answer: 4');
    expect(question.sourceDifficulty).toBeNull();
    expect(question.difficultyLabel).toBeNull();
  });

  it('never returns a label outside L1-L5', () => {
    for (const word of ['easy', 'moderate', 'hard', 'challenging', 'L1', 'L5', 'nonsense', '']) {
      const label = sourceDifficultyToLabel(word);
      if (label !== null) expect(label).toBeGreaterThanOrEqual(1);
      if (label !== null) expect(label).toBeLessThanOrEqual(5);
    }
  });

  it('leaves the expected time for a reviewer: nothing in a printed question states it', () => {
    expect(extractQuestion('1. A question. Answer: 2').expectedTimeSeconds).toBeNull();
  });
});

describe('R/S. a solution is matched on evidence, and a contradiction is never silent', () => {
  const question = {
    blockId: 'q1',
    sourceNumber: '7',
    sourcePage: 1,
    sortOrder: 3,
    stem: 'A 2 kg block is pushed with a net force of 10 N. Find its acceleration.',
    correctOptionKeys: ['B'],
    correctNumeric: null,
  };

  it('R. matches on printed numbering even across a fifty-page gap', () => {
    const [match] = matchSolutions(
      [{ blockId: 's1', sourceNumber: '7', sourcePage: 60, sortOrder: 400, text: 'Solution 7. a = F/m = 5 m/s^2. Ans: B' }],
      [question],
    );
    expect(match!.questionBlockId).toBe('q1');
    expect(match!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(match!.reason).toContain('source numbers agree');
    expect(match!.answerConflict).toBe(false);
  });

  it('R. falls back to proximity when nothing is numbered', () => {
    const [match] = matchSolutions(
      [{ blockId: 's1', sourceNumber: null, sourcePage: 1, sortOrder: 4, text: 'Using F = ma the acceleration of the block is 5 m/s^2.' }],
      [{ ...question, sourceNumber: null }],
    );
    expect(match!.questionBlockId).toBe('q1');
    expect(match!.confidence).toBeGreaterThan(0);
    expect(match!.reason).toMatch(/follows the question/);
  });

  it('S. flags a solution whose stated answer contradicts the answer key', () => {
    const [match] = matchSolutions(
      [{ blockId: 's1', sourceNumber: '7', sourcePage: 1, sortOrder: 4, text: 'Solution 7. The answer is D.' }],
      [question],
    );
    expect(match!.answerConflict).toBe(true);
    expect(match!.reason).toMatch(/states option D, but this question marks B correct/);
  });

  it('matches nothing, with a reason, when there is no question to match', () => {
    const [match] = matchSolutions([{ blockId: 's1', sourceNumber: '7', sourcePage: 1, sortOrder: 1, text: 'Solution 7. Anything.' }], []);
    expect(match!.questionBlockId).toBeNull();
    expect(match!.confidence).toBe(0);
    expect(match!.reason).toMatch(/no question/);
  });

  it('offers the runners-up so a reviewer does not have to search', () => {
    const [match] = matchSolutions(
      [{ blockId: 's1', sourceNumber: null, sourcePage: 1, sortOrder: 5, text: 'The acceleration of the block under the net force is 5.' }],
      [
        { ...question, sourceNumber: null },
        { ...question, blockId: 'q2', sourceNumber: null, sortOrder: 4, stem: 'A block is pushed by a force; find the acceleration.' },
      ],
    );
    expect(match!.questionBlockId).not.toBeNull();
    expect(match!.alternatives.length).toBeGreaterThan(0);
  });
});
