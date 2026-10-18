/**
 * The AI boundary.
 *
 * Everything above this file — explanation resolution, grounding, validation — is written
 * against `AiProvider` and knows nothing about Gemini or Claude. Swapping or adding a
 * provider is a new class plus one line of configuration; no explanation logic changes.
 *
 * Two rules the implementations must hold to:
 *   1. **Nothing the model says is trusted.** A provider returns the parsed reply and
 *      nothing more; correctness, grounding and visibility are decided above it from the
 *      question's own answer key and the retrieved notes.
 *   2. **Failures are typed.** `AiProviderError` says whether another provider may be
 *      tried, so the dispatcher can fall back without guessing at error strings.
 */

export type AiProviderName = 'gemini' | 'claude';

/** Why a provider call failed. `retryable` decides whether a fallback provider is tried. */
export type AiFailureKind =
  /** Network, timeout, 5xx, or a 429 — another provider may succeed. */
  | 'unavailable'
  /** The provider rejected the credentials. A fallback may still be tried. */
  | 'unauthorized'
  /** The model replied, but not with the JSON shape the prompt requires. */
  | 'malformed_response'
  /** The request itself is wrong (too long, unsupported model). Retrying elsewhere will not help. */
  | 'bad_request'
  /** The provider refused to answer (safety filter). Not a transport problem. */
  | 'refused';

export class AiProviderError extends Error {
  constructor(
    readonly provider: AiProviderName,
    readonly kind: AiFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }

  /** Whether it is worth asking a different provider the same question. */
  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'unauthorized' || this.kind === 'malformed_response';
  }
}

// ---------------------------------------------------------------- explanations

/** One retrieved note the model may ground its answer in. */
export interface PromptChunk {
  /** The `content_blocks` row this text came from; cited back by the model. */
  blockId: string;
  /** 0-based index when a long block was split into chunks. */
  chunkIndex: number;
  title: string | null;
  text: string;
}

export interface ExplanationPrompt {
  /** 'grounded' must answer only from `chunks`; 'general' has none and says so. */
  mode: 'grounded' | 'general';
  questionType: string;
  stem: string;
  /** Option key → text, for option questions. The answer key is **not** included. */
  options: { key: string; text: string }[];
  /** Set when explaining why one particular wrong option is wrong. */
  distractorKey: string | null;
  subtopicName: string;
  chunks: PromptChunk[];
  /** Language of the reply; the platform is English-only today. */
  locale: 'en';
}

/**
 * The model's reply, after shape validation. `finalAnswer` exists so the answer-mismatch
 * check can grade it against the question's authoritative key — it is evidence about the
 * explanation's quality, never the answer served to anyone.
 */
export interface AiExplanation {
  summary: string;
  steps: string[];
  keyConcept: string | null;
  commonMistake: string | null;
  /** The answer the explanation argues for, in the same shape a student would submit. */
  finalAnswer: Record<string, unknown> | null;
  /** Block ids the model says it used. Metadata only: the grounding score is computed, not reported. */
  citedBlockIds: string[];
}

export interface AiExplanationResult {
  provider: AiProviderName;
  model: string;
  explanation: AiExplanation;
}

// ---------------------------------------------------------------- embeddings

export interface EmbeddingResult {
  provider: AiProviderName;
  model: string;
  dimensions: number;
  /** One vector per input text, in order. */
  vectors: number[][];
}

// ---------------------------------------------------------------- structured generation

/**
 * The learning features beyond explanations — revision notes, question generation, the tutor and
 * visual explanations — each need a JSON reply of their own shape. Rather than one provider method
 * per feature, a provider exposes one JSON-mode call and returns the raw text; **each feature parses
 * and validates that text itself** (zod schema plus its own domain checks), exactly as
 * `parseExplanationReply` does for explanations. So the provider stays a transport, and no feature
 * can receive an object it has not validated.
 */
export type StructuredTask =
  | 'revision_notes'
  | 'question_generation'
  | 'tutor'
  | 'visual'
  | 'syllabus_structure'
  | 'subject_detection'
  | 'content_understanding';

export interface StructuredRequest {
  task: StructuredTask;
  /** The full prompt text; built by the feature's own pure prompt builder. */
  prompt: string;
  /** Low for anything that must be faithful to source material. */
  temperature: number;
  /**
   * The output budget for this reply. Set per feature because the replies differ tenfold in size, and
   * because Gemini 2.5 counts its reasoning tokens against the same budget: the explanation default
   * would truncate a set of revision notes mid-object.
   */
  maxOutputTokens: number;
}

export interface StructuredResult {
  provider: AiProviderName;
  model: string;
  /** The model's reply, unparsed. Never trusted until the feature's parser accepts it. */
  text: string;
}

/** A generated raster image. Only produced when an image model is configured. */
export interface ImageResult {
  provider: AiProviderName;
  model: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Buffer;
}

export interface AiProvider {
  readonly name: AiProviderName;
  /** The explanation model this provider is configured to use. */
  readonly explanationModel: string;
  /** The embedding model, or null when this provider is not configured for embeddings. */
  readonly embeddingModel: string | null;
  /** The image model, or null when this provider will not generate images. */
  readonly imageModel: string | null;
  generateExplanation(prompt: ExplanationPrompt): Promise<AiExplanationResult>;
  embed(texts: string[]): Promise<EmbeddingResult>;
  /** One JSON-mode completion, returned as raw text for the caller to validate. */
  generateStructured(request: StructuredRequest): Promise<StructuredResult>;
  /** One image from a prompt. Rejects with `bad_request` when `imageModel` is null. */
  generateImage(prompt: string): Promise<ImageResult>;
}

/** DI token. The module binds it to the configured provider, or to nothing when AI is off. */
export const AI_PRIMARY_PROVIDER = Symbol('AI_PRIMARY_PROVIDER');
export const AI_FALLBACK_PROVIDER = Symbol('AI_FALLBACK_PROVIDER');
