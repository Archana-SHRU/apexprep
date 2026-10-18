import type { ExtractedContentUnderstanding } from '../../src/ai/prompts';
import {
  applyAiUnderstanding,
  estimatedTimeSeconds,
  groundAnswer,
  isFaithfulRewrite,
  statedOptionKeys,
} from '../../src/ingestion/content-understanding';
import { applySolutionAnswer, extractQuestion, reassess, type ExtractedQuestion } from '../../src/ingestion/question-extraction';
import type { SegmentedBlock } from '../../src/ingestion/segmentation';

const block = (text: string, over: Partial<SegmentedBlock> = {}): SegmentedBlock => ({
  sourcePage: 1,
  sourceNumber: null,
  kind: 'question',
  format: 'paragraph',
  title: null,
  text,
  confidence: 0.7,
  reason: 'rule',
  contentHash: 'hash123',
  sortOrder: 1,
  ...over,
});

const question = (over: Partial<NonNullable<ExtractedContentUnderstanding['question']>> = {}, confidence = 0.96): ExtractedContentUnderstanding => ({
  classification: 'question',
  confidence,
  theory: null,
  question: {
    type: 'single_correct',
    stem: 'A particle moves along a circular path described by $x^2 + y^2 = r^2$. If $r = 5\\text{ m}$, what is the radius?',
    options: [
      { key: 'A', text: '$2.5\\text{ m}$', isCorrect: false },
      { key: 'B', text: '$5.0\\text{ m}$', isCorrect: true },
      { key: 'C', text: '$10.0\\text{ m}$', isCorrect: false },
      { key: 'D', text: '$25.0\\text{ m}$', isCorrect: false },
    ],
    numericAnswer: null,
    difficulty: 'MEDIUM',
    explanation: null,
    answerExplicitlyPresent: true,
    ...over,
  },
});

const SOURCE_WITH_ANSWER = 'A particle moves with equation $x^2 + y^2 = r^2$. Find the radius.\n(A) 2.5 m (B) 5.0 m (C) 10.0 m (D) 25.0 m\nAnswer: B';

