import type { QuestionType } from '../database/schema';
import { OPTION_TYPES, validateQuestionShape } from '../questions/question-shape';
import type { IngestionParams } from './ingestion-params';

/**
 * What must be true before ingested content may be published.
 *
 * The requirements list the gates; this module is that list, executable. Every gate is checked —
 * not short-circuited at the first failure — so a reviewer is told everything that is wrong in one
 * pass instead of discovering the next problem after each fix.
 *
 * The rule the whole module exists for: **a failed gate blocks publication.** There is no
 * override flag, no force parameter and no "publish anyway" path. Content that cannot pass is
 * content a human has to finish.
 *
 * Pure: no database, no clock. The caller loads the facts and applies the verdict.
 */

export type GateName =
  | 'tenant_ownership'
  | 'stem'
  | 'correct_answer'
  | 'options'
  | 'subtopic'
  | 'difficulty'
  | 'expected_time'
  | 'diagram_asset'
  | 'answer_verified'
  | 'ocr_reviewed'
  | 'low_confidence_reviewed'
  | 'solution_linkage'
  | 'open_review_tasks'
  | 'block_kind';

export interface GateFailure {
  gate: GateName;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
}

/** The facts about one question a gate needs. */
export interface QuestionGateInput {
  tenantMatches: boolean;
  stem: string;
  type: QuestionType;
  options: { key: string; text: string; isCorrect: boolean }[];
  numericAnswer: { value: string; tolerance?: string; mode?: 'absolute' | 'relative' } | null;
  matrixAnswer: Record<string, string[]> | null;
  subtopicId: string | null;
  difficultyLabel: number | null;
  /** Seconds the question is expected to take. Null until someone states it. */
  expectedTimeSeconds: number | null;
  /** True when the stem or a solution refers to a figure. */
  referencesDiagram: boolean;
  /** Whether a diagram asset is actually attached. */
  hasDiagramAsset: boolean;
  /**
   * A reviewer has said, knowingly, that this question may publish without the figure its text refers to. The
   * figure cannot be extracted from every PDF, and a question that needs one must not be silently published
   * without it — nor be unpublishable for ever when a person has decided it reads well enough.
   */
  diagramAcknowledged?: boolean;
  /** A model proposed the answer key and the document does not state it. Only a person can clear that. */
  answerUnverified?: boolean;
  /** True when any of this question's source text came from OCR. */
  fromOcr: boolean;
  /** Whether a human has reviewed it. */
  reviewed: boolean;
  /** The lowest confidence recorded anywhere in this question's provenance. */
  lowestConfidence: number;
  /** A solution was matched to this question but the match is not yet confirmed. */
  solutionPending: boolean;
  /** How many open review tasks still name this question or its source block. */
  openCriticalTasks: number;
}

export function checkQuestionGates(input: QuestionGateInput, params: IngestionParams): GateResult {
  const failures: GateFailure[] = [];
  const fail = (gate: GateName, detail: string) => failures.push({ gate, detail });

  if (!input.tenantMatches) fail('tenant_ownership', 'the question and its source do not belong to the same organisation');
  // Read defensively: a gate that throws on malformed input is a gate that cannot block anything,
  // and blocking is the whole job. A missing stem fails the gate rather than the request.
  const stem = typeof input.stem === 'string' ? input.stem : '';
  if (stem.trim().length < 10) fail('stem', 'the stem is missing or too short to be a question');
  if (input.subtopicId === null) fail('subtopic', 'the question is not mapped to a sub-topic');
  if (input.difficultyLabel === null || input.difficultyLabel < 1 || input.difficultyLabel > 5) {
    fail('difficulty', 'the question has no difficulty label in L1-L5');
  }
  // Nothing in a printed question states how long it should take, and a made-up number is not
  // harmless here: the probable-guess rule and the promotion-speed rule both read
  // `questions.expected_time_seconds`, so inventing one would bend the adaptive engine's judgement
  // of every student who answers it. A reviewer states it, or the question does not publish.
  if (input.expectedTimeSeconds === null || input.expectedTimeSeconds < 5 || input.expectedTimeSeconds > 7200) {
    fail('expected_time', 'nobody has said how long this question should take (5-7200 seconds)');
  }

  // Shape — options and the correct answer — is judged by Phase 3's validator, so there is one
  // definition of a valid question in the codebase rather than a second one here.
  const options = Array.isArray(input.options) ? input.options : [];
  const shape = validateQuestionShape({
    type: input.type,
    options: options.length > 0 ? options : undefined,
    numericAnswer: input.numericAnswer ?? undefined,
    matrixAnswer: input.matrixAnswer ?? undefined,
  });
  if (!shape.ok) {
    for (const error of shape.errors) {
      const gate: GateName = error.field?.startsWith('options') ? 'options' : 'correct_answer';
      fail(gate, `${error.field ?? 'answer'}: ${error.message}`);
    }
  }
  if (OPTION_TYPES.includes(input.type) && options.length < 2) {
    fail('options', `${input.type} needs at least two options`);
  }

  if (input.referencesDiagram && !input.hasDiagramAsset && !input.diagramAcknowledged) {
    fail('diagram_asset', 'the question refers to a figure that was not extracted; attach it, or acknowledge that it publishes without it');
  }
  if (input.answerUnverified) {
    fail('answer_verified', 'a model proposed this answer and the document does not state it; a person has to verify it');
  }
  if (input.fromOcr && !input.reviewed) {
    fail('ocr_reviewed', 'the text came from OCR and has not been reviewed by a person');
  }
  if (input.lowestConfidence < params.ingestion.confidence.question_min && !input.reviewed) {
    fail(
      'low_confidence_reviewed',
      `the lowest confidence in this question's provenance is ${input.lowestConfidence}, below the ${params.ingestion.confidence.question_min} floor, and it has not been reviewed`,
    );
  }
  if (input.solutionPending) fail('solution_linkage', 'a solution was matched to this question but the match is not confirmed');
  if (input.openCriticalTasks > 0) {
    fail('open_review_tasks', `${input.openCriticalTasks} open review task(s) still name this question`);
  }

  return { ok: failures.length === 0, failures };
}

