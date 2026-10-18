import { createHash } from 'node:crypto';
import { chunkBlocks, estimateTokens, type ChunkLimits, type TheoryChunk } from '../explanations/chunking';

/**
 * The published theory a learning-AI feature works from, and the bookkeeping that makes it cacheable.
 *
 * Pure. The repository loads blocks; this module hashes them (the content half of every cache key),
 * chunks them with the explanation system's own chunker, and packs chunks into bounded batches so no
 * single prompt ever carries a whole textbook.
 */
export interface SourceBlock {
  blockId: string;
  title: string | null;
  text: string;
  /** `content_blocks.content_hash`: changes whenever the block's text does. */
  contentHash: string;
  /** Reading order across the whole scope (subject → chapter → topic → sub-topic → block). */
  sortOrder: number;
}

/**
 * sha256 over the sorted (block id, content hash) pairs.
 *
 * Adding, removing or editing any source block changes it, so a cache keyed on it can never serve
 * notes written from notes that no longer exist. Order-independent, so re-sorting a syllabus does not
 * invalidate anything.
 */
export function sourceHash(blocks: readonly Pick<SourceBlock, 'blockId' | 'contentHash'>[]): string {
  const pairs = blocks.map((b) => `${b.blockId}:${b.contentHash}`).sort();
  return createHash('sha256').update(pairs.join('\n')).digest('hex');
}

/** Chunks in reading order, using the same limits the explanation retrieval uses. */
export function chunkSources(blocks: readonly SourceBlock[], limits: ChunkLimits): TheoryChunk[] {
  return chunkBlocks(
    blocks.map((b) => ({ blockId: b.blockId, title: b.title, text: b.text, sortOrder: b.sortOrder })),
    limits,
  );
}

/**
 * Packs chunks into batches of at most `maxTokens` each, preserving reading order.
 *
 * Returns null when the content needs more than `maxBatches` batches: the caller refuses the request
 * (`SCOPE_TOO_LARGE`) rather than silently summarising only the first part of a scope.
 */
export function packBatches(chunks: readonly TheoryChunk[], maxTokens: number, maxBatches: number): TheoryChunk[][] | null {
  const batches: TheoryChunk[][] = [];
  let current: TheoryChunk[] = [];
  let tokens = 0;
  for (const chunk of chunks) {
    const size = chunk.tokenEstimate || estimateTokens(chunk.text);
    if (current.length > 0 && tokens + size > maxTokens) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(chunk);
    tokens += size;
  }
  if (current.length > 0) batches.push(current);
  return batches.length > maxBatches ? null : batches;
}
