import { AiProviderError, type AiProvider, type ExplanationPrompt } from '../../src/ai/ai-provider';
import { AiService, STRUCTURED_PARSE_ATTEMPTS } from '../../src/ai/ai.service';
import { ClaudeProvider } from '../../src/ai/claude.provider';
import { GEMINI_MIN_OUTPUT_TOKENS, GeminiProvider } from '../../src/ai/gemini.provider';
import { PROMPT_VERSION, buildExplanationPrompt, parseExplanationReply } from '../../src/ai/prompts';
import { AppException } from '../../src/common/errors/app-exception';

const prompt = (patch: Partial<ExplanationPrompt> = {}): ExplanationPrompt => ({
  mode: 'grounded',
  questionType: 'single_correct',
  stem: 'A ring rolls without slipping. Find the angular speed.',
  options: [
    { key: 'A', text: 'omega equals v over R' },
    { key: 'B', text: 'omega equals v R' },
  ],
  distractorKey: null,
  subtopicName: 'Angular Momentum',
  chunks: [{ blockId: '11111111-1111-4111-8111-111111111111', chunkIndex: 0, title: 'Rolling', text: 'For rolling without slipping, v = omega R.' }],
  locale: 'en',
  ...patch,
});

/** A response object shaped like `fetch`'s, so a provider can be driven without a network. */
function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** A `fetch` stand-in: one cast, in one place, instead of one per test. */
function mockFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {}))) as unknown as typeof fetch;
}

const REPLY = {
  summary: 'Rolling without slipping ties the angular speed to the translational speed.',
  steps: ['The contact point is instantaneously at rest.', 'Therefore v = omega R.'],
  keyConcept: 'Rolling constraint',
  commonMistake: null,
  finalAnswer: { optionKeys: ['A'] },
  citedBlockIds: ['11111111-1111-4111-8111-111111111111'],
};

describe('the prompt sent to a provider', () => {
  it('never contains the answer key', () => {
    const text = buildExplanationPrompt(prompt());
    expect(text).toContain('omega equals v over R'); // the option text is fair game
    expect(text.toLowerCase()).not.toContain('correct option');
    expect(text.toLowerCase()).not.toContain('is_correct');
    expect(text.toLowerCase()).not.toContain('answer key');
  });

  it('tells a grounded call to use only the notes, and names the blocks it may cite', () => {
    const text = buildExplanationPrompt(prompt());
    expect(text).toMatch(/Answer ONLY from the numbered notes/);
    expect(text).toContain('blockId=11111111-1111-4111-8111-111111111111');
    expect(text).toContain('For rolling without slipping, v = omega R.');
  });

  it('tells a general call there are no notes and nothing to cite', () => {
    const text = buildExplanationPrompt(prompt({ mode: 'general', chunks: [] }));
    expect(text).toMatch(/answer from general subject knowledge/);
    expect(text).toMatch(/empty array for "citedBlockIds"/);
    expect(text).not.toContain('NOTES');
  });

  it('asks for the distractor to be addressed when one is given', () => {
    expect(buildExplanationPrompt(prompt({ distractorKey: 'B' }))).toMatch(/student chose option B, which is wrong/);
  });

  it('caps the notes so one enormous set cannot blow a provider limit', () => {
    const huge = Array.from({ length: 10 }, (_, i) => ({
      blockId: `2222222${i}-1111-4111-8111-111111111111`,
      chunkIndex: 0,
      title: null,
      text: 'x'.repeat(5000),
    }));
    expect(buildExplanationPrompt(prompt({ chunks: huge })).length).toBeLessThan(30_000);
  });

  it('has a version, which is what makes a prompt change invalidate cached explanations', () => {
    expect(PROMPT_VERSION).toMatch(/^exp-/);
  });
});

