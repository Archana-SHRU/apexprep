import {
  AiProviderError,
  type AiExplanationResult,
  type AiProvider,
  type EmbeddingResult,
  type ExplanationPrompt,
  type ImageResult,
  type StructuredRequest,
  type StructuredResult,
} from './ai-provider';
import { buildExplanationPrompt, parseExplanationReply } from './prompts';

export interface ClaudeOptions {
  apiKey: string;
  explanationModel: string;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Overridden in tests; never point this at anything but Anthropic's API in production. */
  baseUrl?: string;
  /** Injected so the request shaping can be unit-tested without a network. */
  fetchImpl?: typeof fetch;
}

/**
 * Claude — the fallback, or the primary where an organisation configures it.
 *
 * Anthropic has no embedding endpoint, so `embeddingModel` is null and `embed` refuses rather than
 * silently producing vectors of the wrong provenance: a store of embeddings must come from
 * one model, or cosine distance between them is meaningless. Retrieval therefore needs
 * Gemini (or another embedding provider) configured even when Claude writes the prose.
 */
export class ClaudeProvider implements AiProvider {
  readonly name = 'claude' as const;
  readonly embeddingModel = null;
  readonly imageModel = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClaudeOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get explanationModel(): string {
    return this.options.explanationModel;
  }

  async generateExplanation(prompt: ExplanationPrompt): Promise<AiExplanationResult> {
    const { model, text } = await this.complete(buildExplanationPrompt(prompt), 0.2, this.options.maxOutputTokens);
    const parsed = parseExplanationReply(text);
    if (!parsed.ok) throw new AiProviderError('claude', 'malformed_response', parsed.reason);

    return { provider: 'claude', model, explanation: parsed.value };
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    const { model, text } = await this.complete(request.prompt, request.temperature, request.maxOutputTokens);
    return { provider: 'claude', model, text };
  }

  /** Anthropic's API does not generate images; a visual falls back to a structured diagram. */
  generateImage(): Promise<ImageResult> {
    return Promise.reject(new AiProviderError('claude', 'bad_request', 'Claude does not generate images'));
  }

  /** One JSON-only completion, returned as raw text with the model that actually answered. */
  private async complete(prompt: string, temperature: number, maxOutputTokens: number): Promise<{ model: string; text: string }> {
    const body = {
      model: this.options.explanationModel,
      ...claudeGenerationParams(this.options.explanationModel, temperature, maxOutputTokens),
      system: 'Reply with a single JSON object and nothing else.',
      messages: [{ role: 'user', content: prompt }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new AiProviderError('claude', 'unavailable', aborted ? `request timed out after ${this.options.timeoutMs}ms` : 'could not reach Claude');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw statusError(response.status);

    let json: ClaudeMessageResponse;
    try {
      json = (await response.json()) as ClaudeMessageResponse;
    } catch {
      throw new AiProviderError('claude', 'malformed_response', 'response body was not JSON');
    }

    if (json.stop_reason === 'refusal') throw new AiProviderError('claude', 'refused', 'the model declined to answer');
    // A reply cut off at the token limit is incomplete JSON: say so, rather than as an unexplained parse failure.
    if (json.stop_reason === 'max_tokens') throw new AiProviderError('claude', 'malformed_response', 'the reply was cut off at the output token limit');
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return { model: json.model ?? this.options.explanationModel, text };
  }

  embed(): Promise<EmbeddingResult> {
    return Promise.reject(
      new AiProviderError('claude', 'bad_request', 'Claude has no embedding endpoint; configure a provider that does for RAG indexing'),
    );
  }
}

function statusError(status: number): AiProviderError {
  if (status === 401 || status === 403) return new AiProviderError('claude', 'unauthorized', 'Anthropic rejected the API key', status);
  // 408 request timeout, 429 rate limit, 5xx including 529 overloaded: another provider may well succeed.
  if (status === 408 || status === 429 || status >= 500) return new AiProviderError('claude', 'unavailable', `Anthropic returned ${status}`, status);
  return new AiProviderError('claude', 'bad_request', `Anthropic returned ${status}`, status);
}

/**
 * Models that still take sampling parameters and no `effort`: the Claude 3 family and Claude 4.0-4.6
 * (Haiku 4.5, Sonnet 4.5/4.6, Opus 4.1-4.6), with or without a date suffix.
 */
const SAMPLING_MODELS = /^claude-(?:3[-.]|(?:haiku|sonnet|opus)-4(?:-[0-6])?(?:-\d{8})?$)/;

/**
 * Generation parameters for one request, by model generation.
 *
 * Current Claude models (Opus 4.7+, Sonnet 5, Opus 5, Fable) reject `temperature` with a 400, and think by
 * default — thinking that counts against `max_tokens`. Sending the old shape to them made every request a
 * non-retryable 400, i.e. a fallback that could never succeed. So: sampling only where it is accepted; for
 * current models `effort` instead, and room in `max_tokens` for the thinking (billing is for tokens used).
 * An unrecognised model name is treated as current, so a new model gets the request current models accept.
 */
export function claudeGenerationParams(model: string, temperature: number, maxOutputTokens: number): Record<string, unknown> {
  if (SAMPLING_MODELS.test(model)) return { max_tokens: maxOutputTokens, temperature };
  return { max_tokens: Math.max(maxOutputTokens, CURRENT_MODEL_MIN_MAX_TOKENS), output_config: { effort: 'medium' } };
}

/** Enough room for adaptive thinking plus a JSON reply in one non-streaming request. */
const CURRENT_MODEL_MIN_MAX_TOKENS = 16_000;

interface ClaudeMessageResponse {
  model?: string;
  stop_reason?: string;
  content?: { type?: string; text?: string }[];
}
