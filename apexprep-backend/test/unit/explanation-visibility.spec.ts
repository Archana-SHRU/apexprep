import {
  GENERAL_KNOWLEDGE_NOTICE,
  requiresHumanApproval,
  studentVisibility,
  type VisibilityInput,
} from '../../src/explanations/visibility';
import { explanationParams } from '../fixtures/engine-params';

describe('what a student is shown, and how it is labelled', () => {
  const params = explanationParams();
  const base: VisibilityInput = {
    tier: 'rag_grounded',
    status: 'active',
    groundingScore: 0.9,
    reviewedAt: null,
    track: { slug: 'jee-advanced', kind: null },
  };
  const visibility = (patch: Partial<VisibilityInput> = {}, p = params) => studentVisibility({ ...base, ...patch }, p);

  it('uses the product wording for a general-knowledge explanation, character for character', () => {
    // The requirements give this string. If it ever changes, it changes here and nowhere else.
    expect(GENERAL_KNOWLEDGE_NOTICE).toBe('Not from official notes — pending review');
    const result = visibility({ tier: 'general_ai', groundingScore: 0.1 });
    expect(result).toEqual({ visible: true, source: 'general_knowledge', notice: GENERAL_KNOWLEDGE_NOTICE, requiresReview: true });
  });

  it('labels the three sources distinctly', () => {
    expect(visibility({ tier: 'official_solution', groundingScore: null })).toMatchObject({ source: 'official_solution', notice: null });
    expect(visibility({ groundingScore: 0.8 })).toMatchObject({ source: 'notes_only', notice: null });
    expect(visibility({ groundingScore: 0.6 })).toMatchObject({ source: 'mostly_notes', notice: null });
  });

  it('puts the band boundaries where the requirements put them', () => {
    expect(visibility({ groundingScore: 0.75 })).toMatchObject({ source: 'notes_only' });
    expect(visibility({ groundingScore: 0.749 })).toMatchObject({ source: 'mostly_notes' });
    expect(visibility({ groundingScore: 0.5 })).toMatchObject({ source: 'mostly_notes' });
    expect(visibility({ groundingScore: 0.499 })).toMatchObject({ source: 'general_knowledge', notice: GENERAL_KNOWLEDGE_NOTICE });
  });

  it('re-derives the band from the configuration rather than trusting what was stored', () => {
    const strict = explanationParams({ explanation: { grounding: { notes_only_min: 0.95, mostly_notes_min: 0.9 } } });
    // 0.9 was notes-only under the seeded bands; raising the bar re-labels it at once.
    expect(visibility({ groundingScore: 0.9 })).toMatchObject({ source: 'notes_only' });
    expect(visibility({ groundingScore: 0.9 }, strict)).toMatchObject({ source: 'mostly_notes' });
  });

  describe('a blocking status beats every other consideration', () => {
    it('never shows an explanation that failed validation', () => {
      expect(visibility({ status: 'rejected', groundingScore: 1 })).toEqual({ visible: false, blockedReason: 'failed_validation' });
    });

    it('never shows one that was unpublished after reports', () => {
      expect(visibility({ status: 'flagged', tier: 'official_solution' })).toEqual({ visible: false, blockedReason: 'unpublished_after_reports' });
    });

    it('never shows a superseded one', () => {
      expect(visibility({ status: 'superseded' })).toEqual({ visible: false, blockedReason: 'superseded' });
    });
  });

  describe('mandatory human approval', () => {
    it('holds a generated explanation on a track configured for it', () => {
      expect(visibility({ track: { slug: 'physics-olympiad', kind: null } })).toEqual({ visible: false, blockedReason: 'pending_human_approval' });
      expect(visibility({ track: { slug: 'Astronomy-Olympiad-2027', kind: null } })).toEqual({ visible: false, blockedReason: 'pending_human_approval' });
    });

    it('releases it once a human has reviewed it', () => {
      expect(visibility({ track: { slug: 'physics-olympiad', kind: null }, reviewedAt: new Date() })).toMatchObject({ visible: true, source: 'notes_only' });
    });

    it('never holds an official solution: a human wrote it', () => {
      expect(visibility({ track: { slug: 'physics-olympiad', kind: null }, tier: 'official_solution', groundingScore: null })).toMatchObject({
        visible: true,
        source: 'official_solution',
      });
    });

    it('does not hold other tracks', () => {
      expect(requiresHumanApproval({ slug: 'jee-advanced', kind: null }, 'rag_grounded', params)).toBe(false);
      expect(requiresHumanApproval({ slug: 'neet', kind: null }, 'general_ai', params)).toBe(false);
      expect(requiresHumanApproval({ slug: 'maths-olympiad', kind: null }, 'rag_grounded', params)).toBe(true);
    });

    // Migration 0013 made `tracks.kind` the real check. These four cases are the whole rule.
    it('holds an Olympiad track whatever it is called, because kind says so and not the name', () => {
      const renamed = { slug: 'imo-selection-2027', kind: 'olympiad' };
      expect(requiresHumanApproval(renamed, 'rag_grounded', params)).toBe(true);
      // ...and still holds it with the slug patterns switched off entirely, which is what makes
      // `kind` the rule rather than a second opinion on the name.
      const none = explanationParams({ explanation: { approval: { mandatory_track_slug_patterns: [] } } });
      expect(requiresHumanApproval(renamed, 'rag_grounded', none)).toBe(true);
      expect(visibility({ track: renamed }, none)).toEqual({ visible: false, blockedReason: 'pending_human_approval' });
    });

    it('does not hold a track that says what it is and is not an Olympiad', () => {
      expect(requiresHumanApproval({ slug: 'class-5-mathematics', kind: 'school' }, 'rag_grounded', params)).toBe(false);
      expect(requiresHumanApproval({ slug: 'jee-main', kind: 'competitive_exam' }, 'general_ai', params)).toBe(false);
    });

    it('keeps holding an uncategorised Olympiad track, so applying 0013 removes no protection', () => {
      // Every track that existed before 0013 has kind = NULL and is not back-filled.
      expect(requiresHumanApproval({ slug: 'physics-olympiad', kind: null }, 'rag_grounded', params)).toBe(true);
    });

    it('resolves a track whose name and kind disagree in favour of the reviewer', () => {
      // A mislabelled track is a contradiction; holding it costs a click, releasing it is the harm
      // the requirement exists to prevent.
      expect(requiresHumanApproval({ slug: 'maths-olympiad', kind: 'school' }, 'rag_grounded', params)).toBe(true);
    });

    it('holds nothing when no pattern is configured', () => {
      const none = explanationParams({ explanation: { approval: { mandatory_track_slug_patterns: [] } } });
      expect(visibility({ track: { slug: 'physics-olympiad', kind: null } }, none)).toMatchObject({ visible: true });
    });
  });

  it('asks for a review of general knowledge only when configured to', () => {
    const quiet = explanationParams({ explanation: { approval: { review_general_knowledge: false } } });
    expect(visibility({ tier: 'general_ai' }, quiet)).toMatchObject({ requiresReview: false, notice: GENERAL_KNOWLEDGE_NOTICE });
  });

  it('treats a missing grounding score as no grounding at all', () => {
    expect(visibility({ groundingScore: null })).toMatchObject({ source: 'general_knowledge' });
  });
});
