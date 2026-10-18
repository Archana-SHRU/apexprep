import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { chunkBlocks } from './chunking';
import type { ExplanationParams } from './explanation-params';
import { ExplanationsRepository, type ThreadedCandidate } from './explanations.repository';
import { selectChunks, type RetrievalCandidate, type RetrievalResult, type RetrievalScope } from './retrieval';

/** Where retrieval starts, and the two levels it may widen to. */
export interface RetrievalAnchor {
  subtopicId: string;
  topicId: string;
  chapterId: string;
}

export type Retrieval = RetrievalResult & { semanticSkippedBecause: string | null };

/**
 * Theory retrieval, shared by everything that grounds AI output in the course's own notes: explanations,
 * the tutor, visual explanations and question generation.
 *
 * It was the private `retrieve` of `ExplanationsService`, moved here unchanged so the other features use
 * the same rules rather than a second copy of them: the syllabus scope is a **hard filter** (sub-topic
 * first, widening along `rag.widen_order` only when too little clears the score floor), both halves of the
 * hybrid search run per scope, and when semantic search cannot run that is recorded, never hidden.
 */
@Injectable()
export class TheoryRetrievalService {
  private readonly logger = new Logger(TheoryRetrievalService.name);

  constructor(
    private readonly repo: ExplanationsRepository,
    private readonly ai: AiService,
  ) {}

  async retrieve(tenantId: string, anchor: RetrievalAnchor, queryText: string, params: ExplanationParams): Promise<Retrieval> {
    const perScope: Partial<Record<RetrievalScope, RetrievalCandidate[]>> = {};
    const limits = { minTokens: params.explanation.chunk.min_tokens, maxTokens: params.explanation.chunk.max_tokens };
    const fetchLimit = Math.max(params.rag.top_k * 2, params.explanation.retrieval.min_chunks * 2);

    const embedding = await this.queryEmbedding(queryText);
    const notes: string[] = [];
    if (!embedding) notes.push(this.ai.embeddingProvider() ? 'pgvector unavailable on this server' : 'no embedding provider configured');

    const seenBlocks: string[] = [];
    for (const level of params.rag.widen_order) {
      const keyword = await this.repo.keywordCandidates(tenantId, { level, ...anchor }, queryText, fetchLimit, seenBlocks);
      const vector = embedding ? await this.repo.vectorCandidates(tenantId, { level, ...anchor }, embedding.vector, embedding.model, fetchLimit) : [];
      const merged = mergeByBlock(keyword, vector);
      seenBlocks.push(...merged.map((m) => m.blockId));

      perScope[level] = merged.flatMap((block) =>
        chunkBlocks([{ blockId: block.blockId, title: block.title, text: block.text, sortOrder: block.sortOrder }], limits).map((chunk) => ({
          chunk,
          scope: level,
          vectorScore: block.vectorScore,
          keywordScore: block.keywordScore,
        })),
      );
    }

    const result = selectChunks(perScope, params);
    return { ...result, semanticSkippedBecause: notes.length > 0 ? notes.join('; ') : null };
  }

  /** The query's embedding, or null when semantic retrieval cannot run on this server. */
  private async queryEmbedding(queryText: string): Promise<{ vector: number[]; model: string } | null> {
    if (!(await this.repo.semanticAvailable())) return null;
    if (!this.ai.embeddingProvider()) return null;
    try {
      const result = await this.ai.embed([queryText]);
      const vector = result.vectors[0];
      // `block_embeddings` only stores, and the vector query only casts, 64-4000 dimensions (0007).
      // An embedding outside that range cannot be searched with; asking would throw inside the query
      // and turn a degraded search into a failed request.
      if (vector && (vector.length < 64 || vector.length > 4000)) {
        this.logger.warn(`the query embedding has ${vector.length} dimensions, outside 64-4000; keyword-only retrieval`);
        return null;
      }
      return vector ? { vector, model: result.model } : null;
    } catch (error) {
      // Retrieval still works on keywords, so a failed embedding degrades the search rather
      // than the request. It is recorded in the diagnostics, never hidden.
      this.logger.warn(`embedding the query failed; keyword-only retrieval: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }
}

/** Keyword and vector hits for the same block become one candidate carrying both scores. */
function mergeByBlock(keyword: ThreadedCandidate[], vector: ThreadedCandidate[]): ThreadedCandidate[] {
  const byId = new Map<string, ThreadedCandidate>();
  for (const candidate of keyword) byId.set(candidate.blockId, { ...candidate });
  for (const candidate of vector) {
    const existing = byId.get(candidate.blockId);
    if (existing) existing.vectorScore = candidate.vectorScore;
    else byId.set(candidate.blockId, { ...candidate });
  }
  return [...byId.values()];
}
