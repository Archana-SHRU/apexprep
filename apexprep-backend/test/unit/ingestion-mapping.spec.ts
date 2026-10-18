import { mapToSubtopic, terms, type SyllabusCandidate } from '../../src/ingestion/mapping';
import { parseIngestionParams } from '../../src/ingestion/ingestion-params';
import { checkBlockGates, checkQuestionGates, referencesDiagram } from '../../src/ingestion/quality-gates';
import { decideAutoApproval, isSampled } from '../../src/ingestion/auto-approval';
import { isOlympiadTrack, matchesSlugPattern } from '../../src/common/learning/track-identity';
import { ingestionParams, SEED_ENGINE_PARAMS } from '../fixtures/engine-params';

/**
 * Scenarios N, O, T, AD, AH and AI (section 20): mapping to the syllabus, the gates that stop
 * publication, and the rules that decide whether a person has to look at something.
 *
 * Every threshold comes from the parameters passed in, never from a literal in the module — the
 * tests override them explicitly, which is also how they prove the modules read configuration
 * rather than carrying their own numbers.
 */

const PARAMS = ingestionParams();

function candidate(overrides: Partial<SyllabusCandidate> & { subtopicId: string }): SyllabusCandidate {
  return {
    subtopicName: 'Subtopic',
    topicName: 'Topic',
    chapterName: 'Chapter',
    subjectName: 'Subject',
    trackSlug: 'jee-main',
    matchesUploadHint: true,
    ...overrides,
  };
}

const NEWTON = candidate({
  subtopicId: 'st-newton',
  subtopicName: "Newton's Second Law",
  topicName: 'Laws of Motion',
  chapterName: 'Mechanics',
  subjectName: 'Physics',
});
const OPTICS = candidate({
  subtopicId: 'st-lenses',
  subtopicName: 'Thin Lens Formula',
  topicName: 'Refraction',
  chapterName: 'Optics',
  subjectName: 'Physics',
});