/** The facts about one theory block a gate needs. */
export interface BlockGateInput {
  tenantMatches: boolean;
  kind: 'theory' | 'question' | 'solution' | 'ambiguous';
  text: string;
  subtopicId: string | null;
  fromOcr: boolean;
  reviewed: boolean;
  lowestConfidence: number;
  openCriticalTasks: number;
}

export function checkBlockGates(input: BlockGateInput, params: IngestionParams): GateResult {
  const failures: GateFailure[] = [];
  const fail = (gate: GateName, detail: string) => failures.push({ gate, detail });

  if (!input.tenantMatches) fail('tenant_ownership', 'the block does not belong to this organisation');
  // The database enforces this too (content_blocks_ambiguous_unapproved); it is checked here so
  // the reviewer gets a sentence rather than a constraint violation.
  // One reason, not two: an ambiguous block and a solution block are both "not theory", and
  // telling a reviewer the same gate failed twice only obscures what to do about it.
  if (input.kind === 'ambiguous') fail('block_kind', 'an ambiguous block must be reclassified before it can be published');
  else if (input.kind !== 'theory') fail('block_kind', `a ${input.kind} block is not published as theory`);
  if ((input.text ?? '').trim().length < 20) fail('stem', 'the block has too little text to publish');
  if (input.subtopicId === null) fail('subtopic', 'the block is not mapped to a sub-topic');
  if (input.fromOcr && !input.reviewed) fail('ocr_reviewed', 'the text came from OCR and has not been reviewed by a person');
  if (input.lowestConfidence < params.ingestion.confidence.classification_min && !input.reviewed) {
    fail(
      'low_confidence_reviewed',
      `classification confidence ${input.lowestConfidence} is below the ${params.ingestion.confidence.classification_min} floor and it has not been reviewed`,
    );
  }
  if (input.openCriticalTasks > 0) fail('open_review_tasks', `${input.openCriticalTasks} open review task(s) still name this block`);

  return { ok: failures.length === 0, failures };
}

/**
 * Phrases that say "look at the picture": "as shown in the figure", "refer to Fig. 2", "the circuit shown below",
 * "in the diagram above", "Figure 3.1". A bare "graph", "circuit" or "diagram" is not one — "plot the graph of
 * y = x²" and "an RC circuit has resistance R" are complete questions, and calling them incomplete would send
 * ordinary content to a dead end that only an override can clear.
 */
const FIGURE_REFERENCES: readonly RegExp[] = [
  /\bfig(?:ure)?s?\.?\s*\d+(?:\.\d+)?\b/i,
  /\bshown\s+(?:in|on|below|above|alongside|here)\b/i,
  /\b(?:in|from|using|see|refer\s+to|referring\s+to|consider)\s+the\s+(?:given\s+|accompanying\s+|adjoining\s+)?(?:figure|fig\.?|diagram|circuit\s+diagram|graph|picture|sketch)\b/i,
  /\b(?:figure|diagram|graph|picture|sketch|circuit)\s+(?:given|shown|drawn|depicted)\s+(?:below|above|here|alongside)\b/i,
  /\b(?:given|following|adjoining)\s+(?:figure|diagram|circuit\s+diagram)\b/i,
];

/** Whether a stem or solution points at a figure it would need an asset for. */
export function referencesDiagram(text: string): boolean {
  return FIGURE_REFERENCES.some((pattern) => pattern.test(text));
}
