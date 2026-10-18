import { ConfigService } from '@nestjs/config';
import { buildAiProvider, DEFAULT_MODELS } from '../../src/ai/ai.module';
import { AiService, STRUCTURED_PARSE_ATTEMPTS } from '../../src/ai/ai.service';
import { ClaudeProvider, claudeGenerationParams } from '../../src/ai/claude.provider';
import { GeminiProvider } from '../../src/ai/gemini.provider';
import type { AppException } from '../../src/common/errors/app-exception';
import { validateEnv } from '../../src/config/env.schema';

/**
 * Production fallback, driven through the **real** Gemini and Claude provider classes — only their HTTP
 * layer is replaced — so the status-code classification, the single fallback attempt, output validation
 * after a fallback and the per-slot model configuration are all the code that runs in production.
 */

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const structured = { task: 'question_generation' as const, prompt: 'p', temperature: 0.7, maxOutputTokens: 4096 };
const parseAny = (text: string) => ({ ok: true as const, value: text });

/** A real Gemini provider whose HTTP layer answers with `handler`, counting the calls. */
function gemini(handler: (signal: AbortSignal | undefined) => Promise<Response> | Response, timeoutMs = 1000) {
  const seen = { calls: 0 };
  const provider = new GeminiProvider({
    apiKey: 'test-key',
    explanationModel: 'gemini-3.5-flash',
    embeddingModel: null,
    embeddingDimensions: 768,
    timeoutMs,
    maxOutputTokens: 2048,
    fetchImpl: ((_url: string, init?: RequestInit) => {
      seen.calls += 1;
      return Promise.resolve(handler(init?.signal ?? undefined));
    }) as unknown as typeof fetch,
  });
  return { provider, seen };
}

/** A real Claude provider whose HTTP layer answers with `handler`, recording each request body. */
function claude(handler: () => Response, model = 'claude-opus-5') {
  const bodies: Record<string, unknown>[] = [];
  const provider = new ClaudeProvider({
    apiKey: 'test-key',
    explanationModel: model,
    timeoutMs: 1000,
    maxOutputTokens: 2048,
    fetchImpl: ((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      return Promise.resolve(handler());
    }) as unknown as typeof fetch,
  });
  return { provider, bodies };
}
const claudeOk = () => response({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"from":"claude"}' }] });
const errorOf = (e: unknown) => e as AppException;

describe('provider fallback with the real providers', () => {
  it('uses the primary when it succeeds, and never calls the fallback', async () => {
    const g = gemini(() => response({ candidates: [{ content: { parts: [{ text: '{"from":"gemini"}' }] } }] }));
    const c = claude(claudeOk);
    const result = await new AiService(g.provider, c.provider).generateJson(structured, parseAny);
    expect(result).toMatchObject({ provider: 'gemini', value: '{"from":"gemini"}' });
    expect(c.bodies).toHaveLength(0);
  });

  it.each([
    [429, 'quota or rate limit'],
    [503, 'capacity'],
    [500, 'server error'],
    [408, 'request timeout'],
  ])('falls back once to Claude when Gemini answers %i (%s), and records Claude as the provider', async (status) => {
    const g = gemini(() => response({ error: { code: status } }, status));
    const c = claude(claudeOk);
    const result = await new AiService(g.provider, c.provider).generateJson(structured, parseAny);
    expect(result.provider).toBe('claude');
    expect(result.model).toBe('claude-opus-5');
    expect(g.seen.calls).toBe(1); // a failed transport is not retried on the same provider
    expect(c.bodies).toHaveLength(1);
  });

  it('falls back when the primary times out', async () => {
    const g = gemini(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      30,
    );
    const c = claude(claudeOk);
    const result = await new AiService(g.provider, c.provider).generateJson(structured, parseAny);
    expect(result.provider).toBe('claude');
  });

  it('fails safely when the fallback fails too: one attempt each, no provider detail in the error', async () => {
    const g = gemini(() => response({ error: { message: 'secret upstream detail' } }, 429));
    const c = claude(() => response({ error: { message: 'overloaded upstream detail' } }, 529));
    const error = errorOf(await new AiService(g.provider, c.provider).generateJson(structured, parseAny).catch((e: unknown) => e));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(error.getResponse())).not.toMatch(/upstream detail|429|529/);
    expect(g.seen.calls).toBe(1);
    expect(c.bodies).toHaveLength(1);
  });

  it('returns the safe error when no fallback is configured', async () => {
    const g = gemini(() => response({}, 503));
    const error = errorOf(await new AiService(g.provider, null).generateJson(structured, parseAny).catch((e: unknown) => e));
    expect(error.getResponse()).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(g.seen.calls).toBe(1);
  });

  it('does not fall back on a request the provider calls wrong (a configuration error, not an outage)', async () => {
    const g = gemini(() => response({ error: { message: 'model not found' } }, 404));
    const c = claude(claudeOk);
    const error = errorOf(await new AiService(g.provider, c.provider).generateJson(structured, parseAny).catch((e: unknown) => e));
    expect(error.getStatus()).toBe(503);
    expect(c.bodies).toHaveLength(0);
  });

  it('still validates the fallback’s output: a reply the feature rejects is never returned', async () => {
    const g = gemini(() => response({}, 429));
    const c = claude(() => response({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }));
    const strict = (text: string) => (text.startsWith('{') ? { ok: true as const, value: text } : { ok: false as const, reason: 'not json' });
    const error = errorOf(await new AiService(g.provider, c.provider).generateJson(structured, strict).catch((e: unknown) => e));
    expect(error.getResponse()).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    // Bounded: the fallback gets the same single resample a primary gets, and nothing beyond it.
    expect(c.bodies).toHaveLength(STRUCTURED_PARSE_ATTEMPTS);
  });
});