describe('parsing a model reply', () => {
  it('accepts a clean JSON object', () => {
    const parsed = parseExplanationReply(JSON.stringify(REPLY));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.finalAnswer).toEqual({ optionKeys: ['A'] });
  });

  it('digs the object out of prose and code fences', () => {
    const wrapped = `Sure! Here you go:\n\`\`\`json\n${JSON.stringify(REPLY)}\n\`\`\`\nHope that helps.`;
    expect(parseExplanationReply(wrapped).ok).toBe(true);
  });

  it('handles braces inside strings without losing the object', () => {
    const tricky = { ...REPLY, summary: 'Use the set {a, b} and the map {"k": 1} carefully here.' };
    const parsed = parseExplanationReply(`noise ${JSON.stringify(tricky)} trailing`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.summary).toContain('{"k": 1}');
  });

  it('refuses a reply with no JSON, invalid JSON, or the wrong shape', () => {
    expect(parseExplanationReply('I cannot help with that.')).toEqual({ ok: false, reason: 'reply contained no JSON object' });
    expect(parseExplanationReply('{not json}')).toMatchObject({ ok: false, reason: 'reply was not valid JSON' });
    expect(parseExplanationReply(JSON.stringify({ summary: 'x' }))).toMatchObject({ ok: false });
  });

  it('fills the optional fields rather than leaving them undefined, and de-duplicates citations', () => {
    const parsed = parseExplanationReply(JSON.stringify({ summary: 'A summary.', steps: ['One.'], citedBlockIds: [REPLY.citedBlockIds[0], REPLY.citedBlockIds[0]] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({ keyConcept: null, commonMistake: null, finalAnswer: null });
      expect(parsed.value.citedBlockIds).toHaveLength(1);
    }
  });

  it('rejects a citation that is not a block id', () => {
    expect(parseExplanationReply(JSON.stringify({ ...REPLY, citedBlockIds: ['the first note'] }))).toMatchObject({ ok: false });
  });
});

describe('the Gemini path', () => {
  const build = (fetchImpl: typeof fetch) =>
    new GeminiProvider({
      apiKey: 'test-key',
      explanationModel: 'gemini-2.5-flash',
      embeddingModel: 'text-embedding-004',
      embeddingDimensions: 8,
      timeoutMs: 5000,
      maxOutputTokens: 1024,
      baseUrl: 'https://example.invalid/v1beta',
      fetchImpl,
    });

  it('sends the key in a header, never in the URL, and parses the reply', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const provider = build(
      mockFetch((url, init) => {
        seen.push({ url, init });
        return response({ candidates: [{ content: { parts: [{ text: JSON.stringify(REPLY) }] } }] });
      }),
    );

    const result = await provider.generateExplanation(prompt());
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash' });
    expect(result.explanation.summary).toBe(REPLY.summary);
    expect(seen[0]!.url).not.toContain('test-key');
    expect(JSON.stringify(seen[0]!.init.headers)).toContain('test-key');
  });

  it('reports a safety refusal as a refusal, not a transport failure', async () => {
    const provider = build(mockFetch(() => response({ promptFeedback: { blockReason: 'SAFETY' } })));
    await expect(provider.generateExplanation(prompt())).rejects.toMatchObject({ kind: 'refused', retryable: false });
  });

  it('classifies HTTP failures so the dispatcher knows whether to try elsewhere', async () => {
    const statuses: [number, string, boolean][] = [
      [401, 'unauthorized', true],
      [429, 'unavailable', true],
      [500, 'unavailable', true],
      [400, 'bad_request', false],
    ];
    for (const [status, kind, retryable] of statuses) {
      const provider = build(mockFetch(() => response({ error: { message: 'nope' } }, status)));
      await expect(provider.generateExplanation(prompt())).rejects.toMatchObject({ kind, retryable });
    }
  });

  it('embeds text and reports the dimensions it got back', async () => {
    const provider = build(mockFetch(() => response({ embeddings: [{ values: [0.1, 0.2, 0.3] }] })));
    const result = await provider.embed(['some theory']);
    expect(result).toMatchObject({ provider: 'gemini', dimensions: 3 });
    expect(result.vectors[0]).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('the Claude path', () => {
  const build = (fetchImpl: typeof fetch) =>
    new ClaudeProvider({
      apiKey: 'test-key',
      explanationModel: 'claude-sonnet-4-5',
      timeoutMs: 5000,
      maxOutputTokens: 1024,
      baseUrl: 'https://example.invalid/v1',
      fetchImpl,
    });

  it('sends the key in the x-api-key header and parses the reply', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const provider = build(
      mockFetch((url, init) => {
        seen.push({ url, init });
        return response({ content: [{ type: 'text', text: JSON.stringify(REPLY) }] });
      }),
    );

    const result = await provider.generateExplanation(prompt());
    expect(result).toMatchObject({ provider: 'claude', model: 'claude-sonnet-4-5' });
    expect(result.explanation.steps).toEqual(REPLY.steps);
    expect(seen[0]!.url).not.toContain('test-key');
    expect(JSON.stringify(seen[0]!.init.headers)).toContain('x-api-key');
  });

  it('cannot embed, and says so rather than producing vectors of the wrong provenance', async () => {
    const provider = build(mockFetch(() => response({})));
    expect(provider.embeddingModel).toBeNull();
    await expect(provider.embed()).rejects.toBeInstanceOf(AiProviderError);
  });

  it('reports a malformed reply as malformed', async () => {
    const provider = build(mockFetch(() => response({ content: [{ type: 'text', text: 'I would rather not.' }] })));
    await expect(provider.generateExplanation(prompt())).rejects.toMatchObject({ kind: 'malformed_response' });
  });
});

describe('which provider serves a request', () => {
  const stub = (name: 'gemini' | 'claude', behaviour: 'ok' | AiProviderError, embeds = true): AiProvider & { calls: number } => ({
    name,
    explanationModel: `${name}-model`,
    embeddingModel: embeds ? `${name}-embed` : null,
    calls: 0,
    generateExplanation() {
      (this as { calls: number }).calls += 1;
      if (behaviour !== 'ok') return Promise.reject(behaviour);
      return Promise.resolve({ provider: name, model: `${name}-model`, explanation: { ...REPLY, keyConcept: null, commonMistake: null } });
    },
    embed(texts: string[]) {
      (this as { calls: number }).calls += 1;
      if (behaviour !== 'ok') return Promise.reject(behaviour);
      return Promise.resolve({ provider: name, model: `${name}-embed`, dimensions: 2, vectors: texts.map(() => [0, 1]) });
    },
    imageModel: null,
    generateStructured() {
      (this as { calls: number }).calls += 1;
      if (behaviour !== 'ok') return Promise.reject(behaviour);
      return Promise.resolve({ provider: name, model: `${name}-model`, text: `{"from":"${name}"}` });
    },
    generateImage() {
      return Promise.reject(new AiProviderError(name, 'bad_request', 'no image model'));
    },
  });

  it('refuses without calling anything when no provider is configured', async () => {
    const service = new AiService(null, null);
    expect(service.configured).toBe(false);
    await expect(service.generateExplanation(prompt())).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    await expect(service.embed(['x'])).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });

  it('uses the primary when it works, and never touches the fallback', async () => {
    const primary = stub('gemini', 'ok');
    const fallback = stub('claude', 'ok');
    const result = await new AiService(primary, fallback).generateExplanation(prompt());
    expect(result.provider).toBe('gemini');
    expect(fallback.calls).toBe(0);
  });

  it('falls back when the primary fails retryably', async () => {
    const primary = stub('gemini', new AiProviderError('gemini', 'unavailable', 'timeout'));
    const fallback = stub('claude', 'ok');
    const result = await new AiService(primary, fallback).generateExplanation(prompt());
    expect(result.provider).toBe('claude');
    expect(fallback.calls).toBe(1);
  });

  it('does not reach for a second provider when a retry cannot help', async () => {
    const primary = stub('gemini', new AiProviderError('gemini', 'bad_request', 'model does not exist'));
    const fallback = stub('claude', 'ok');
    await expect(new AiService(primary, fallback).generateExplanation(prompt())).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(fallback.calls).toBe(0);
  });

  it('never calls a paid provider that configuration did not name', async () => {
    const primary = stub('gemini', new AiProviderError('gemini', 'unavailable', 'down'));
    await expect(new AiService(primary, null).generateExplanation(prompt())).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });

  it('reports a service error, not a 500, when both providers fail', async () => {
    const service = new AiService(stub('gemini', new AiProviderError('gemini', 'unavailable', 'down')), stub('claude', new AiProviderError('claude', 'unavailable', 'also down')));
    const error = await service.generateExplanation(prompt()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(503);
    // The provider's own message never reaches the caller.
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain('down');
  });

  it('picks whichever configured provider can embed', async () => {
    const claudeFirst = new AiService(stub('claude', 'ok', false), stub('gemini', 'ok', true));
    expect(claudeFirst.embeddingProvider()?.name).toBe('gemini');
    const neither = new AiService(stub('claude', 'ok', false), null);
    expect(neither.embeddingProvider()).toBeNull();
    await expect(neither.embed(['x'])).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });
});

describe('structured generation for the learning features', () => {
  const structuredStub = (name: 'gemini' | 'claude', text: string | AiProviderError): AiProvider & { calls: number } => ({
    name,
    explanationModel: `${name}-model`,
    embeddingModel: null,
    imageModel: null,
    calls: 0,
    generateExplanation: () => Promise.reject(new Error('not used')),
    embed: () => Promise.reject(new Error('not used')),
    generateStructured() {
      (this as { calls: number }).calls += 1;
      return text instanceof AiProviderError ? Promise.reject(text) : Promise.resolve({ provider: name, model: `${name}-model`, text });
    },
    generateImage: () => Promise.reject(new AiProviderError(name, 'bad_request', 'no image model')),
  });
  const request = { task: 'tutor' as const, prompt: 'p', temperature: 0.2, maxOutputTokens: 1024 };
  const parseOk = (text: string) =>
    text.includes('"ok":true') ? { ok: true as const, value: JSON.parse(text) as { ok: boolean } } : { ok: false as const, reason: 'missing ok' };

  it('returns only a value the feature parser accepted', async () => {
    const result = await new AiService(structuredStub('gemini', '{"ok":true}'), null).generateJson(request, parseOk);
    expect(result).toEqual({ provider: 'gemini', model: 'gemini-model', value: { ok: true } });
  });

  it('treats a reply the parser rejects as malformed, and falls back to the second provider', async () => {
    const primary = structuredStub('gemini', '{"ok":false}');
    const fallback = structuredStub('claude', '{"ok":true}');
    const result = await new AiService(primary, fallback).generateJson(request, parseOk);
    expect(result.provider).toBe('claude');
    // One bounded resample on the same provider first, then the fallback.
    expect(primary.calls).toBe(STRUCTURED_PARSE_ATTEMPTS);
  });

  it('resamples once when a reply does not parse, and accepts the second if it does', async () => {
    const replies = ['{"broken"', '{"ok":true}'];
    const provider = { ...structuredStub('gemini', ''), generateStructured: () => Promise.resolve({ provider: 'gemini' as const, model: 'm', text: replies.shift()! }) };
    const result = await new AiService(provider, null).generateJson(request, parseOk);
    expect(result.value).toEqual({ ok: true });
    expect(replies).toHaveLength(0);
  });

  it('fails as a service error, never with the raw reply, when no provider produces a valid value', async () => {
    const error = await new AiService(structuredStub('gemini', '{"secret":"raw model text"}'), null)
      .generateJson(request, parseOk)
      .catch((e: unknown) => e);
    expect((error as AppException).getStatus()).toBe(503);
    expect(JSON.stringify((error as AppException).getResponse())).not.toContain('raw model text');
  });

  it('sends the per-feature output budget and JSON mode to Gemini', async () => {
    let body: Record<string, unknown> = {};
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      explanationModel: 'gemini-2.5-flash',
      embeddingModel: null,
      embeddingDimensions: 768,
      timeoutMs: 1000,
      maxOutputTokens: 2048,
      fetchImpl: mockFetch((_url, init) => {
        body = JSON.parse(init.body as string) as Record<string, unknown>;
        return response({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
      }),
    });
    // A budget above the floor is sent as asked; one below it is raised, because thinking shares the budget.
    const result = await provider.generateStructured({ ...request, maxOutputTokens: 20_000 });
    expect(result.text).toBe('{"ok":true}');
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 20_000, responseMimeType: 'application/json', temperature: 0.2 });
    await provider.generateStructured({ ...request, maxOutputTokens: 4096 });
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: GEMINI_MIN_OUTPUT_TOKENS });
  });

  it('reports a Gemini reply cut off at the token limit as malformed, never as a reply', async () => {
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      explanationModel: 'gemini-3.5-flash',
      embeddingModel: null,
      embeddingDimensions: 768,
      timeoutMs: 1000,
      maxOutputTokens: 2048,
      fetchImpl: mockFetch(() => response({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"stem": "A thin sph' }] } }] })),
    });
    const error = await provider.generateStructured(request).catch((e: unknown) => e as AiProviderError);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).kind).toBe('malformed_response');
    expect((error as AiProviderError).message).toMatch(/cut off/);
  });

  it('never calls an image model that is not configured', async () => {
    const service = new AiService(structuredStub('gemini', '{}'), null);
    expect(service.imageProvider()).toBeNull();
    await expect(service.generateImage('a ramp')).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });

  it('decodes an image returned by a configured Gemini image model', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      explanationModel: 'gemini-2.5-flash',
      embeddingModel: null,
      embeddingDimensions: 768,
      imageModel: 'image-model',
      timeoutMs: 1000,
      maxOutputTokens: 2048,
      fetchImpl: mockFetch((url) => {
        expect(url).toContain('image-model');
        return response({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] });
      }),
    });
    const image = await provider.generateImage('a ramp');
    expect(image.mimeType).toBe('image/png');
    expect(image.bytes.equals(png)).toBe(true);
  });
});