describe('N. a block is mapped to an existing sub-topic, with a confidence and a reason', () => {
  it('picks the sub-topic whose own name the block matches', () => {
    const result = mapToSubtopic({
      text: 'Newton established that acceleration is proportional to the net force and inversely proportional to mass.',
      title: "Newton's Second Law",
      candidates: [NEWTON, OPTICS],
    });
    expect(result.subtopicId).toBe('st-newton');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.reason).toContain("Newton's Second Law");
    expect(result.proposedSubtopicName).toBeNull();
  });

  it('weighs a sub-topic name above a chapter name, because a chapter distinguishes nothing', () => {
    const chapterOnly = candidate({ subtopicId: 'st-other', subtopicName: 'Circular Motion', topicName: 'Kinematics', chapterName: 'Mechanics' });
    const result = mapToSubtopic({ text: 'A discussion of mechanics and of the second law of Newton.', candidates: [NEWTON, chapterOnly] });
    expect(result.subtopicId).toBe('st-newton');
  });

  it('scores low when two sub-topics fit equally well, which is when a person should choose', () => {
    const a = candidate({ subtopicId: 'a', subtopicName: 'Energy Conservation' });
    const b = candidate({ subtopicId: 'b', subtopicName: 'Energy Conservation' });
    const result = mapToSubtopic({ text: 'A passage about energy conservation in closed systems.', candidates: [a, b] });
    expect(result.subtopicId).not.toBeNull();
    expect(result.confidence).toBeLessThan(PARAMS.ingestion.confidence.mapping_min);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it('discounts a match outside the track and subject the uploader named, and says so', () => {
    const passage = "Newton's second law relates the net force to mass and acceleration.";
    const outside = { ...NEWTON, matchesUploadHint: false };
    const inside = mapToSubtopic({ text: passage, candidates: [NEWTON] });
    const result = mapToSubtopic({ text: passage, candidates: [outside] });
    expect(result.confidence).toBeLessThan(inside.confidence);
    expect(result.reason).toContain('outside the track and subject');
  });

  it('offers the runners-up so a reviewer can pick one without searching the syllabus', () => {
    const result = mapToSubtopic({
      text: 'The second law of Newton and the thin lens formula both appear in this mixed passage about force and lenses.',
      candidates: [NEWTON, OPTICS],
    });
    // Both sub-topic names are fully matched, so whichever wins, the other must be offered.
    expect([result.subtopicId, ...result.alternatives.map((a) => a.subtopicId)].sort()).toEqual(['st-lenses', 'st-newton']);
    expect(result.confidence).toBeLessThan(PARAMS.ingestion.confidence.mapping_min);
  });

  it('drops stopwords and short tokens when comparing', () => {
    expect([...terms('The energy of a system is in the field')]).toEqual(['energy', 'system', 'field']);
  });
});

describe('O. when nothing fits, a name is proposed and no syllabus node is created', () => {
  it('returns no sub-topic and a proposed name when no candidate shares a term', () => {
    const result = mapToSubtopic({ text: 'Stellar parallax and the distance ladder.', title: 'Stellar Parallax', candidates: [NEWTON, OPTICS] });
    expect(result.subtopicId).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.proposedSubtopicName).toBe('Stellar Parallax');
    expect(result.reason).toContain('no existing sub-topic');
  });

  it('says so plainly when the syllabus has no candidates at all', () => {
    const result = mapToSubtopic({ text: 'Anything at all.', candidates: [] });
    expect(result.subtopicId).toBeNull();
    expect(result.reason).toContain('no published sub-topic');
  });

  it('proposes the block’s opening words when it has no heading', () => {
    const result = mapToSubtopic({ text: 'Stellar parallax gauges remoteness by apparent shift across six months.', candidates: [NEWTON] });
    expect(result.subtopicId).toBeNull();
    expect(result.proposedSubtopicName).toBe('Stellar parallax gauges remoteness by apparent');
  });

  it('keeps a match on one incidental word below the review floor rather than trusting it', () => {
    // "motion" appears in the topic name, and nothing else does: one word is not a mapping.
    const result = mapToSubtopic({ text: 'Stellar parallax measures distance by apparent motion across six months.', candidates: [NEWTON] });
    expect(result.subtopicId).toBe('st-newton');
    expect(result.confidence).toBeLessThan(PARAMS.ingestion.confidence.mapping_min);
  });
});

