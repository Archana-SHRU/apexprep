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

/** Output budget floor for one JSON reply from a model that thinks first (see `generateJsonText`). */
export const GEMINI_MIN_OUTPUT_TOKENS = 16_384;

export interface GeminiOptions {
  apiKey: string;
  explanationModel: string;
  embeddingModel: string | null;
  embeddingDimensions: number;
  /** Set only when image generation is explicitly configured (`AI_IMAGE_MODEL`). */
  imageModel?: string | null;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Overridden in tests; never point this at anything but Google's API in production. */
  baseUrl?: string;
  /** Injected so the request shaping can be unit-tested without a network. */
  fetchImpl?: typeof fetch;
}

/**
 * Gemini — the low-cost primary provider.
 *
 * The API key travels in a header, never in the URL (query strings end up in access logs),
 * and never reaches a response body: the frontend cannot see it.
 */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GeminiOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get explanationModel(): string {
    return this.options.explanationModel;
  }
  get embeddingModel(): string | null {
    return this.options.embeddingModel;
  }

  get imageModel(): string | null {
    return this.options.imageModel ?? null;
  }

  async generateExplanation(prompt: ExplanationPrompt): Promise<AiExplanationResult> {
    const text = await this.generateJsonText(buildExplanationPrompt(prompt), 0.2, this.options.maxOutputTokens);
    const parsed = parseExplanationReply(text);
    if (!parsed.ok) throw new AiProviderError('gemini', 'malformed_response', parsed.reason);

    return { provider: 'gemini', model: this.options.explanationModel, explanation: parsed.value };
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    const text = await this.generateJsonText(request.prompt, request.temperature, request.maxOutputTokens);
    return { provider: 'gemini', model: this.options.explanationModel, text };
  }

  /**
   * One image from Gemini's image model. Only reachable when `AI_IMAGE_MODEL` names one: an
   * explanation model asked for an image returns text, which would be a malformed reply here.
   */
  async generateImage(prompt: string): Promise<ImageResult> {
    const model = this.options.imageModel;
    if (!model) throw new AiProviderError('gemini', 'bad_request', 'AI_IMAGE_MODEL is not configured');
    const json = await this.post(`/models/${encodeURIComponent(model)}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    const candidate = this.candidateOf(json);
    const inline = (candidate.content?.parts ?? []).find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) throw new AiProviderError('gemini', 'malformed_response', 'no image was returned');
    const mimeType = inline.mimeType === 'image/jpeg' || inline.mimeType === 'image/webp' ? inline.mimeType : 'image/png';
    const bytes = Buffer.from(inline.data, 'base64');
    if (bytes.length === 0) throw new AiProviderError('gemini', 'malformed_response', 'the returned image was empty');
    return { provider: 'gemini', model, mimeType, bytes };
  }

  /** A JSON-mode completion from the explanation model, as raw text. */
  private async generateJsonText(prompt: string, temperature: number, maxOutputTokens: number): Promise<string> {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        // Current Gemini models think before answering, and that thinking is counted against this same
        // limit: at 4096 a generated question was cut off mid-JSON in live use. The floor leaves room for
        // the thinking; billing is for tokens actually produced, not for the ceiling.
        maxOutputTokens: Math.max(maxOutputTokens, GEMINI_MIN_OUTPUT_TOKENS),
        responseMimeType: 'application/json',
      },
    };
    const json = await this.post(`/models/${encodeURIComponent(this.options.explanationModel)}:generateContent`, body);
    const candidate = this.candidateOf(json);
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new AiProviderError('gemini', 'malformed_response', 'the reply was cut off at the output token limit');
    }
    return (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }

  /** The first candidate, or the typed failure that explains why there is none. */
  private candidateOf(json: unknown): NonNullable<GeminiGenerateResponse['candidates']>[number] {
    const candidate = (json as GeminiGenerateResponse).candidates?.[0];
    if (!candidate) {
      const blocked = (json as GeminiGenerateResponse).promptFeedback?.blockReason;
      throw new AiProviderError('gemini', blocked ? 'refused' : 'malformed_response', blocked ? `prompt blocked: ${blocked}` : 'no candidate returned');
    }
    if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
      throw new AiProviderError('gemini', 'refused', `generation stopped: ${candidate.finishReason}`);
    }
    return candidate;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    const model = this.options.embeddingModel;
    if (!model) throw new AiProviderError('gemini', 'bad_request', 'AI_EMBEDDING_MODEL is not configured');
    if (texts.length === 0) return { provider: 'gemini', model, dimensions: this.options.embeddingDimensions, vectors: [] };

    const body = {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: this.options.embeddingDimensions,
        taskType: 'RETRIEVAL_DOCUMENT',
      })),
    };
    const json = await this.post(`/models/${encodeURIComponent(model)}:batchEmbedContents`, body);

    const vectors = ((json as GeminiEmbedResponse).embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
      throw new AiProviderError('gemini', 'malformed_response', `expected ${texts.length} embeddings, got ${vectors.length}`);
    }
    const dimensions = vectors[0]!.length;
    if (vectors.some((v) => v.length !== dimensions)) {
      throw new AiProviderError('gemini', 'malformed_response', 'embeddings came back with mixed dimensions');
    }
    return { provider: 'gemini', model, dimensions, vectors };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new AiProviderError('gemini', 'unavailable', aborted ? `request timed out after ${this.options.timeoutMs}ms` : 'could not reach Gemini');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw statusError(response.status);
    try {
      return await response.json();
    } catch {
      throw new AiProviderError('gemini', 'malformed_response', 'response body was not JSON');
    }
  }
}

function statusError(status: number): AiProviderError {
  if (status === 401 || status === 403) return new AiProviderError('gemini', 'unauthorized', 'Gemini rejected the API key', status);
  // 408 request timeout, 429 quota/rate limit, 5xx (503 is "high demand"): another provider may well succeed.
  if (status === 408 || status === 429 || status >= 500) return new AiProviderError('gemini', 'unavailable', `Gemini returned ${status}`, status);
  return new AiProviderError('gemini', 'bad_request', `Gemini returned ${status}`, status);
}

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}
interface GeminiEmbedResponse {
  embeddings?: { values?: number[] }[];
}
