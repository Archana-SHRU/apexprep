import {
  AiProviderError,
  type AiExplanation,
  type AiExplanationResult,
  type AiProvider,
  type EmbeddingResult,
  type ExplanationPrompt,
  type ImageResult,
  type StructuredRequest,
  type StructuredResult,
  type StructuredTask,
} from '../../src/ai/ai-provider';

const FAKE_EMBEDDING_DIMS = 64;

/**
 * A deterministic stand-in for Gemini or Claude.
 *
 * No AI credentials exist in the test environment, and inventing a successful external call
 * would prove nothing. So the explanation tests run the *whole* real path — controller,
 * guards, validation pipe, service, repository, PostgreSQL, the grounding formula, the answer
 * matcher, the visibility rules, the cache — and replace only the last hop, the provider that
 * would have gone over the network. `calls` is what proves the cache: a second request that
 * regenerates would show up here.
 */
export class FakeAiProvider implements AiProvider {
  readonly calls: ExplanationPrompt[] = [];
  readonly embedCalls: string[][] = [];
  /** Queued replies, consumed in order; the last one repeats once the queue is empty. */
  private replies: (AiExplanation | AiProviderError)[] = [];

  constructor(
    readonly name: 'gemini' | 'claude' = 'gemini',
    readonly explanationModel = 'fake-explain-1',
    readonly embeddingModel: string | null = 'fake-embed-1',
  ) {}

  /** What the next call (and every later call, unless more are queued) returns. */
  reply(...replies: (Partial<AiExplanation> | AiProviderError)[]): this {
    this.replies = replies.map((r) => (r instanceof AiProviderError ? r : { ...BASE_EXPLANATION, ...r }));
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.embedCalls.length = 0;
    this.replies = [];
    this.structuredCalls.length = 0;
    this.structured = new Map();
    this.imageCalls.length = 0;
    this.imageModel = null;
  }

  get callCount(): number {
    return this.calls.length;
  }

  generateExplanation(prompt: ExplanationPrompt): Promise<AiExplanationResult> {
    this.calls.push(prompt);
    const next = this.replies.length > 1 ? this.replies.shift()! : (this.replies[0] ?? { ...BASE_EXPLANATION });
    if (next instanceof AiProviderError) return Promise.reject(next);
    return Promise.resolve({ provider: this.name, model: this.explanationModel, explanation: next });
  }

  // ---------------------------------------------------------------- structured features

  /** Every structured request, so a test can prove a cache hit made no call. */
  readonly structuredCalls: StructuredRequest[] = [];
  private structured = new Map<StructuredTask, (string | AiProviderError)[]>();
  imageModel: string | null = null;
  readonly imageCalls: string[] = [];

  /**
   * Queues raw reply text for one feature, consumed in order; the last repeats. Raw text on purpose:
   * the feature's real parser and validators run on it, exactly as they would on a model's reply.
   */
  replyStructured(task: StructuredTask, ...replies: (string | object | AiProviderError)[]): this {
    this.structured.set(task, replies.map((r) => (typeof r === 'string' || r instanceof AiProviderError ? r : JSON.stringify(r))));
    return this;
  }

  structuredCallsFor(task: StructuredTask): StructuredRequest[] {
    return this.structuredCalls.filter((c) => c.task === task);
  }

  generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    this.structuredCalls.push(request);
    const queue = this.structured.get(request.task) ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) return Promise.reject(new AiProviderError(this.name, 'unavailable', `no fake reply queued for ${request.task}`));
    if (next instanceof AiProviderError) return Promise.reject(next);
    return Promise.resolve({ provider: this.name, model: this.explanationModel, text: next });
  }

  generateImage(prompt: string): Promise<ImageResult> {
    this.imageCalls.push(prompt);
    if (!this.imageModel) return Promise.reject(new AiProviderError(this.name, 'bad_request', 'no image model'));
    return Promise.resolve({ provider: this.name, model: this.imageModel, mimeType: 'image/png', bytes: Buffer.from('fake-png-bytes') });
  }

  embed(texts: string[]): Promise<EmbeddingResult> {
    this.embedCalls.push(texts);
    if (this.embeddingModel === null) return Promise.reject(new AiProviderError(this.name, 'bad_request', 'this provider cannot embed'));
    return Promise.resolve({
      provider: this.name,
      model: this.embeddingModel,
      dimensions: FAKE_EMBEDDING_DIMS,
      // Deterministic pseudo-vectors: identical text always embeds identically, which is all
      // the retrieval code needs from them. 64 dimensions, the smallest `block_embeddings` stores
      // (0007), so on a server with pgvector the vector half of retrieval really runs.
      vectors: texts.map((t) => Array.from({ length: FAKE_EMBEDDING_DIMS }, (_, i) => ((t.length + i * 7) % 13) / 13)),
    });
  }
}

/**
 * The default reply, written so that **every** claim term it adds beyond the question stem
 * appears in the theory the tests publish. That is what makes the grounding score in those
 * tests earned rather than stubbed: the formula is the real one, run over real text.
 */
const BASE_EXPLANATION: AiExplanation = {
  summary: 'Taking torque about the contact point, friction acts there, so angular momentum is conserved throughout the motion.',
  steps: ['Friction acts at the contact point, so its moment is zero.', 'Solve the conservation equation to obtain omega.'],
  keyConcept: 'Conservation of angular momentum',
  commonMistake: null,
  finalAnswer: { optionKeys: ['A'] },
  citedBlockIds: [],
};

/** The base reply, for a test that wants to vary one field. */
export const FAKE_EXPLANATION = BASE_EXPLANATION;