describe('AD. the quality gates block publication and report every failure at once', () => {
  const publishableQuestion = {
    tenantMatches: true,
    stem: 'A 2 kg block is pushed with a net force of 10 N. Find its acceleration.',
    type: 'single_correct' as const,
    options: [
      { key: 'A', text: '2', isCorrect: false },
      { key: 'B', text: '5', isCorrect: true },
    ],
    numericAnswer: null,
    matrixAnswer: null,
    subtopicId: 'st-newton',
    difficultyLabel: 3,
    expectedTimeSeconds: 120,
    referencesDiagram: false,
    hasDiagramAsset: false,
    fromOcr: false,
    reviewed: true,
    lowestConfidence: 0.95,
    solutionPending: false,
    openCriticalTasks: 0,
  };

  it('passes a complete, reviewed question', () => {
    expect(checkQuestionGates(publishableQuestion, PARAMS)).toEqual({ ok: true, failures: [] });
  });

  it('reports every problem in one pass rather than one per attempt', () => {
    const result = checkQuestionGates(
      { ...publishableQuestion, stem: 'short', subtopicId: null, difficultyLabel: null, expectedTimeSeconds: null, options: [] },
      PARAMS,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate).sort()).toEqual(
      expect.arrayContaining(['difficulty', 'expected_time', 'options', 'stem', 'subtopic']),
    );
  });

  it('refuses to invent how long a question should take', () => {
    // `expected_time_seconds` feeds the probable-guess and promotion-speed rules, so a guessed
    // value would change how the engine judges every student who answers it.
    const result = checkQuestionGates({ ...publishableQuestion, expectedTimeSeconds: null }, PARAMS);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain('expected_time');
    expect(checkQuestionGates({ ...publishableQuestion, expectedTimeSeconds: 2 }, PARAMS).ok).toBe(false);
    expect(checkQuestionGates({ ...publishableQuestion, expectedTimeSeconds: 120 }, PARAMS).ok).toBe(true);
  });

  it('blocks OCR content that no person has looked at', () => {
    const result = checkQuestionGates({ ...publishableQuestion, fromOcr: true, reviewed: false }, PARAMS);
    expect(result.failures.map((f) => f.gate)).toContain('ocr_reviewed');
  });

  it('blocks low-confidence content that no person has looked at, using the configured floor', () => {
    const strict = ingestionParams({ ingestion: { confidence: { question_min: 0.99 } } });
    const result = checkQuestionGates({ ...publishableQuestion, reviewed: false, lowestConfidence: 0.95 }, strict);
    expect(result.failures.map((f) => f.gate)).toContain('low_confidence_reviewed');
    expect(result.failures.find((f) => f.gate === 'low_confidence_reviewed')!.detail).toContain('0.99');
  });

  it('blocks a question that refers to a figure it does not have', () => {
    const result = checkQuestionGates({ ...publishableQuestion, referencesDiagram: true }, PARAMS);
    expect(result.failures.map((f) => f.gate)).toContain('diagram_asset');
  });

  it('blocks a question whose matched solution is not confirmed', () => {
    const result = checkQuestionGates({ ...publishableQuestion, solutionPending: true }, PARAMS);
    expect(result.failures.map((f) => f.gate)).toContain('solution_linkage');
  });

  it('blocks a question with an open review task against it', () => {
    const result = checkQuestionGates({ ...publishableQuestion, openCriticalTasks: 2 }, PARAMS);
    expect(result.failures.find((f) => f.gate === 'open_review_tasks')!.detail).toContain('2');
  });

  it('refuses to publish an ambiguous block as theory', () => {
    const result = checkBlockGates(
      {
        tenantMatches: true,
        kind: 'ambiguous',
        text: 'Some text that is long enough to publish on its own.',
        subtopicId: 'st-newton',
        fromOcr: false,
        reviewed: true,
        lowestConfidence: 0.9,
        openCriticalTasks: 0,
      },
      PARAMS,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain('block_kind');
  });

  it('passes a reviewed, mapped theory block', () => {
    expect(
      checkBlockGates(
        {
          tenantMatches: true,
          kind: 'theory',
          text: 'Acceleration is proportional to the net force acting on a body.',
          subtopicId: 'st-newton',
          fromOcr: false,
          reviewed: true,
          lowestConfidence: 0.9,
          openCriticalTasks: 0,
        },
        PARAMS,
      ),
    ).toEqual({ ok: true, failures: [] });
  });

  it('notices when a question refers to a figure', () => {
    expect(referencesDiagram('As shown in the figure, find the current.')).toBe(true);
    expect(referencesDiagram('State the second law of motion.')).toBe(false);
  });

  it('does not mistake an ordinary use of "graph", "circuit" or "diagram" for a missing figure', () => {
    // These are complete questions. Calling them incomplete sent ordinary content to a dead end that nothing could clear.
    for (const text of [
      'Find the current in a series circuit of two resistors.',
      'Plot the graph of y = x^2 for x from -3 to 3 and state its vertex.',
      'An RC circuit has resistance R and capacitance C; find its time constant.',
      'Draw a free-body diagram and write the equations of motion.',
      'Which graph theory term describes a path that visits every vertex once?',
    ]) {
      expect({ text, found: referencesDiagram(text) }).toEqual({ text, found: false });
    }
  });

  it('recognises the phrasings that point at a picture', () => {
    for (const text of [
      'In the figure shown below, find the tension.',
      'Refer to Fig. 2 and calculate the force.',
      'Consider the circuit diagram given below.',
      'The graph shown above gives the velocity of a car.',
      'As shown in Figure 3.1, the block slides down.',
      'Using the given figure, find x.',
      'The following diagram shows two pulleys.',
    ]) {
      expect({ text, found: referencesDiagram(text) }).toEqual({ text, found: true });
    }
  });

  it('lets a question that refers to a figure publish once a person has said it may', () => {
    const blocked = checkQuestionGates({ ...publishableQuestion, referencesDiagram: true }, PARAMS);
    expect(blocked.failures.map((f) => f.gate)).toContain('diagram_asset');
    expect(checkQuestionGates({ ...publishableQuestion, referencesDiagram: true, diagramAcknowledged: true }, PARAMS).ok).toBe(true);
    // Having the figure is the better answer, and needs no acknowledgement.
    expect(checkQuestionGates({ ...publishableQuestion, referencesDiagram: true, hasDiagramAsset: true }, PARAMS).ok).toBe(true);
  });

  it('refuses an answer a model proposed that the document does not state, until a person has verified it', () => {
    const result = checkQuestionGates({ ...publishableQuestion, answerUnverified: true }, PARAMS);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain('answer_verified');
    // Being reviewed does not clear it: looking at a block is not the same as checking its answer key.
    expect(checkQuestionGates({ ...publishableQuestion, answerUnverified: true, reviewed: true }, PARAMS).ok).toBe(false);
  });
});

