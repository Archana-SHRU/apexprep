import type { AiExplanation } from '../../src/ai/ai-provider';
import { assessGrounding, contentTerms, groundingBand } from '../../src/explanations/grounding';
import type { ScoredCandidate } from '../../src/explanations/retrieval';
import { explanationParams } from '../fixtures/engine-params';

describe('how well an explanation is supported by the notes', () => {
  const params = explanationParams();

  const explanation = (patch: Partial<AiExplanation> = {}): AiExplanation => ({
    summary: 'Angular momentum about the contact point is conserved.',
    steps: ['Friction acts through the contact point.'],
    keyConcept: null,
    commonMistake: null,
    finalAnswer: { optionKeys: ['A'] },
    citedBlockIds: [],
    ...patch,
  });

  const chunk = (blockId: string, text: string, blockIds = [blockId]): ScoredCandidate => ({
    chunk: { blockId, chunkIndex: 0, title: null, text, tokenEstimate: 10, blockIds },
    scope: 'subtopic',
    vectorScore: null,
    keywordScore: 1,
    score: 1,
    semantic: false,
  });

  describe('content terms', () => {
    it('drops stopwords, single characters and bare numbers', () => {
      expect([...contentTerms('The torque is 5 about a contact point')].sort()).toEqual(['contact', 'point', 'torque']);
    });

    it('is case- and punctuation-insensitive', () => {
      expect(contentTerms('Angular-momentum, CONSERVED.')).toEqual(new Set(['angular', 'momentum', 'conserved']));
    });
  });

  it('scores 1 when every claim term appears in the notes', () => {
    const result = assessGrounding({
      explanation: explanation(),
      chunks: [chunk('b1', 'Angular momentum about the contact point is conserved because friction acts through it.')],
      questionText: 'A ring rolls without slipping.',
    });
    expect(result.score).toBe(1);
    expect(result.supportingBlockIds).toEqual(['b1']);
  });

  it('scores 0 when the notes support nothing the explanation claims', () => {
    const result = assessGrounding({
      explanation: explanation(),
      chunks: [chunk('b1', 'Thermodynamic entropy increases in an irreversible process.')],
      questionText: 'A ring rolls without slipping.',
    });
    expect(result.score).toBe(0);
    expect(result.supportingBlockIds).toEqual([]);
  });

  it('ignores terms the question already supplied, so restating the stem is not evidence', () => {
    const restating = assessGrounding({
      explanation: explanation({ summary: 'A ring rolls without slipping.', steps: ['A ring rolls without slipping.'] }),
      chunks: [chunk('b1', 'Unrelated notes about optics and lenses.')],
      questionText: 'A ring rolls without slipping.',
    });
    // Every term came from the question, so there is nothing to check — and nothing to credit.
    expect(restating.claimTermCount).toBe(0);
    expect(restating.score).toBe(0);
  });

  it('scores the fraction supported when the notes cover part of the reasoning', () => {
    const result = assessGrounding({
      explanation: explanation({ summary: 'conserved momentum', steps: ['entropy lenses'] }),
      chunks: [chunk('b1', 'Momentum is conserved in an isolated system.')],
      questionText: 'A question.',
    });
    // claim terms: conserved, momentum, entropy, lenses → 2 of 4 supported
    expect(result.claimTermCount).toBe(4);
    expect(result.supportedTermCount).toBe(2);
    expect(result.score).toBe(0.5);
  });

  it('measures the explanation, not the retrieval: good notes the model ignored score badly', () => {
    const result = assessGrounding({
      explanation: explanation({ summary: 'Entropy governs the lens aperture.', steps: ['Refraction dominates.'] }),
      chunks: [chunk('b1', 'Angular momentum about the contact point is conserved because friction acts through it.')],
      questionText: 'A ring rolls.',
    });
    expect(result.score).toBe(0);
  });

  it('never lets the model’s own citations affect the score', () => {
    const notes = [chunk('b1', 'Angular momentum about the contact point is conserved because friction acts through it.')];
    const honest = assessGrounding({ explanation: explanation(), chunks: notes, questionText: 'Q.' });
    const boastful = assessGrounding({
      explanation: explanation({ citedBlockIds: ['b1', 'b2', 'b3'] }),
      chunks: notes,
      questionText: 'Q.',
    });
    expect(boastful.score).toBe(honest.score);
    expect(boastful.citedBlockIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('credits every block that carried a supporting term, including a merged chunk', () => {
    const result = assessGrounding({
      explanation: explanation({ summary: 'conserved', steps: ['friction'] }),
      chunks: [chunk('b1', 'Momentum is conserved.', ['b1', 'b2']), chunk('b3', 'Friction acts at the contact.')],
      questionText: 'Q.',
    });
    expect(result.supportingBlockIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('rounds to the three decimals the column stores, so the stored score is the computed one', () => {
    const result = assessGrounding({
      explanation: explanation({ summary: 'alpha beta gamma', steps: ['delta epsilon zeta seven'] }),
      chunks: [chunk('b1', 'alpha beta')],
      questionText: 'Q.',
    });
    expect(result.score).toBe(Math.round(result.score * 1000) / 1000);
    expect(String(result.score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it('scores an empty explanation 0 rather than 1', () => {
    const result = assessGrounding({
      explanation: explanation({ summary: '', steps: [] }),
      chunks: [chunk('b1', 'Anything at all.')],
      questionText: 'Q.',
    });
    expect(result.score).toBe(0);
  });

  describe('bands', () => {
    it('follows the requirements: >= 0.75 notes-only, 0.50-0.75 mostly-notes, below general knowledge', () => {
      expect(groundingBand(1, params)).toBe('notes_only');
      expect(groundingBand(0.75, params)).toBe('notes_only');
      expect(groundingBand(0.7499, params)).toBe('mostly_notes');
      expect(groundingBand(0.5, params)).toBe('mostly_notes');
      expect(groundingBand(0.4999, params)).toBe('insufficient');
      expect(groundingBand(0, params)).toBe('insufficient');
    });
  });
});
