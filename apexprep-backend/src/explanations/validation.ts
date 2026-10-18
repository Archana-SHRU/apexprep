import type { AiExplanation } from '../ai/ai-provider';
import { gradeResponse, type AnswerKey, type StudentResponse } from '../practice/grading';

/**
 * The gate an explanation passes before any student sees it.
 *
 * The checks the requirements list, in the order they are cheapest to fail:
 *
 *   1. **tenant ownership** — the question belongs to the organisation asking.
 *   2. **question identity** — the explanation was generated for this question at this version.
 *   3. **completeness** — it actually explains something.
 *   4. **no unsupported claim presented as official notes** — a grounded explanation has to
 *      cite blocks that were really retrieved, and must not cite blocks that were not.
 *   5. **answer match** — the hard block. If the explanation argues for an answer the question
 *      says is wrong, it is never served, whatever its grounding.
 *
 * The answer-match check runs the model's `finalAnswer` through **the same grader that marks
 * students** (`src/practice/grading.ts`). That is deliberate: the authoritative answer comes
 * from the question row and is compared with exact decimal arithmetic, and there is one
 * implementation of "is this answer correct" in the codebase rather than two that can drift.
 *
 * Pure: no database, no configuration. `grounding` is judged by the caller against the
 * configured bands; this module decides only whether the explanation is *safe*.
 */

export type CheckName =
  | 'tenant_ownership'
  | 'question_identity'
  | 'completeness'
  | 'citation_integrity'
  | 'answer_match';

export interface CheckFailure {
  check: CheckName;
  detail: string;
}

export interface ValidationInput {
  explanation: AiExplanation;
  /** The question's authoritative answer key, straight from the question row. */
  answerKey: AnswerKey;
  /** Block ids actually put in front of the model. */
  retrievedBlockIds: readonly string[];
  /** True for a grounded attempt, false for the general-knowledge tier. */
  grounded: boolean;
  /** Both sides of the identity check. */
  expected: { tenantId: string; questionId: string; questionVersion: number };
  actual: { tenantId: string; questionId: string; questionVersion: number };
}

export interface ValidationResult {
  ok: boolean;
  failures: CheckFailure[];
  /** True when the failure is the answer mismatch: the one that must always block. */
  answerMismatch: boolean;
}

export function validateExplanation(input: ValidationInput): ValidationResult {
  const failures: CheckFailure[] = [];

  if (input.expected.tenantId !== input.actual.tenantId) {
    failures.push({ check: 'tenant_ownership', detail: 'the explanation does not belong to this organisation' });
  }
  if (input.expected.questionId !== input.actual.questionId) {
    failures.push({ check: 'question_identity', detail: 'the explanation was generated for a different question' });
  } else if (input.expected.questionVersion !== input.actual.questionVersion) {
    failures.push({
      check: 'question_identity',
      detail: `generated for question version ${input.actual.questionVersion}, but the question is now at version ${input.expected.questionVersion}`,
    });
  }

  failures.push(...completeness(input.explanation));
  failures.push(...citationIntegrity(input));

  const mismatch = answerMatch(input);
  if (mismatch) failures.push(mismatch);

  return { ok: failures.length === 0, failures, answerMismatch: mismatch !== null };
}

// ---------------------------------------------------------------- individual checks

function completeness(explanation: AiExplanation): CheckFailure[] {
  const failures: CheckFailure[] = [];
  if (explanation.summary.trim().length < 20) {
    failures.push({ check: 'completeness', detail: 'the summary is too short to be an explanation' });
  }
  const steps = explanation.steps.filter((s) => s.trim().length > 0);
  if (steps.length < 2) failures.push({ check: 'completeness', detail: 'fewer than two reasoning steps' });
  return failures;
}

/**
 * A grounded explanation may only cite notes that were actually retrieved. A model citing a
 * block it was never shown is claiming the notes support something they may not, which is
 * exactly the "unsupported claim presented as official notes" the requirements block.
 */
function citationIntegrity(input: ValidationInput): CheckFailure[] {
  if (!input.grounded) {
    return input.explanation.citedBlockIds.length > 0
      ? [{ check: 'citation_integrity', detail: 'a general-knowledge explanation cited course notes' }]
      : [];
  }
  const retrieved = new Set(input.retrievedBlockIds);
  const invented = input.explanation.citedBlockIds.filter((id) => !retrieved.has(id));
  return invented.length > 0
    ? [{ check: 'citation_integrity', detail: `cited ${invented.length} note(s) that were not retrieved` }]
    : [];
}

/**
 * The hard block. The explanation's own conclusion is graded against the question's answer
 * key; anything other than a fully correct answer fails.
 *
 * A `long_form` question has no automatically gradable key, so there is nothing to compare
 * and the check passes — such explanations are held by the approval rules instead.
 * A missing `finalAnswer` on a gradable question also fails: an explanation that will not
 * commit to an answer cannot be checked, and an unverifiable explanation is not served.
 */
function answerMatch(input: ValidationInput): CheckFailure | null {
  if (input.answerKey.type === 'long_form') return null;

  const finalAnswer = input.explanation.finalAnswer;
  if (finalAnswer === null) {
    return { check: 'answer_match', detail: 'the explanation states no final answer, so it cannot be checked against the question' };
  }

  const graded = gradeResponse(input.answerKey, finalAnswer as unknown as StudentResponse);
  if (!graded.ok) {
    return { check: 'answer_match', detail: `the explanation's final answer is not a valid answer to this question (${graded.message})` };
  }
  if (graded.outcome !== 'correct') {
    return { check: 'answer_match', detail: "the explanation argues for an answer the question marks wrong" };
  }
  return null;
}
