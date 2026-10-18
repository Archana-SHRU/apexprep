import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception';
import {
  AI_FALLBACK_PROVIDER,
  AI_PRIMARY_PROVIDER,
  AiProviderError,
  type AiExplanationResult,
  type AiProvider,
  type EmbeddingResult,
  type ExplanationPrompt,
  type ImageResult,
  type StructuredRequest,
} from './ai-provider';

/** How many replies a structured request may sample from one provider before its output counts as malformed. */
export const STRUCTURED_PARSE_ATTEMPTS = 2;

/**
 * Which provider serves a request, and what happens when it fails.
 *
 * The rules, in order:
 *   1. No primary configured (`AI_PROVIDER=none`) → `503 AI_NOT_CONFIGURED`. Nothing is
 *      called and no explanation is generated; the caller falls back to whatever it can
 *      serve without AI.
 *   2. The primary is called.
 *   3. It fails **retryably** (network, timeout, 5xx, 429, rejected key, unparseable reply)
 *      → the fallback is called, but only if one is configured with its own key present.
 *      A paid provider is never reached for by inference: it has to be named in
 *      `AI_FALLBACK_PROVIDER`.
 *   4. It fails in a way a second provider cannot fix (bad request, safety refusal), or the
 *      fallback also fails → `503 AI_PROVIDER_UNAVAILABLE`.
 *
 * Provider errors never surface to a caller as a 500: they are an unavailable dependency,
 * and the message says which provider and why without quoting the provider's raw body.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Optional() @Inject(AI_PRIMARY_PROVIDER) private readonly primary: AiProvider | null,
    @Optional() @Inject(AI_FALLBACK_PROVIDER) private readonly fallback: AiProvider | null,
  ) {}

  /** Whether any provider is configured. Callers check this before promising an explanation. */
  get configured(): boolean {
    return this.primary !== null;
  }

  /** The provider that would serve the next request, for reporting and for prompt metadata. */
  get primaryName(): string | null {
    return this.primary?.name ?? null;
  }

  /** The provider that can produce embeddings, if any. Claude cannot. */
  embeddingProvider(): AiProvider | null {
    for (const provider of [this.primary, this.fallback]) {
      if (provider && provider.embeddingModel !== null) return provider;
    }
    return null;
  }

  async generateExplanation(prompt: ExplanationPrompt): Promise<AiExplanationResult> {
    return this.dispatch('explanation', (provider) => provider.generateExplanation(prompt));
  }

  /**
   * A structured reply for one of the learning features, parsed and validated by that feature.
   *
   * `parse` is the feature's own schema check. A reply it rejects is a `malformed_response` from
   * that provider — the same classification a provider gives unparseable JSON — so the ordinary
   * fallback applies, and a caller only ever receives a value its parser accepted. The raw text is
   * never returned and never logged.
   */
  async generateJson<T>(
    request: StructuredRequest,
    parse: (text: string) => { ok: true; value: T } | { ok: false; reason: string },
  ): Promise<{ provider: string; model: string; value: T }> {
    return this.dispatch(request.task.replace('_', ' '), async (provider) => {
      // One more attempt on the same provider when the reply does not parse: a second sample usually does,
      // and it is far cheaper than failing the request. Bounded at two, and only for a malformed reply — a
      // transport failure goes straight to the fallback rule in `dispatch`.
      let reason = '';
      for (let attempt = 0; attempt < STRUCTURED_PARSE_ATTEMPTS; attempt += 1) {
        const result = await provider.generateStructured(request);
        const parsed = parse(result.text);
        if (parsed.ok) return { provider: result.provider, model: result.model, value: parsed.value };
        reason = parsed.reason;
        this.logger.warn(`${provider.name} ${request.task} reply did not validate (attempt ${attempt + 1}): ${reason.slice(0, 300)}`);
      }
      throw new AiProviderError(provider.name, 'malformed_response', reason);
    });
  }

  /** The provider that can generate images, if one is configured with an image model. */
  imageProvider(): AiProvider | null {
    for (const provider of [this.primary, this.fallback]) {
      if (provider && provider.imageModel !== null) return provider;
    }
    return null;
  }

  async generateImage(prompt: string): Promise<ImageResult> {
    const provider = this.imageProvider();
    if (!provider) throw AppException.unavailable('No configured AI provider generates images', 'AI_PROVIDER_UNAVAILABLE');
    try {
      return await provider.generateImage(prompt);
    } catch (error) {
      throw this.toAppException(error, provider.name, 'image');
    }
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    const provider = this.embeddingProvider();
    if (!provider) {
      throw AppException.unavailable(
        this.configured
          ? 'The configured AI provider cannot produce embeddings, so semantic retrieval cannot be indexed'
          : 'No AI provider is configured (AI_PROVIDER=none)',
        this.configured ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_NOT_CONFIGURED',
      );
    }
    try {
      return await provider.embed(texts);
    } catch (error) {
      throw this.toAppException(error, provider.name, 'embedding');
    }
  }

  // ---------------------------------------------------------------- internals

  private async dispatch<T>(what: string, call: (provider: AiProvider) => Promise<T>): Promise<T> {
    if (!this.primary) {
      throw AppException.unavailable('No AI provider is configured (AI_PROVIDER=none)', 'AI_NOT_CONFIGURED');
    }

    try {
      return await call(this.primary);
    } catch (error) {
      const first = error instanceof AiProviderError ? error : null;
      if (!first?.retryable || !this.fallback) throw this.toAppException(error, this.primary.name, what);

      this.logger.warn(`${this.primary.name} ${what} failed (${first.kind}); trying ${this.fallback.name}`);
      try {
        // Exactly one fallback attempt; its result carries its own provider name, which is what callers record.
        const result = await call(this.fallback);
        this.logger.log(`${what} served by fallback ${this.fallback.name} after ${this.primary.name} ${first.kind}`);
        return result;
      } catch (fallbackError) {
        throw this.toAppException(fallbackError, this.fallback.name, what, first);
      }
    }
  }

  private toAppException(error: unknown, provider: string, what: string, firstFailure?: AiProviderError): AppException {
    const detail = error instanceof AiProviderError ? `${error.kind}: ${error.message}` : 'unexpected provider error';
    const preamble = firstFailure ? `both providers failed (${firstFailure.provider}: ${firstFailure.kind}; ` : `${provider} `;
    this.logger.error(`AI ${what} failed — ${preamble}${detail}`);
    return AppException.unavailable(`The ${what} provider is unavailable right now`, 'AI_PROVIDER_UNAVAILABLE');
  }
}