describe('AH/AI. auto-approval: only high-confidence content, and never without the audit sample', () => {
  const eligible = {
    entityId: 'block-1',
    confidences: [0.95, 0.95],
    fromOcr: false,
    difficultyLabel: 3,
    track: { slug: 'jee-main', kind: null },
    gatesPass: true,
    openCriticalTasks: 0,
  };

  it('approves content whose every confidence clears the configured floor', () => {
    const decision = decideAutoApproval(eligible, PARAMS);
    expect(decision.autoApprove).toBe(true);
    expect(decision.reason).toContain(String(PARAMS.ingestion.auto_approval.min_confidence));
  });

  it('refuses when any single confidence is below the floor', () => {
    const decision = decideAutoApproval({ ...eligible, confidences: [0.95, 0.4] }, PARAMS);
    expect(decision.autoApprove).toBe(false);
    expect(decision.lowestConfidence).toBe(0.4);
  });

  it('always requires a person for OCR content', () => {
    const decision = decideAutoApproval({ ...eligible, fromOcr: true }, PARAMS);
    expect(decision.autoApprove).toBe(false);
    expect(decision.reason).toMatch(/OCR/);
  });

  it('always requires a person for Olympiad L5 content, however confident', () => {
    const decision = decideAutoApproval({ ...eligible, difficultyLabel: 5, track: { slug: 'physics-olympiad', kind: null }, confidences: [1, 1] }, PARAMS);
    expect(decision.autoApprove).toBe(false);
    expect(decision.reason).toContain('L5');
  });

  it('does not hold back L5 content outside an Olympiad track', () => {
    expect(decideAutoApproval({ ...eligible, difficultyLabel: 5, track: { slug: 'jee-advanced', kind: 'competitive_exam' }, confidences: [1, 1] }, PARAMS).autoApprove).toBe(true);

    // A Class 5 track is a school track and L5 there is just the hardest question in Class 5.
    expect(
      decideAutoApproval(
        { ...eligible, difficultyLabel: 5, track: { slug: 'class-5-mathematics', kind: 'school' }, confidences: [1, 1] },
        PARAMS,
      ).autoApprove,
    ).toBe(true);
  });

  // Migration 0013 made tracks.kind the real check. Before it, renaming a track switched the rule
  // off silently; these two cases are what changed.
  it('holds L5 on an Olympiad track that is no longer named like one', () => {
    const renamed = decideAutoApproval(
      { ...eligible, difficultyLabel: 5, track: { slug: 'imo-selection-2027', kind: 'olympiad' }, confidences: [1, 1] },
      PARAMS,
    );
    expect(renamed.autoApprove).toBe(false);
    expect(renamed.reason).toContain('always needs a person');
  });

  it('still holds L5 on a track whose name says Olympiad but whose kind does not', () => {
    // The slug patterns survive as a fallback and resolve the contradiction toward the reviewer:
    // over-triggering costs an admin a click, under-triggering ships unreviewed L5 content.
    const contradictory = decideAutoApproval(
      { ...eligible, difficultyLabel: 5, track: { slug: 'class-5-olympiad-practice', kind: 'school' }, confidences: [1, 1] },
      PARAMS,
    );
    expect(contradictory.autoApprove).toBe(false);
  });

  it('refuses while a gate fails or a task is open, whatever the confidence', () => {
    expect(decideAutoApproval({ ...eligible, gatesPass: false }, PARAMS).autoApprove).toBe(false);
    expect(decideAutoApproval({ ...eligible, openCriticalTasks: 1 }, PARAMS).autoApprove).toBe(false);
  });

  it('can be switched off entirely for an organisation', () => {
    const off = ingestionParams({ ingestion: { auto_approval: { enabled: false } } });
    expect(decideAutoApproval(eligible, off).autoApprove).toBe(false);
  });

  it('samples close to the configured share of auto-approved content', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `block-${i}`);
    const sampled = ids.filter((id) => isSampled(id, 0.05)).length / ids.length;
    expect(sampled).toBeGreaterThan(0.035);
    expect(sampled).toBeLessThan(0.065);
  });

  it('samples the same item the same way every time, so a run is reproducible', () => {
    expect(isSampled('block-1', 0.5)).toBe(isSampled('block-1', 0.5));
    expect(isSampled('block-1', 0)).toBe(false);
    expect(isSampled('block-1', 1)).toBe(true);
  });

  it('identifies an Olympiad track by slug, case-insensitively', () => {
    expect(matchesSlugPattern('Physics-Olympiad', ['olympiad'])).toBe(true);
    expect(matchesSlugPattern('jee-main', ['olympiad'])).toBe(false);
    expect(matchesSlugPattern('anything', [])).toBe(false);
    // kind is the rule; the patterns are the fallback for tracks that predate it.
    expect(isOlympiadTrack({ slug: 'imo-selection', kind: 'olympiad' }, [])).toBe(true);
    expect(isOlympiadTrack({ slug: 'class-5-maths', kind: 'school' }, ['olympiad'])).toBe(false);
    expect(isOlympiadTrack({ slug: 'physics-olympiad', kind: null }, ['olympiad'])).toBe(true);
  });
});

