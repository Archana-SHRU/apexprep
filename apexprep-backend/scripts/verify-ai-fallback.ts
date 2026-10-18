/**
 * Live check of the Claude fallback:  npm run ai:verify-fallback
 *
 * Makes REAL Anthropic API calls with the key in .env, and spends no Gemini quota: the primary slot is a
 * stand-in that always answers like an exhausted Gemini (429), so every request is a genuine fallback.
 *
 *   1. Model    — asks Anthropic's Models API whether the configured fallback model exists for this key.
 *   2. Fallback — one real question generation through AiService (primary 429 → Claude), then the real parser,
 *                 schema, self-consistency, grounding and leak checks; prints the provider/model the services
 *                 record as provenance.
 *   3. Shape    — the actual outgoing request (model, max_tokens, effort/thinking, no temperature, timeout),
 *                 captured on the wire with the key removed.
 *   4. Failure  — a second real call with a deliberately invalid key must end in the generic 503 a student sees.
 *
 * Writes nothing to the database. Never prints the key. Exits non-zero when any check fails.
 */
import { AiProviderError, type AiProvider } from '../src/ai/ai-provider';
import { DEFAULT_MODELS } from '../src/ai/ai.module';
import { AiService } from '../src/ai/ai.service';
import { ClaudeProvider } from '../src/ai/claude.provider';
import type { AppException } from '../src/common/errors/app-exception';
import { loadEnvFile } from '../src/config/load-env-file';
import { buildGenerationPrompt, parseGeneratedQuestion } from '../src/learning-ai/questions/generation.prompt';
import { validateGeneratedQuestion } from '../src/learning-ai/questions/generation.validation';
import { chunkSources } from '../src/learning-ai/source';

/** Test material for this check only: a short note the generated question must be built on. */
const NOTE = {
  blockId: '0f0f0f0f-0000-4000-8000-000000000001',
  title: 'Perimeter of a rectangle',
  text:
    'The perimeter of a rectangle is the total distance around its boundary. To find the perimeter, add the lengths of all four sides. ' +
    'For a rectangle, perimeter = 2 x (length + width). A common mistake is to multiply the length and width, which gives the area, not the perimeter.',
  contentHash: 'verify',
  sortOrder: 0,
};

