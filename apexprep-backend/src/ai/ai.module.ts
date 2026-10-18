import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { AI_FALLBACK_PROVIDER, AI_PRIMARY_PROVIDER, type AiProvider, type AiProviderName } from './ai-provider';
import { AiService } from './ai.service';
import { ClaudeProvider } from './claude.provider';
import { GeminiProvider } from './gemini.provider';

/**
 * Default models, used when the model settings are not set.
 *
 * Checked against the providers on 2026-10-02: Google no longer serves `gemini-2.5-flash` or
 * `text-embedding-004` to new keys, so a fresh install on the old defaults failed every AI request.
 * `gemini-embedding-001` is called through the same `batchEmbedContents` endpoint at the configured
 * `AI_EMBEDDING_DIMENSIONS` (768, which is what the pgvector index in migration 0007 is built for).
 */
export const DEFAULT_MODELS: Record<AiProviderName, { explanation: string; embedding: string | null }> = {
  gemini: { explanation: 'gemini-3.5-flash', embedding: 'gemini-embedding-001' },
  claude: { explanation: 'claude-opus-5', embedding: null },
};

/**
 * Builds one provider from configuration, or null when that slot is `none`.
 *
 * Each slot has its own model setting: `AI_EXPLANATION_MODEL` for the primary, `AI_FALLBACK_MODEL` for the
 * fallback. They used to share one, which handed a Gemini model name to Claude (or the reverse) the moment
 * a fallback was configured, so every fallback request failed as a 404.
 *
 * The API key is read here and nowhere else in the codebase, and it is only ever handed to
 * the provider instance — it never reaches a DTO, a log line or a response body.
 */
function build(name: AiProviderName | 'none', modelOverride: string | undefined, config: ConfigService<Env, true>): AiProvider | null {
  if (name === 'none') return null;
  const timeoutMs = config.get('AI_REQUEST_TIMEOUT_MS', { infer: true });
  const maxOutputTokens = config.get('AI_MAX_OUTPUT_TOKENS', { infer: true });
  const explanationModel = modelOverride ?? DEFAULT_MODELS[name].explanation;

  if (name === 'gemini') {
    const apiKey = config.get('GEMINI_API_KEY', { infer: true });
    // Unreachable: the env schema rejects gemini without a key. Guarded so a future
    // configuration path cannot produce a provider that sends an empty credential.
    if (!apiKey) return null;
    return new GeminiProvider({
      apiKey,
      explanationModel,
      embeddingModel: config.get('AI_EMBEDDING_MODEL', { infer: true }) ?? DEFAULT_MODELS.gemini.embedding,
      embeddingDimensions: config.get('AI_EMBEDDING_DIMENSIONS', { infer: true }),
      imageModel: config.get('AI_IMAGE_MODEL', { infer: true }) ?? null,
      timeoutMs,
      maxOutputTokens,
    });
  }

  const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
  if (!apiKey) return null;
  return new ClaudeProvider({ apiKey, explanationModel, timeoutMs, maxOutputTokens });
}

const primary: Provider = {
  provide: AI_PRIMARY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    build(config.get('AI_PROVIDER', { infer: true }), config.get('AI_EXPLANATION_MODEL', { infer: true }), config),
};

const fallback: Provider = {
  provide: AI_FALLBACK_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    build(config.get('AI_FALLBACK_PROVIDER', { infer: true }), config.get('AI_FALLBACK_MODEL', { infer: true }), config),
};

/**
 * The AI boundary as a module: everything downstream injects `AiService` and never a
 * concrete provider, so a test can replace either slot and production can switch provider
 * with one environment variable.
 */
@Module({
  providers: [primary, fallback, AiService],
  exports: [AiService],
})
export class AiModule {}

export { build as buildAiProvider };
