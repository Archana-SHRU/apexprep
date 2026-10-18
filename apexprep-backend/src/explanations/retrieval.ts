import type { TheoryChunk } from './chunking';
import type { ExplanationParams } from './explanation-params';

/**
 * Choosing which theory reaches the model.
 *
 * The requirements set the order: hard-filter to the question's sub-topic first, and only
 * widen to the parent topic and then the chapter when there is not enough. That order is a
 * correctness rule, not an optimisation — semantic similarity alone will happily return
 * thermodynamics notes for a rotational-dynamics question, and an explanation grounded in the
 * wrong chapter is worse than one that admits it has no notes. So similarity never decides
 * *scope*; it only ranks within the scope the ladder has reached.
 *
 * Pure: the caller runs the queries and passes candidates in. Every threshold arrives in
 * `ExplanationParams`.
 */

export type RetrievalScope = 'subtopic' | 'topic' | 'chapter';

export interface RetrievalCandidate {
  chunk: TheoryChunk;
  /** Which level of the ladder this candidate was found at. */
  scope: RetrievalScope;
  /**
   * Cosine similarity in [0,1] from pgvector, or null when semantic search did not run
   * (no embedding for this block, or the extension is unavailable on this server).
   */
  vectorScore: number | null;
  /** Normalised `ts_rank_cd` in [0,1] from the block's `search_tsv`. */
  keywordScore: number;
}

export interface ScoredCandidate extends RetrievalCandidate {
  /** The hybrid score this candidate was ranked by. */
  score: number;
  /** False when this candidate had no vector score and was ranked on keywords alone. */
  semantic: boolean;
}

export interface RetrievalResult {
  selected: ScoredCandidate[];
  /**
   * How far retrieval actually had to reach: the widest scope any *selected* chunk came from,
   * which is what `explanations.retrieval_scope` records. Not the last scope the ladder tried
   * — a sub-topic with two blocks sends the ladder out to the chapter looking for a third, and
   * reporting 'chapter' there would say the explanation rested on chapter-wide notes when every
   * chunk it used was the sub-topic's own. `trail` keeps the full story of what was tried.
   * With nothing selected at all, this is the last scope tried.
   */
  scope: RetrievalScope;
  /** Every scope tried, in order, with why the ladder moved on. */
  trail: { scope: RetrievalScope; eligible: number; widenedBecause: string | null }[];
  /** True when at least one selected candidate carried a vector score. */
  semanticUsed: boolean;
  /** Nothing at any scope cleared the score floor. */
  exhausted: boolean;
}

/**
 * The hybrid score: `vector_weight` of semantic similarity plus the remainder of keyword
 * rank. When a candidate has no vector score the keyword score carries the whole weight —
 * rescaling rather than treating a missing vector as a similarity of zero, which would bury
 * a block that matches the question's terms exactly.
 */
export function fuse(candidate: RetrievalCandidate, params: ExplanationParams): ScoredCandidate {
  const weight = params.explanation.retrieval.vector_weight;
  const semantic = candidate.vectorScore !== null;
  const score = semantic ? weight * candidate.vectorScore! + (1 - weight) * candidate.keywordScore : candidate.keywordScore;
  return { ...candidate, score, semantic };
}

/** Highest score first; ties broken by block id then chunk index so a run is reproducible. */
export function rank(candidates: readonly ScoredCandidate[]): ScoredCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      a.chunk.blockId.localeCompare(b.chunk.blockId) ||
      a.chunk.chunkIndex - b.chunk.chunkIndex,
  );
}

/**
 * Walks the configured ladder and returns the first scope with enough usable chunks.
 *
 * `candidatesByScope` holds the candidates found *at* each scope — the caller queries each
 * level separately, so a sub-topic hit is never diluted by its chapter's other sub-topics.
 * Widening accumulates: reaching 'topic' keeps the sub-topic's own chunks and adds the rest of
 * the topic's, because the narrowest notes are still the most relevant ones.
 */
export function selectChunks(
  candidatesByScope: Partial<Record<RetrievalScope, readonly RetrievalCandidate[]>>,
  params: ExplanationParams,
): RetrievalResult {
  const { top_k: topK, widen_order: order } = params.rag;
  const { min_chunks: minChunks, min_candidate_score: floor } = params.explanation.retrieval;

  const trail: RetrievalResult['trail'] = [];
  const accumulated: ScoredCandidate[] = [];
  const seen = new Set<string>();
  let scope: RetrievalScope = order[0]!;

  for (const [index, level] of order.entries()) {
    scope = level;
    for (const candidate of candidatesByScope[level] ?? []) {
      const key = `${candidate.chunk.blockId}:${candidate.chunk.chunkIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accumulated.push(fuse(candidate, params));
    }
    const eligible = accumulated.filter((c) => c.score >= floor);
    const last = index === order.length - 1;
    const enough = eligible.length >= minChunks;

    trail.push({
      scope: level,
      eligible: eligible.length,
      widenedBecause: enough || last ? null : `only ${eligible.length} of ${minChunks} chunks cleared the score floor at ${level} level`,
    });
    if (enough) break;
  }

  const selected = rank(accumulated.filter((c) => c.score >= floor)).slice(0, topK);
  const reached = selected.reduce<RetrievalScope>(
    (widest, c) => (order.indexOf(c.scope) > order.indexOf(widest) ? c.scope : widest),
    selected[0]?.scope ?? scope,
  );
  return {
    selected,
    scope: selected.length === 0 ? scope : reached,
    trail,
    semanticUsed: selected.some((c) => c.semantic),
    exhausted: selected.length === 0,
  };
}