describe('the ingestion parameters are read from configuration, with no defaults', () => {
  it('accepts the seeded configuration', () => {
    const parsed = parseIngestionParams(SEED_ENGINE_PARAMS);
    expect(parsed.ok).toBe(true);
  });

  it('names the missing key rather than substituting a value', () => {
    const withoutFloor = JSON.parse(JSON.stringify(SEED_ENGINE_PARAMS)) as Record<string, Record<string, Record<string, unknown>>>;
    delete withoutFloor.ingestion!.confidence!.classification_min;
    const parsed = parseIngestionParams(withoutFloor);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.field)).toContain('params.ingestion.confidence.classification_min');
  });

  it('ignores the adaptive engine’s own keys, so the two slices cannot invalidate each other', () => {
    const extra = { ...SEED_ENGINE_PARAMS, something_new_for_phase_8: { anything: true } };
    expect(parseIngestionParams(extra).ok).toBe(true);
  });

  it('refuses a confidence outside 0-1', () => {
    const broken = JSON.parse(JSON.stringify(SEED_ENGINE_PARAMS)) as Record<string, Record<string, Record<string, unknown>>>;
    broken.ingestion!.confidence!.mapping_min = 1.4;
    expect(parseIngestionParams(broken).ok).toBe(false);
  });
});
