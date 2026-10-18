/**
 * Splitting published theory into retrieval chunks.
 *
 * The requirements ask for chunks of roughly 500-800 tokens. The unit the existing schema
 * embeds is the published `content_blocks` row (`block_embeddings.block_id`, unique per block
 * and model), and most authored blocks are already well inside that range — so a block is a
 * chunk, and this module only has work to do at the two edges: a block longer than
 * `max_tokens` is split on paragraph then sentence boundaries, and a run of very short
 * blocks (a heading, a one-line formula) is merged so the model is not handed fragments.
 *
 * Splitting happens here rather than in the database because a chunk has no identity of its
 * own: grounding is recorded as `explanations.grounding_block_ids`, i.e. against the block a
 * chunk came from, which is what an admin needs in order to check the citation. Chunk-level
 * embeddings would need a `theory_chunks` table and a change to `block_embeddings`; that is
 * noted as a deviation in docs/DECISIONS.md rather than added speculatively.
 *
 * Pure: no database, no configuration reading, no thresholds of its own.
 */

export interface ChunkSource {
  blockId: string;
  title: string | null;
  text: string;
  /** Order within the sub-topic, so merged chunks stay in reading order. */
  sortOrder: number;
}

export interface TheoryChunk {
  blockId: string;
  /** 0-based position within the source block. A block that fits is chunk 0. */
  chunkIndex: number;
  title: string | null;
  text: string;
  tokenEstimate: number;
  /** Block ids merged into this chunk, including the primary one. */
  blockIds: string[];
}

export interface ChunkLimits {
  minTokens: number;
  maxTokens: number;
}

/**
 * Tokens, estimated without a tokeniser.
 *
 * ~4 characters per token is the usual English approximation, but scientific notes are dense
 * with symbols and short identifiers, so word count is the better lower bound. Taking the
 * larger of the two keeps the estimate conservative: chunks come out at or below the
 * configured ceiling for both providers rather than overflowing one of them.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const byChars = Math.ceil(trimmed.length / 4);
  const byWords = trimmed.split(/\s+/).length;
  return Math.max(byChars, byWords);
}

/** Chunks one block, splitting it only when it exceeds `maxTokens`. */
export function chunkBlock(source: ChunkSource, limits: ChunkLimits): TheoryChunk[] {
  const whole = source.text.trim();
  if (whole.length === 0) return [];
  if (estimateTokens(whole) <= limits.maxTokens) {
    return [{ blockId: source.blockId, chunkIndex: 0, title: source.title, text: whole, tokenEstimate: estimateTokens(whole), blockIds: [source.blockId] }];
  }

  const pieces = splitToBudget(whole, limits.maxTokens);
  return pieces.map((text, index) => ({
    blockId: source.blockId,
    chunkIndex: index,
    // Every piece keeps the block's title so a chunk read on its own still has its heading.
    title: source.title,
    text,
    tokenEstimate: estimateTokens(text),
    blockIds: [source.blockId],
  }));
}

/**
 * Chunks a sub-topic's blocks in reading order, merging consecutive short blocks up to
 * `minTokens` so a heading and the paragraph under it travel together.
 */
export function chunkBlocks(sources: readonly ChunkSource[], limits: ChunkLimits): TheoryChunk[] {
  const ordered = [...sources].sort((a, b) => a.sortOrder - b.sortOrder || a.blockId.localeCompare(b.blockId));
  const out: TheoryChunk[] = [];

  for (const source of ordered) {
    const chunks = chunkBlock(source, limits);
    if (chunks.length === 0) continue;
    const first = chunks[0]!;
    const previous = out[out.length - 1];

    // Merge only when the previous chunk is genuinely short, this block also is, and the two
    // together still fit. A split block never merges: its pieces are already at the ceiling.
    const mergeable =
      previous !== undefined &&
      chunks.length === 1 &&
      previous.tokenEstimate < limits.minTokens &&
      previous.tokenEstimate + first.tokenEstimate <= limits.maxTokens;

    if (mergeable && previous) {
      previous.text = `${previous.text}\n\n${first.text}`;
      previous.tokenEstimate = estimateTokens(previous.text);
      previous.title = previous.title ?? first.title;
      previous.blockIds = [...new Set([...previous.blockIds, first.blockId])];
      continue;
    }
    out.push(...chunks);
  }
  return out;
}

/**
 * Splits text into pieces of at most `maxTokens`, preferring paragraph breaks, then sentence
 * ends, and only cutting mid-sentence when a single sentence is itself over budget.
 */
function splitToBudget(text: string, maxTokens: number): string[] {
  const units = paragraphs(text).flatMap((p) => (estimateTokens(p) <= maxTokens ? [p] : sentences(p)));
  const out: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) out.push(trimmed);
    current = '';
  };

  for (const unit of units) {
    if (estimateTokens(unit) > maxTokens) {
      flush();
      out.push(...hardWrap(unit, maxTokens));
      continue;
    }
    const joined = current.length === 0 ? unit : `${current}\n\n${unit}`;
    if (estimateTokens(joined) > maxTokens) {
      flush();
      current = unit;
    } else {
      current = joined;
    }
  }
  flush();
  return out;
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Sentence ends: `.`, `!` or `?` followed by whitespace. Good enough for prose notes. */
function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Last resort for one over-long sentence: fill pieces word by word, up to the budget.
 *
 * It budgets with `estimateTokens` itself rather than assuming four characters per token.
 * Notes full of short tokens — `x`, `dx`, `= 0` — have more words than characters÷4, so a
 * character-only budget would hand back pieces above the ceiling this module promises to
 * respect. A single word longer than the whole budget (a pasted identifier, a base64 blob)
 * is cut on characters, since there is no boundary inside it to prefer.
 */
function hardWrap(text: string, maxTokens: number): string[] {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  const charBudget = maxTokens * 4;
  const out: string[] = [];
  let current: string[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length > 0) out.push(current.join(' '));
    current = [];
    chars = 0;
  };

  for (const word of words) {
    if (current.length === 0 && word.length > charBudget) {
      for (let i = 0; i < word.length; i += charBudget) out.push(word.slice(i, i + charBudget));
      continue;
    }
    const withSpace = current.length === 0 ? word.length : word.length + 1;
    const wouldBe = Math.max(Math.ceil((chars + withSpace) / 4), current.length + 1);
    if (current.length > 0 && wouldBe > maxTokens) flush();
    chars += current.length === 0 ? word.length : word.length + 1;
    current.push(word);
  }
  flush();
  return out;
}