describe('Claude request shape by model generation', () => {
  it('sends no temperature to current models, and leaves room for their thinking', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5-1', 'claude-some-future-model']) {
      const params = claudeGenerationParams(model, 0.2, 3072);
      expect([model, params.temperature]).toEqual([model, undefined]);
      expect(params.max_tokens).toBeGreaterThanOrEqual(16_000);
      expect(params.output_config).toEqual({ effort: 'medium' });
    }
  });

  it('keeps temperature and the requested budget for models that take sampling parameters', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022']) {
      expect([model, claudeGenerationParams(model, 0.2, 3072)]).toEqual([model, { max_tokens: 3072, temperature: 0.2 }]);
    }
  });

  it('sends the current-model shape on the wire', async () => {
    const c = claude(claudeOk);
    await c.provider.generateStructured({ task: 'tutor', prompt: 'p', temperature: 0.3, maxOutputTokens: 3072 });
    expect(c.bodies[0]).toMatchObject({ model: 'claude-opus-5', max_tokens: 16_000, output_config: { effort: 'medium' } });
    expect(c.bodies[0]).not.toHaveProperty('temperature');
  });

  it('reports a reply cut off at the token limit as malformed, not as success', async () => {
    const c = claude(() => response({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"partial":' }] }));
    await expect(c.provider.generateStructured({ task: 'tutor', prompt: 'p', temperature: 0.3, maxOutputTokens: 1024 })).rejects.toMatchObject({
      kind: 'malformed_response',
    });
  });
});

describe('AI provider configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/apexprep',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:5173',
  };
  const env = (extra: Record<string, string>) => new ConfigService(validateEnv({ ...base, ...extra }));

  it('accepts "anthropic" as the name of the Claude provider', () => {
    const parsed = validateEnv({ ...base, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', AI_FALLBACK_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' });
    expect(parsed.AI_FALLBACK_PROVIDER).toBe('claude');
  });

  it('gives each slot its own model: the primary’s model name never reaches the fallback', () => {
    const config = env({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', AI_FALLBACK_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'a', AI_EXPLANATION_MODEL: 'gemini-3.5-flash' });
    expect(buildAiProvider('gemini', config.get('AI_EXPLANATION_MODEL'), config as never)?.explanationModel).toBe('gemini-3.5-flash');
    expect(buildAiProvider('claude', config.get('AI_FALLBACK_MODEL'), config as never)?.explanationModel).toBe(DEFAULT_MODELS.claude.explanation);
    const explicit = env({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', AI_FALLBACK_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'a', AI_FALLBACK_MODEL: 'claude-sonnet-5' });
    expect(buildAiProvider('claude', explicit.get('AI_FALLBACK_MODEL'), explicit as never)?.explanationModel).toBe('claude-sonnet-5');
  });

  it('defaults to models the providers currently serve', () => {
    expect(DEFAULT_MODELS.gemini).toEqual({ explanation: 'gemini-3.5-flash', embedding: 'gemini-embedding-001' });
    expect(DEFAULT_MODELS.claude.explanation).toBe('claude-opus-5');
  });

  it('refuses a fallback without its key, and a fallback equal to the primary', () => {
    expect(() => validateEnv({ ...base, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', AI_FALLBACK_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => validateEnv({ ...base, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', AI_FALLBACK_PROVIDER: 'gemini' })).toThrow(/must differ/);
  });
});

describe('provider selection safety', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/apexprep',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'http://localhost:5173',
  };

  it('rejects an unknown primary or fallback provider at startup', () => {
    expect(() => validateEnv({ ...base, AI_PROVIDER: 'openai' })).toThrow(/AI_PROVIDER/);
    expect(() => validateEnv({ ...base, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', AI_FALLBACK_PROVIDER: 'gpt' })).toThrow(/AI_FALLBACK_PROVIDER/);
    expect(() => validateEnv({ ...base, AI_FALLBACK_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' })).toThrow(/requires AI_PROVIDER/);
  });

  it('never echoes a key in a configuration error', () => {
    let message = '';
    try {
      validateEnv({ ...base, AI_PROVIDER: 'openai', GEMINI_API_KEY: 'super-secret-gemini-key' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/AI_PROVIDER/);
    expect(message).not.toContain('super-secret-gemini-key');
  });

  it.each([
    [400, 'malformed request'],
    [404, 'unknown model'],
  ])('does not fall back on a %i (%s): that is our configuration, not an outage', async (status) => {
    const g = gemini(() => response({ error: { code: status } }, status));
    const c = claude(claudeOk);
    await new AiService(g.provider, c.provider).generateJson(structured, parseAny).catch(() => undefined);
    expect(c.bodies).toHaveLength(0);
  });

  it('does not fall back when the primary refuses on safety grounds', async () => {
    const g = gemini(() => response({ promptFeedback: { blockReason: 'SAFETY' } }));
    const c = claude(claudeOk);
    const error = errorOf(await new AiService(g.provider, c.provider).generateJson(structured, parseAny).catch((e: unknown) => e));
    expect(error.getResponse()).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(c.bodies).toHaveLength(0);
  });

  it('has exactly two slots: a failing fallback never leads to a third provider or back to the primary', async () => {
    const g = gemini(() => response({}, 503));
    const c = claude(() => response({}, 503));
    await new AiService(g.provider, c.provider).generateJson(structured, parseAny).catch(() => undefined);
    expect(g.seen.calls).toBe(1);
    expect(c.bodies).toHaveLength(1);
  });
});