describe('what a model may add to a block, and what it may not', () => {
  describe('the question', () => {
    it('preserves LaTeX in the stem and the options', () => {
      const result = applyAiUnderstanding(block(SOURCE_WITH_ANSWER), question(), null);
      expect(result.block.kind).toBe('question');
      expect(result.proposal?.stem).toContain('$x^2 + y^2 = r^2$');
      expect(result.proposal?.options.map((o) => o.text)).toContain('$5.0\\text{ m}$');
      expect(result.proposal?.options).toHaveLength(4);
    });

    it('believes an answer the document itself states', () => {
      const result = applyAiUnderstanding(block(SOURCE_WITH_ANSWER), question(), null);
      expect(result.proposal?.options.find((o) => o.key === 'B')?.isCorrect).toBe(true);
      expect(result.proposal?.answerSource).toBe('source');
      expect(result.proposal?.shapeValid).toBe(true);
      expect(result.proposal?.gaps).toEqual([]);
    });

    it('labels an answer the document does not state as unverified, rather than trusting the model', () => {
      const result = applyAiUnderstanding(block('A particle moves in a circle of radius 5 m. What is the radius?'), question(), null);
      expect(result.proposal?.options.find((o) => o.key === 'B')?.isCorrect).toBe(true);
      expect(result.proposal?.answerSource).toBe('ai_unverified');
      expect(result.proposal?.gaps.join(' ')).toMatch(/model.*document does not state/);
    });

    it('labels an answer that contradicts the one the document states as unverified', () => {
      const result = applyAiUnderstanding(block(SOURCE_WITH_ANSWER.replace('Answer: B', 'Answer: C')), question(), null);
      expect(result.proposal?.answerSource).toBe('ai_unverified');
    });

    it('does not turn a model\'s high confidence into the document\'s: the reported confidence is kept as it was', () => {
      const result = applyAiUnderstanding(block(SOURCE_WITH_ANSWER), question({}, 0.74), null);
      expect(result.proposal?.confidence).toBe(0.74);
      expect(result.block.confidence).toBe(0.74);
    });

    it('never fabricates an answer: when the model says the document states none, no option is marked', () => {
      const result = applyAiUnderstanding(
        block('What is the unit of electric flux in SI units?'),
        question({
          stem: 'What is the unit of electric flux in SI units?',
          options: [
            { key: 'A', text: 'V m', isCorrect: true },
            { key: 'B', text: 'N/C', isCorrect: true },
          ],
          answerExplicitlyPresent: false,
        }),
        null,
      );
      expect(result.proposal?.options.every((o) => !o.isCorrect)).toBe(true);
      expect(result.proposal?.answerSource).toBeNull();
      expect(result.proposal?.gaps).toContain('no answer was stated in the source text');
      expect(result.proposal?.shapeValid).toBe(false);
    });

    it('keeps the model\'s difficulty and time as suggestions, and leaves the fields that count empty', () => {
      const result = applyAiUnderstanding(block(SOURCE_WITH_ANSWER), question({ difficulty: 'HARD' }), null);
      expect(result.proposal?.difficultyLabel).toBeNull();
      expect(result.proposal?.expectedTimeSeconds).toBeNull();
      expect(result.proposal?.difficultySource).toBeNull();
      expect(result.proposal?.expectedTimeSource).toBeNull();
      expect(result.proposal?.suggested).toMatchObject({ by: 'ai', difficultyLabel: 4, expectedTimeSeconds: 180 });
    });

    it('keeps a difficulty the document printed, as the document\'s', () => {
      const printed = extractQuestion('1. Find the radius of the circle in this problem statement.\n(A) 1\n(B) 2\nAnswer: A\nDifficulty: L2');
      const result = applyAiUnderstanding(block(SOURCE_WITH_ANSWER), question(), printed);
      expect(result.proposal?.difficultyLabel).toBe(2);
      expect(result.proposal?.difficultySource).toBe('source');
    });

    it('checks a numeric answer against the document too', () => {
      const numeric = (stated: string) =>
        applyAiUnderstanding(
          block(`Find g in m/s^2.\nAnswer: ${stated}`),
          question({ type: 'numeric', stem: 'Find g in m/s^2.', options: [], numericAnswer: { value: '9.8', tolerance: '0.1', mode: 'absolute' } }),
          null,
        );
      expect(numeric('9.8').proposal?.answerSource).toBe('source');
      expect(numeric('10').proposal?.answerSource).toBe('ai_unverified');
    });
  });

  describe('rewritten text', () => {
    const theory = (normalizedText: string): ExtractedContentUnderstanding => ({
      classification: 'theory',
      confidence: 0.9,
      theory: { format: 'formula', title: "Gauss's Law", normalizedText },
      question: null,
    });

    it('accepts a faithful tidy-up and says it replaced the text', () => {
      const source = "Gauss's   law:\n  flux = Q / epsilon_0 for any closed surface";
      const result = applyAiUnderstanding(block(source, { kind: 'ambiguous' }), theory("Gauss's law: flux = Q / epsilon_0 for any closed surface"), null);
      expect(result.block.kind).toBe('theory');
      expect(result.block.format).toBe('formula');
      expect(result.block.title).toBe("Gauss's Law");
      expect(result.block.text).toBe("Gauss's law: flux = Q / epsilon_0 for any closed surface");
      expect(result.textDecision).toBe('rewritten');
    });

    it('refuses a rewrite that says more than the source, and keeps the extracted text', () => {
      const source = "Gauss's law: flux = Q / epsilon_0 for any closed surface";
      const inflated = `${source}. This also implies that the electric field inside a conductor is always zero, which Maxwell proved in 1861 using the displacement current.`;
      const result = applyAiUnderstanding(block(source, { kind: 'ambiguous' }), theory(inflated), null);
      expect(result.block.text).toBe(source);
      expect(result.textDecision).toBe('rewrite_refused');
    });

    it('classifies an ambiguous block the model recognises as a solution, so solution matching can take it from there', () => {
      const result = applyAiUnderstanding(block('Solution 4. Using F = ma we get a = 2 m/s^2.', { kind: 'ambiguous' }), { classification: 'solution', confidence: 0.8, theory: null, question: null }, null);
      expect(result.block.kind).toBe('solution');
    });

    it('does not reclassify a block the rules already placed as a question into a solution', () => {
      const result = applyAiUnderstanding(block('1. A question?', { kind: 'question' }), { classification: 'solution', confidence: 0.9, theory: null, question: null }, null);
      expect(result.block.kind).toBe('question');
    });
  });

  describe('statedOptionKeys', () => {
    it.each([
      ['Answer: B', ['B']],
      ['Ans. (C)', ['C']],
      ['Correct answer is D', ['D']],
      ['Answer: A and C', ['A', 'C']],
      ['Ans: (a), (d)', ['A', 'D']],
      ['Answer a question about it', []],
      ['The answer is a function of time', []],
      ['No answer line at all', []],
    ])('%j → %j', (text, keys) => {
      expect(statedOptionKeys(text)).toEqual(keys);
    });
  });

  describe('isFaithfulRewrite', () => {
    it('ignores whitespace, line breaks and formula delimiters', () => {
      expect(isFaithfulRewrite('v = u + at\nwhere v is velocity', '$v = u + at$ where v is velocity')).toBe(true);
    });
    it('rejects added sentences and an empty rewrite', () => {
      expect(isFaithfulRewrite('v = u + at', 'v = u + at, which Newton derived from the principle of relativity in his Principia')).toBe(false);
      expect(isFaithfulRewrite('v = u + at', '   ')).toBe(false);
    });
  });

  describe('groundAnswer', () => {
    const options = (correct: string[]) => ['A', 'B', 'C'].map((key) => ({ key, text: key, isCorrect: correct.includes(key) }));
    it('is null when nothing is marked', () => {
      expect(groundAnswer('Answer: A', { type: 'single_correct', options: options([]), numericAnswer: null })).toBeNull();
    });
    it('matches a multi-answer set exactly', () => {
      expect(groundAnswer('Answer: A and C', { type: 'multi_correct', options: options(['A', 'C']), numericAnswer: null })).toBe('source');
      expect(groundAnswer('Answer: A', { type: 'multi_correct', options: options(['A', 'C']), numericAnswer: null })).toBe('ai_unverified');
    });
  });

  describe('estimatedTimeSeconds', () => {
    it('grows with difficulty and is larger for multi-correct than single-correct', () => {
      expect(estimatedTimeSeconds('single_correct', 'HARD')).toBeGreaterThan(estimatedTimeSeconds('single_correct', 'EASY'));
      expect(estimatedTimeSeconds('multi_correct', 'MEDIUM')).toBeGreaterThan(estimatedTimeSeconds('single_correct', 'MEDIUM'));
    });
  });
});

