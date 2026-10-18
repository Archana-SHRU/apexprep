import type { AiExplanation } from '../../src/ai/ai-provider';
import { normalizeMath } from '../../src/common/learning/math-text';
import { assessGrounding, contentTerms } from '../../src/explanations/grounding';
import type { ScoredCandidate } from '../../src/explanations/retrieval';
import { findAnswerLeaks } from '../../src/learning-ai/leakage';
import { formulaAppearsIn } from '../../src/learning-ai/notes/notes.validation';

/**
 * Grounding must judge what an explanation says, not how it typesets it. The live failure this covers: a
 * correct, notes-based explanation written in LaTeX scored 0.219 because `\frac`, `\omega` and `R^{2}` did not
 * match notes written "ω" and "R²".
 */

const NOTES =
  'For rolling without slipping, the contact point is instantaneously at rest, so v = ωR. ' +
  'The angular momentum about the centre of mass is L = Iω. ' +
  'Moments of inertia: thin ring MR²; uniform disc ½MR²; thin spherical shell (2/3)MR²; uniform solid sphere (2/5)MR².';

const chunk = (text: string): ScoredCandidate => ({
  chunk: { blockId: '11111111-1111-4111-8111-111111111111', chunkIndex: 0, title: 'Rolling', text, tokenEstimate: 80, blockIds: ['11111111-1111-4111-8111-111111111111'] },
  scope: 'subtopic',
  vectorScore: 0.7,
  keywordScore: 0.5,
  score: 0.6,
  semantic: true,
});

const explanation = (summary: string, steps: string[]): AiExplanation => ({
  summary,
  steps,
  keyConcept: null,
  commonMistake: null,
  finalAnswer: null,
  citedBlockIds: [],
});

const score = (e: AiExplanation) => assessGrounding({ explanation: e, chunks: [chunk(NOTES)], questionText: 'A thin spherical shell rolls without slipping. Find its angular momentum about its centre.' }).score;

describe('mathematical notation is normalised before grounding', () => {
  it('reads LaTeX, Unicode and plain spellings of the same notation identically', () => {
    expect(normalizeMath('$v = \\omega R$')).toBe('v = omega R');
    expect(normalizeMath('v = ωR')).toBe('v = omega R');
    expect(normalizeMath('\\frac{2}{3}MR^{2}')).toBe('2 / 3 MR 2');
    expect(normalizeMath('(2/3)MR²')).toBe('(2/3)MR 2');
    expect(normalizeMath('\\sqrt{\\frac{10gh}{7}}')).toBe('sqrt 10gh / 7');
    expect(normalizeMath('\\text{net force} = m \\cdot a')).toBe('net force = m a');
    expect([...contentTerms('$L_{cm} = I_{cm}\\omega$')]).toEqual([...contentTerms('L_cm = I_cm ω')]);
  });

  it('scores a LaTeX explanation the same as its plain-text twin', () => {
    const latex = explanation('Use $L = I\\omega$ with the shell inertia $\\frac{2}{3}MR^{2}$ and $\\omega = \\frac{v}{R}$.', [
      'For rolling without slipping, $v = \\omega R$, so $\\omega = v/R$.',
      'The thin spherical shell has moment of inertia $I = \\frac{2}{3}MR^{2}$, so $L = I\\omega = \\frac{2}{3}MRv$.',
    ]);
    const plain = explanation('Use L = Iω with the shell inertia (2/3)MR² and ω = v/R.', [
      'For rolling without slipping, v = ωR, so ω = v/R.',
      'The thin spherical shell has moment of inertia I = (2/3)MR², so L = Iω = (2/3)MRv.',
    ]);
    expect(score(latex)).toBe(score(plain));
    // Supported by the notes, so it is served as notes-based (the mostly-notes band starts at 0.5). The terms it
    // still loses are word-level, not notation: "moment" vs the notes' "Moments", and the product "MRv".
    expect(score(latex)).toBeGreaterThanOrEqual(0.5);
  });

  it('does not mark a genuinely unsupported formula as grounded', () => {
    const unsupported = explanation('By relativistic mass–energy equivalence, $E = mc^{2}$ gives the photon energy $E = h\\nu$.', [
      'Planck relation: $E = h\\nu$ with frequency $\\nu$.',
      'Einstein: $E = mc^2$ relates rest mass to energy.',
    ]);
    expect(score(unsupported)).toBeLessThan(0.5);
  });

  it('scores mixed prose and formulas by what they claim: supported parts count, unsupported parts do not', () => {
    const mixed = explanation('Rolling without slipping means $v = \\omega R$; also, the Coriolis acceleration $2\\Omega \\times v$ deflects it eastward.', [
      'The thin spherical shell has moment of inertia $\\frac{2}{3}MR^2$.',
      'Coriolis deflection depends on latitude and rotation of Earth.',
    ]);
    const s = score(mixed);
    const unsupportedOnly = score(explanation('By relativistic mass–energy equivalence, $E = mc^{2}$.', ['Planck relation: $E = h\\nu$.', 'Einstein relates rest mass to energy.']));
    // The supported half earns credit; the Coriolis half keeps it below the band a grounded explanation needs.
    expect(s).toBeGreaterThan(unsupportedOnly);
    expect(s).toBeLessThan(0.5);
  });

  it('finds a LaTeX formula in plain-text notes, and refuses one the notes do not state', () => {
    expect(formulaAppearsIn('$v = \\omega R$', NOTES)).toBe(true);
    expect(formulaAppearsIn('L = I\\omega', NOTES)).toBe(true);
    expect(formulaAppearsIn('E = mc^{2}', NOTES)).toBe(false);
    expect(formulaAppearsIn('\\tau = r \\times F \\sin\\theta', NOTES)).toBe(false);
  });
});

describe('answer leakage across notation', () => {
  const leakAnswer = {
    type: 'single_correct' as const,
    correctOptionKeys: ['C'],
    options: [
      { key: 'A', text: '$\\frac{2}{5}MRv$' },
      { key: 'B', text: '$\\frac{1}{2}MRv$' },
      { key: 'C', text: '$\\frac{2}{3}MRv$' },
      { key: 'D', text: '$MRv$' },
    ],
    correctNumeric: null,
    stem: 'A thin spherical shell of mass $M$ and radius $R$ rolls without slipping with speed $v$. What is its angular momentum about its centre?',
  };

  it('catches the correct option however it is typeset', () => {
    for (const reply of ['So the result is 2/3 MRv.', 'That gives $\\frac{2}{3} M R v$.', 'L works out to (2/3)MRv']) {
      expect([reply, findAnswerLeaks(reply, leakAnswer).length > 0]).toEqual([reply, true]);
    }
  });

  it('still lets a genuine hint through', () => {
    expect(findAnswerLeaks('Start from $L = I\\omega$ and the rolling condition $v = \\omega R$. Which moment of inertia applies to a shell?', leakAnswer)).toEqual([]);
  });
});
