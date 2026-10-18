import type { AiExplanation } from '../../src/ai/ai-provider';
import { validateExplanation, type ValidationInput } from '../../src/explanations/validation';
import type { AnswerKey } from '../../src/practice/grading';

describe('the gate an explanation passes before a student sees it', () => {
  const singleCorrect: AnswerKey = {
    type: 'single_correct',
    correctOptionKeys: ['B'],
    optionKeys: { single: ['A', 'B', 'C', 'D'], left: [], right: [] },
    correctNumeric: null,
    numericTolerance: null,
    toleranceMode: null,
    matrixAnswer: null,
  };

  const explanation = (patch: Partial<AiExplanation> = {}): AiExplanation => ({
    summary: 'Angular momentum about the contact point is conserved throughout the motion.',
    steps: ['Take torque about the contact point.', 'Solve the resulting equation for omega.'],
    keyConcept: null,
    commonMistake: null,
    finalAnswer: { optionKeys: ['B'] },
    citedBlockIds: [],
    ...patch,
  });

  const input = (patch: Partial<ValidationInput> = {}): ValidationInput => ({
    explanation: explanation(),
    answerKey: singleCorrect,
    retrievedBlockIds: [],
    grounded: false,
    expected: { tenantId: 't1', questionId: 'q1', questionVersion: 3 },
    actual: { tenantId: 't1', questionId: 'q1', questionVersion: 3 },
    ...patch,
  });

  const checks = (result: ReturnType<typeof validateExplanation>) => result.failures.map((f) => f.check);

  it('passes a complete explanation that argues for the right answer', () => {
    const result = validateExplanation(input());
    expect(result).toMatchObject({ ok: true, failures: [], answerMismatch: false });
  });

  describe('the answer-match hard block', () => {
    it('fails when the explanation argues for an answer the question marks wrong', () => {
      const result = validateExplanation(input({ explanation: explanation({ finalAnswer: { optionKeys: ['C'] } }) }));
      expect(result.ok).toBe(false);
      expect(result.answerMismatch).toBe(true);
      expect(result.failures).toEqual([{ check: 'answer_match', detail: 'the explanation argues for an answer the question marks wrong' }]);
    });

    it('fails when the explanation will not commit to an answer at all', () => {
      const result = validateExplanation(input({ explanation: explanation({ finalAnswer: null }) }));
      expect(result.answerMismatch).toBe(true);
      expect(result.failures[0]!.detail).toMatch(/states no final answer/);
    });

    it('fails when the stated answer is not even a valid answer to the question', () => {
      const result = validateExplanation(input({ explanation: explanation({ finalAnswer: { optionKeys: ['Z'] } }) }));
      expect(result.answerMismatch).toBe(true);
      expect(result.failures[0]!.detail).toMatch(/not a valid answer/);
    });

    it('uses the same grader students are marked by, tolerance and all', () => {
      const numeric: AnswerKey = { ...singleCorrect, type: 'numeric', correctOptionKeys: [], correctNumeric: '4.20', numericTolerance: '0.05', toleranceMode: 'absolute' };
      // 4.24 is inside the tolerance; 4.30 is not. Exact decimal arithmetic, not floats.
      expect(validateExplanation(input({ answerKey: numeric, explanation: explanation({ finalAnswer: { value: '4.24' } }) })).ok).toBe(true);
      expect(validateExplanation(input({ answerKey: numeric, explanation: explanation({ finalAnswer: { value: '4.30' } }) })).answerMismatch).toBe(true);
    });

    it('accepts a multi-correct answer only when the whole set matches', () => {
      const multi: AnswerKey = { ...singleCorrect, type: 'multi_correct', correctOptionKeys: ['A', 'C'] };
      expect(validateExplanation(input({ answerKey: multi, explanation: explanation({ finalAnswer: { optionKeys: ['C', 'A'] } }) })).ok).toBe(true);
      expect(validateExplanation(input({ answerKey: multi, explanation: explanation({ finalAnswer: { optionKeys: ['A'] } }) })).answerMismatch).toBe(true);
    });

    it('has nothing to compare for a long-form question, so the check passes', () => {
      const longForm: AnswerKey = { ...singleCorrect, type: 'long_form', correctOptionKeys: [] };
      const result = validateExplanation(input({ answerKey: longForm, explanation: explanation({ finalAnswer: null }) }));
      expect(result).toMatchObject({ ok: true, answerMismatch: false });
    });
  });

  describe('identity and ownership', () => {
    it('fails when the explanation belongs to another organisation', () => {
      const result = validateExplanation(input({ actual: { tenantId: 't2', questionId: 'q1', questionVersion: 3 } }));
      expect(checks(result)).toContain('tenant_ownership');
    });

    it('fails when it was generated for a different question', () => {
      const result = validateExplanation(input({ actual: { tenantId: 't1', questionId: 'q2', questionVersion: 3 } }));
      expect(checks(result)).toContain('question_identity');
    });

    it('fails when the question has moved on to a new version', () => {
      const result = validateExplanation(input({ actual: { tenantId: 't1', questionId: 'q1', questionVersion: 2 } }));
      expect(result.failures.find((f) => f.check === 'question_identity')!.detail).toMatch(/version 2.*now at version 3/);
    });
  });

  describe('completeness', () => {
    it('fails a summary too short to be an explanation', () => {
      expect(checks(validateExplanation(input({ explanation: explanation({ summary: 'Because.' }) })))).toContain('completeness');
    });

    it('fails fewer than two reasoning steps', () => {
      expect(checks(validateExplanation(input({ explanation: explanation({ steps: ['Only one step.'] }) })))).toContain('completeness');
      expect(checks(validateExplanation(input({ explanation: explanation({ steps: ['A step.', '   '] }) })))).toContain('completeness');
    });
  });

  describe('citation integrity', () => {
    it('fails a grounded explanation that cites notes it was never shown', () => {
      const result = validateExplanation(
        input({ grounded: true, retrievedBlockIds: ['b1'], explanation: explanation({ citedBlockIds: ['b1', 'b9'] }) }),
      );
      expect(result.failures.find((f) => f.check === 'citation_integrity')!.detail).toMatch(/1 note/);
    });

    it('passes a grounded explanation citing only what was retrieved', () => {
      expect(validateExplanation(input({ grounded: true, retrievedBlockIds: ['b1', 'b2'], explanation: explanation({ citedBlockIds: ['b1'] }) })).ok).toBe(true);
    });

    it('fails a general-knowledge explanation that claims to cite the course notes', () => {
      const result = validateExplanation(input({ grounded: false, explanation: explanation({ citedBlockIds: ['b1'] }) }));
      expect(result.failures.find((f) => f.check === 'citation_integrity')!.detail).toMatch(/general-knowledge explanation cited course notes/);
    });
  });

  it('reports every failure at once, so one review covers them all', () => {
    const result = validateExplanation(
      input({
        grounded: true,
        retrievedBlockIds: [],
        actual: { tenantId: 't2', questionId: 'q1', questionVersion: 3 },
        explanation: explanation({ summary: 'No.', steps: [], citedBlockIds: ['b1'], finalAnswer: { optionKeys: ['C'] } }),
      }),
    );
    expect(new Set(checks(result))).toEqual(new Set(['tenant_ownership', 'completeness', 'citation_integrity', 'answer_match']));
    expect(result.answerMismatch).toBe(true);
  });
});