describe('taking an answer from the matched solution', () => {
  const unanswered = (): ExtractedQuestion =>
    extractQuestion('3. Which of the following is a vector quantity here?\n(A) Mass\n(B) Velocity\n(C) Time\n(D) Energy');

  it('fills a question printed without its answer, from a confirmed match', () => {
    const q = unanswered();
    expect(q.gaps.join(' ')).toMatch(/no answer line/);
    const filled = applySolutionAnswer(q, { optionKey: 'B', numeric: null }, 0.9)!;
    expect(filled.options.find((o) => o.key === 'B')?.isCorrect).toBe(true);
    expect(filled.options.filter((o) => o.isCorrect)).toHaveLength(1);
    expect(filled.answerSource).toBe('solution');
    expect(filled.gaps).toEqual([]);
    expect(filled.shapeValid).toBe(true);
  });

  it('holds the question\'s confidence to the match\'s: the answer is only as good as the link that found it', () => {
    const filled = applySolutionAnswer(unanswered(), { optionKey: 'B', numeric: null }, 0.62)!;
    expect(filled.confidence).toBeLessThanOrEqual(0.62);
  });

  it('never overwrites an answer the question already has', () => {
    const answered = extractQuestion('3. Which is a vector quantity here?\n(A) Mass\n(B) Velocity\nAnswer: B');
    expect(applySolutionAnswer(answered, { optionKey: 'A', numeric: null }, 0.95)).toBeNull();
  });

  it('does nothing when the solution states an option the question does not have, or none', () => {
    expect(applySolutionAnswer(unanswered(), { optionKey: 'F', numeric: null }, 0.95)).toBeNull();
    expect(applySolutionAnswer(unanswered(), { optionKey: null, numeric: null }, 0.95)).toBeNull();
  });

  it('fills a numeric question from the stated value, exact when it is an integer', () => {
    const q: ExtractedQuestion = { ...extractQuestion('4. How many significant figures does the value 0.0420 have in this problem?'), type: 'integer', options: [], numericAnswer: null };
    const filled = applySolutionAnswer(q, { optionKey: null, numeric: '3' }, 0.9)!;
    expect(filled.numericAnswer).toEqual({ value: '3', tolerance: '0', mode: 'absolute' });
    expect(filled.answerSource).toBe('solution');
  });

  it('leaves a long-form question alone: a solution\'s last line cannot settle one', () => {
    const q: ExtractedQuestion = { ...unanswered(), type: 'long_form', options: [] };
    expect(applySolutionAnswer(q, { optionKey: null, numeric: '5' }, 0.9)).toBeNull();
  });
});

describe('reassess', () => {
  it('clears gaps that no longer apply and keeps ones that still do', () => {
    const q = extractQuestion('3. Which of the following is a vector quantity here?\n(A) Mass\n(B) Velocity\n(C) Time');
    expect(q.gaps.length).toBeGreaterThan(0);
    const fixed = reassess({ ...q, options: q.options.map((o) => ({ ...o, isCorrect: o.key === 'B' })), answerSource: 'reviewer' });
    expect(fixed.gaps).toEqual([]);
    expect(fixed.shapeValid).toBe(true);
    const stillBroken = reassess({ ...q, stem: 'Short', options: q.options.map((o) => ({ ...o, isCorrect: o.key === 'B' })) });
    expect(stillBroken.gaps).toContain('the stem is too short to be a question');
  });

  it('keeps asking for a person while an answer is only a model\'s', () => {
    const q = extractQuestion('3. Which of the following is a vector quantity here?\n(A) Mass\n(B) Velocity\nAnswer: B');
    expect(reassess({ ...q, answerSource: 'ai_unverified' }).gaps.join(' ')).toMatch(/verify/);
    expect(reassess({ ...q, answerSource: 'reviewer' }).gaps).toEqual([]);
  });
});
