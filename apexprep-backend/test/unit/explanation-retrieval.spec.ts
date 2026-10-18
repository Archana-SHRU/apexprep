import { chunkBlock, chunkBlocks, estimateTokens, type ChunkSource } from '../../src/explanations/chunking';
import { fuse, rank, selectChunks, type RetrievalCandidate, type RetrievalScope } from '../../src/explanations/retrieval';
import { explanationParams } from '../fixtures/engine-params';

const params = explanationParams();
const limits = { minTokens: params.explanation.chunk.min_tokens, maxTokens: params.explanation.chunk.max_tokens };

/**
 * Filler whose token estimate is about `words`: short words keep the character count near
 * four per token, so `estimateTokens` comes out close to the word count and a test can aim
 * at a size relative to the configured 500-800 range.
 */
const filler = (words: number): string => Array.from({ length: words }, (_, i) => `w${i % 90}`).join(' ');

describe('splitting theory into retrieval chunks', () => {
  const source = (patch: Partial<ChunkSource> = {}): ChunkSource => ({
    blockId: 'b1',
    title: 'Angular momentum',
    text: 'Short note.',
    sortOrder: 0,
    ...patch,
  });

  it('estimates tokens conservatively, taking the larger of the character and word counts', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('one two three')).toBe(Math.max(Math.ceil(13 / 4), 3));
    // Symbol-dense text: characters dominate, which is what keeps chunks under a provider's cap.
    expect(estimateTokens('a=b+c/d*e^f')).toBe(3);
  });

  it('leaves a block that already fits as a single chunk', () => {
    const text = filler(600);
    expect(estimateTokens(text)).toBeLessThanOrEqual(limits.maxTokens); // precondition of this test
    const chunks = chunkBlock(source({ text }), limits);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ blockId: 'b1', chunkIndex: 0, blockIds: ['b1'] });
  });

  it('splits a block over the ceiling, and every piece stays within it', () => {
    const paragraphs = Array.from({ length: 6 }, () => filler(300)).join('\n\n');
    const chunks = chunkBlock(source({ text: paragraphs }), limits);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenEstimate).toBeLessThanOrEqual(limits.maxTokens);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // Each piece keeps the heading, so a chunk read alone still has its title.
    expect(chunks.every((c) => c.title === 'Angular momentum')).toBe(true);
  });

  it('prefers paragraph boundaries, then sentences, and only cuts mid-sentence as a last resort', () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} ${filler(120)}.`).join(' ');
    const chunks = chunkBlock(source({ text: sentences }), limits);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenEstimate).toBeLessThanOrEqual(limits.maxTokens);

    const oneLongSentence = filler(3000);
    const wrapped = chunkBlock(source({ text: oneLongSentence }), limits);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const chunk of wrapped) expect(chunk.tokenEstimate).toBeLessThanOrEqual(limits.maxTokens);
  });

  it('respects the ceiling for short-token text, where words outnumber characters over four', () => {
    // Notes full of symbols and one-letter variables: the word count, not the character
    // count, is what decides the estimate, and the last-resort wrap has to honour that.
    const symbols = Array.from({ length: 4000 }, (_, i) => (i % 3 === 0 ? 'x' : i % 3 === 1 ? '=' : 'dx')).join(' ');
    const chunks = chunkBlock(source({ text: symbols }), limits);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenEstimate).toBeLessThanOrEqual(limits.maxTokens);
  });

  it('cuts a single word longer than the whole budget rather than overflowing', () => {
    const blob = 'A'.repeat(limits.maxTokens * 4 * 3);
    const chunks = chunkBlock(source({ text: blob }), limits);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenEstimate).toBeLessThanOrEqual(limits.maxTokens);
  });

  it('merges a run of short blocks so a heading travels with its paragraph', () => {
    const chunks = chunkBlocks(
      [source({ blockId: 'b1', text: 'Rolling without slipping', sortOrder: 0 }), source({ blockId: 'b2', text: filler(40), sortOrder: 1 })],
      limits,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.blockIds).toEqual(['b1', 'b2']);
    expect(chunks[0]!.text).toContain('Rolling without slipping');
  });

  it('does not merge into a block that was split: its pieces are already at the ceiling', () => {
    const chunks = chunkBlocks(
      [source({ blockId: 'b1', text: Array.from({ length: 4 }, () => filler(400)).join('\n\n'), sortOrder: 0 }), source({ blockId: 'b2', text: 'Tiny.', sortOrder: 1 })],
      limits,
    );
    expect(chunks.at(-1)!.blockIds).toEqual(['b2']);
  });

  it('keeps blocks in reading order', () => {
    // Each block is inside 500-800 tokens, so neither is split nor merged into its neighbour.
    const chunks = chunkBlocks(
      [source({ blockId: 'b2', text: filler(600), sortOrder: 5 }), source({ blockId: 'b1', text: filler(600), sortOrder: 1 })],
      limits,
    );
    expect(chunks.map((c) => c.blockId)).toEqual(['b1', 'b2']);
  });

  it('drops an empty block rather than sending a blank chunk', () => {
    expect(chunkBlocks([source({ text: '   ' })], limits)).toEqual([]);
  });
});

describe('ranking and the widening ladder', () => {
  const candidate = (
    blockId: string,
    scope: RetrievalScope,
    scores: { vector?: number | null; keyword?: number } = {},
  ): RetrievalCandidate => ({
    chunk: { blockId, chunkIndex: 0, title: null, text: `notes ${blockId}`, tokenEstimate: 5, blockIds: [blockId] },
    scope,
    vectorScore: scores.vector ?? null,
    keywordScore: scores.keyword ?? 0.5,
  });

  it('fuses the two scores by the configured weight', () => {
    const fused = fuse(candidate('b1', 'subtopic', { vector: 1, keyword: 0 }), params);
    expect(fused.score).toBeCloseTo(params.explanation.retrieval.vector_weight, 6);
    expect(fused.semantic).toBe(true);
  });

  it('gives the keyword score the whole weight when there is no vector, rather than scoring it zero', () => {
    const fused = fuse(candidate('b1', 'subtopic', { vector: null, keyword: 0.8 }), params);
    expect(fused.score).toBe(0.8);
    expect(fused.semantic).toBe(false);
  });

  it('ranks by score, breaking ties reproducibly', () => {
    const ranked = rank([
      fuse(candidate('b2', 'subtopic', { keyword: 0.5 }), params),
      fuse(candidate('b1', 'subtopic', { keyword: 0.5 }), params),
      fuse(candidate('b3', 'subtopic', { keyword: 0.9 }), params),
    ]);
    expect(ranked.map((c) => c.chunk.blockId)).toEqual(['b3', 'b1', 'b2']);
  });

  it('stops at the sub-topic when it has enough', () => {
    const result = selectChunks(
      { subtopic: [candidate('a', 'subtopic'), candidate('b', 'subtopic'), candidate('c', 'subtopic')], topic: [candidate('z', 'topic')] },
      params,
    );
    expect(result.scope).toBe('subtopic');
    expect(result.selected.map((c) => c.chunk.blockId).sort()).toEqual(['a', 'b', 'c']);
    expect(result.trail).toEqual([{ scope: 'subtopic', eligible: 3, widenedBecause: null }]);
  });

  it('widens to the topic, then the chapter, and says why each time', () => {
    const result = selectChunks(
      { subtopic: [candidate('a', 'subtopic')], topic: [candidate('b', 'topic')], chapter: [candidate('c', 'chapter')] },
      params,
    );
    expect(result.scope).toBe('chapter');
    expect(result.trail.map((t) => t.scope)).toEqual(['subtopic', 'topic', 'chapter']);
    expect(result.trail[0]!.widenedBecause).toMatch(/only 1 of 3 chunks/);
    expect(result.trail[1]!.widenedBecause).toMatch(/only 2 of 3 chunks/);
    expect(result.trail[2]!.widenedBecause).toBeNull();
  });

  it('records how far it actually reached, not how far it looked', () => {
    // Two sub-topic chunks against a minimum of three: the ladder walks out to the chapter
    // looking for a third, finds nothing, and the selection is still purely sub-topic notes.
    const result = selectChunks({ subtopic: [candidate('a', 'subtopic'), candidate('b', 'subtopic')] }, params);
    expect(result.selected.map((c) => c.chunk.blockId).sort()).toEqual(['a', 'b']);
    expect(result.scope).toBe('subtopic');
    expect(result.trail.map((t) => t.scope)).toEqual(['subtopic', 'topic', 'chapter']);
  });

  it('keeps the narrower notes when it widens: they are still the most relevant', () => {
    const result = selectChunks(
      { subtopic: [candidate('near', 'subtopic', { keyword: 0.2 })], topic: [candidate('far', 'topic', { keyword: 0.9 })], chapter: [candidate('further', 'chapter')] },
      params,
    );
    expect(result.selected.map((c) => c.chunk.blockId)).toContain('near');
    expect(result.selected).toHaveLength(3);
  });

  it('never lets similarity decide the scope: a strong chapter hit does not pre-empt the sub-topic', () => {
    const result = selectChunks(
      {
        subtopic: [candidate('s1', 'subtopic', { keyword: 0.3 }), candidate('s2', 'subtopic', { keyword: 0.3 }), candidate('s3', 'subtopic', { keyword: 0.3 })],
        chapter: [candidate('c1', 'chapter', { keyword: 1 })],
      },
      params,
    );
    expect(result.scope).toBe('subtopic');
    expect(result.selected.map((c) => c.chunk.blockId)).not.toContain('c1');
  });

  it('drops candidates below the score floor', () => {
    const result = selectChunks({ subtopic: [candidate('a', 'subtopic', { keyword: 0 }), candidate('b', 'subtopic', { keyword: 0.6 })] }, params);
    expect(result.selected.map((c) => c.chunk.blockId)).toEqual(['b']);
  });

  it('reports exhaustion when nothing anywhere clears the floor', () => {
    const result = selectChunks({ subtopic: [candidate('a', 'subtopic', { keyword: 0 })] }, params);
    expect(result.exhausted).toBe(true);
    expect(result.selected).toEqual([]);
  });

  it('reports exhaustion when there is no theory at all, having tried every scope', () => {
    const result = selectChunks({}, params);
    expect(result).toMatchObject({ exhausted: true, selected: [] });
    expect(result.trail.map((t) => t.scope)).toEqual(['subtopic', 'topic', 'chapter']);
    expect(result.scope).toBe('chapter');
  });

  it('never returns more than top_k', () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`b${i}`, 'subtopic', { keyword: 0.9 }));
    expect(selectChunks({ subtopic: many }, params).selected).toHaveLength(params.rag.top_k);
  });

  it('does not count the same chunk twice when scopes overlap', () => {
    const result = selectChunks({ subtopic: [candidate('a', 'subtopic')], topic: [candidate('a', 'topic'), candidate('b', 'topic')] }, params);
    expect(result.selected.map((c) => c.chunk.blockId).sort()).toEqual(['a', 'b']);
  });

  it('marks the selection semantic only when a chosen candidate carried a vector score', () => {
    expect(selectChunks({ subtopic: [candidate('a', 'subtopic', { vector: 0.9 })] }, params).semanticUsed).toBe(true);
    expect(selectChunks({ subtopic: [candidate('a', 'subtopic', { vector: null })] }, params).semanticUsed).toBe(false);
  });

  it('follows a configured ladder that stops at the topic', () => {
    const shallow = explanationParams({ rag: { widen_order: ['subtopic', 'topic'] } });
    const result = selectChunks({ subtopic: [candidate('a', 'subtopic')], topic: [candidate('b', 'topic')], chapter: [candidate('c', 'chapter')] }, shallow);
    expect(result.scope).toBe('topic');
    expect(result.selected.map((c) => c.chunk.blockId).sort()).toEqual(['a', 'b']);
  });
});