/** A primary that behaves like Gemini out of quota, without calling Gemini. */
const exhaustedGemini: AiProvider = {
  name: 'gemini',
  explanationModel: 'gemini-stand-in',
  embeddingModel: null,
  imageModel: null,
  generateExplanation: () => Promise.reject(new AiProviderError('gemini', 'unavailable', 'Gemini returned 429', 429)),
  embed: () => Promise.reject(new AiProviderError('gemini', 'unavailable', 'Gemini returned 429', 429)),
  generateStructured: () => Promise.reject(new AiProviderError('gemini', 'unavailable', 'Gemini returned 429', 429)),
  generateImage: () => Promise.reject(new AiProviderError('gemini', 'bad_request', 'no image model')),
};

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main(): Promise<void> {
  loadEnvFile();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    console.log('ANTHROPIC_API_KEY is not set in .env: the Claude fallback cannot be verified live. Nothing was called.');
    process.exit(2);
  }
  const model = process.env.AI_FALLBACK_MODEL?.trim() || DEFAULT_MODELS.claude.explanation;
  const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 90_000);
  console.log(`fallback model under test: ${model}   timeout: ${timeoutMs}ms   key: set (not shown)\n`);

  // 1. Is the model available to this key? Asked, not assumed.
  const lookup = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  if (lookup.status === 401 || lookup.status === 403) {
    check(false, 'model lookup', `Anthropic rejected the key (${lookup.status}); nothing further was attempted`);
    process.exit(1);
  }
  const info = (await lookup.json().catch(() => ({}))) as { id?: string; display_name?: string; max_tokens?: number };
  check(lookup.ok, '1. fallback model is available to this key', lookup.ok ? `${info.display_name ?? info.id} (max output ${info.max_tokens ?? '?'})` : `HTTP ${lookup.status}: set AI_FALLBACK_MODEL to a model this account can use`);
  if (!lookup.ok) process.exit(1);

  // 2 + 3. A real fallback, with the outgoing request captured (key removed).
  const sent: Record<string, unknown>[] = [];
  const recordingFetch = ((url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    sent.push({ url, ...body, messages: '[prompt omitted]' });
    return fetch(url, init);
  }) as typeof fetch;
  const claude = new ClaudeProvider({ apiKey: key, explanationModel: model, timeoutMs, maxOutputTokens: Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 2048), fetchImpl: recordingFetch });
  const ai = new AiService(exhaustedGemini, claude);

  const prompt = buildGenerationPrompt({
    audience: 'a school student in Class 5. Use very short sentences.',
    subtopicPath: 'Mathematics › Measurement › Perimeter and Area › Perimeter of a Rectangle',
    type: 'single_correct',
    level: 2,
    chunks: chunkSources([NOTE], { minTokens: 50, maxTokens: 800 }),
    avoid: [],
  });
  const started = Date.now();
  let result: Awaited<ReturnType<AiService['generateJson']>> | null = null;
  try {
    result = await ai.generateJson({ task: 'question_generation', prompt, temperature: 0.7, maxOutputTokens: 4096 }, parseGeneratedQuestion);
  } catch (error) {
    check(false, '2. Gemini 429 → Claude fallback produced a structured reply', (error as AppException).message);
  }
  if (result) {
    check(result.provider === 'claude', '2. Gemini 429 → Claude fallback produced a structured reply', `${Date.now() - started}ms`);
    check(result.model.startsWith(model.replace(/-\d{8}$/, '')), '   provenance recorded by the services', `provider=${result.provider} (Anthropic), model=${result.model}`);
    const draft = result.value as Parameters<typeof validateGeneratedQuestion>[0]['draft'];
    const v = validateGeneratedQuestion({ draft, requestedType: 'single_correct', sources: [NOTE], existingStems: [], minGrounding: 0.5 });
    check(v.ok, '   schema, self-consistency, grounding and leak checks on the fallback output', v.ok ? `grounding ${v.groundingScore}` : v.failures.map((f) => `${f.check}: ${f.detail}`).join('; '));
    console.log(`      generated stem: ${draft.stem.slice(0, 160)}`);
  }

  const shape = sent[0] ?? {};
  console.log(`\n3. request sent to Anthropic: ${JSON.stringify(shape)}`);
  check(shape.model === model, '   model is the configured fallback model');
  check(!('temperature' in shape) || /^claude-(?:3|(?:haiku|sonnet|opus)-4(?:-[0-6])?(?:-\d{8})?$)/.test(model), '   no temperature sent to a current model');
  check(typeof shape.max_tokens === 'number', '   max_tokens set', String(shape.max_tokens));

  // 4. Both providers failing (real Anthropic 401 from an invalid key) must surface only the generic error.
  const brokenClaude = new ClaudeProvider({ apiKey: 'sk-ant-invalid-for-verification', explanationModel: model, timeoutMs, maxOutputTokens: 1024 });
  const both = await new AiService(exhaustedGemini, brokenClaude).generateJson({ task: 'tutor', prompt: 'Reply with {"onTopic": true}', temperature: 0.2, maxOutputTokens: 256 }, (t) => ({ ok: true, value: t })).catch((e: unknown) => e as AppException);
  const response = JSON.stringify((both as AppException).getResponse?.() ?? {});
  check((both as AppException).getStatus?.() === 503 && /AI_PROVIDER_UNAVAILABLE/.test(response) && !/sk-ant|401|anthropic|gemini|claude/i.test(response), '4. Gemini fails → Claude fails → generic 503 only', response);

  console.log(`\n${failures === 0 ? 'All live fallback checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
