import { groundingBandsOrdered, parseExplanationParams } from '../../src/explanations/explanation-params';
import { SEED_ENGINE_PARAMS } from '../fixtures/engine-params';

describe('the explanation settings, read from the versioned engine configuration', () => {
  it('accepts the development seed', () => {
    const parsed = parseExplanationParams(SEED_ENGINE_PARAMS);
    expect(parsed.ok).toBe(true);
  });

  it('has no defaults: a missing key is named, never substituted', () => {
    const { explanation: _dropped, ...withoutExplanation } = SEED_ENGINE_PARAMS;
    const parsed = parseExplanationParams(withoutExplanation);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.field)).toContain('params.explanation');
  });

  it('names the exact key that is missing, not just the object', () => {
    const explanation = SEED_ENGINE_PARAMS.explanation as Record<string, unknown>;
    const grounding = explanation.grounding as Record<string, unknown>;
    const { notes_only_min: _gone, ...rest } = grounding;
    const parsed = parseExplanationParams({ ...SEED_ENGINE_PARAMS, explanation: { ...explanation, grounding: rest } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.field)).toContain('params.explanation.grounding.notes_only_min');
  });

  it('rejects a grounding threshold outside 0-1 and a report threshold below 1', () => {
    const explanation = SEED_ENGINE_PARAMS.explanation as Record<string, unknown>;
    const bad = parseExplanationParams({
      ...SEED_ENGINE_PARAMS,
      explanation: { ...explanation, grounding: { notes_only_min: 1.5, mostly_notes_min: -1 }, reports: { unpublish_threshold: 0 } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const fields = bad.issues.map((i) => i.field);
      expect(fields).toContain('params.explanation.grounding.notes_only_min');
      expect(fields).toContain('params.explanation.reports.unpublish_threshold');
    }
  });

  it('reads `rag` from the same object the adaptive engine uses, without requiring its other keys', () => {
    const parsed = parseExplanationParams({ rag: SEED_ENGINE_PARAMS.rag, explanation: SEED_ENGINE_PARAMS.explanation });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.rag.widen_order).toEqual(['subtopic', 'topic', 'chapter']);
  });

  it('notices bands that have been crossed over', () => {
    const explanation = SEED_ENGINE_PARAMS.explanation as Record<string, unknown>;
    const crossed = parseExplanationParams({
      ...SEED_ENGINE_PARAMS,
      explanation: { ...explanation, grounding: { notes_only_min: 0.4, mostly_notes_min: 0.8 } },
    });
    expect(crossed.ok).toBe(true);
    if (crossed.ok) expect(groundingBandsOrdered(crossed.value)).toBe(false);

    const parsed = parseExplanationParams(SEED_ENGINE_PARAMS);
    if (parsed.ok) expect(groundingBandsOrdered(parsed.value)).toBe(true);
  });

  // The attempt requirement is a floor, not a preference: a stored `false` would turn the
  // explanation endpoint into an answer oracle for every unattempted question in the bank.
  describe('the attempt requirement cannot be configured away', () => {
    it('rejects a configuration that switches it off, rather than quietly ignoring it', () => {
      const explanation = SEED_ENGINE_PARAMS.explanation as Record<string, unknown>;
      const parsed = parseExplanationParams({
        ...SEED_ENGINE_PARAMS,
        explanation: { ...explanation, require_attempt: false },
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      const issue = parsed.issues.find((i) => i.field === 'params.explanation.require_attempt');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('cannot be permitted by configuration');
    });

    it('accepts it switched on, which is the only value it may take', () => {
      const explanation = SEED_ENGINE_PARAMS.explanation as Record<string, unknown>;
      const parsed = parseExplanationParams({ ...SEED_ENGINE_PARAMS, explanation: { ...explanation, require_attempt: true } });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.explanation.require_attempt).toBe(true);
    });

    it('is switched on in the seed the platform ships with', () => {
      const parsed = parseExplanationParams(SEED_ENGINE_PARAMS);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.explanation.require_attempt).toBe(true);
    });
  });

  it('carries the values the requirements state', () => {
    const parsed = parseExplanationParams(SEED_ENGINE_PARAMS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.explanation.grounding).toEqual({ notes_only_min: 0.75, mostly_notes_min: 0.5 });
    expect(parsed.value.explanation.chunk).toEqual({ min_tokens: 500, max_tokens: 800 });
    expect(parsed.value.explanation.reports.unpublish_threshold).toBe(3);
  });
});
