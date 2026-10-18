/**
 * Reading the syllabus hierarchy a PDF prints, and matching it against the existing syllabus.
 *
 * Two jobs, both pure (no database, no configuration, no clock):
 *
 *   1. **Detection.** Textbooks announce their structure with headings: "3 Motion", "3.1 Distance and
 *      Displacement", "3.1.1 Average Speed", "Chapter 4: Gravitation". Those are evidence the document
 *      itself supplies, so they are read deterministically. Every name that comes out of here is a
 *      heading line from the PDF — nothing is inferred from general knowledge, and a level the
 *      document gives no evidence for is left `null` (unresolved) rather than filled in.
 *   2. **Matching.** A detected path is matched level by level inside the uploaded subject only:
 *      chapters of that subject, topics of the matched chapter, sub-topics of the matched topic.
 *      Exact name first, then near-exact, then word overlap; below the reuse floor a level is
 *      reported as new — a *suggestion*, which this module never turns into a node.
 *
 * Unnumbered title lines are not promoted to chapters. They count only under an explicit
 * "Chapter N" heading (as topics, with lower confidence), because a lone bold line could be anything:
 * a chapter, a box title, a figure caption. A document with no numbered or keyword structure is
 * reported as insufficient, and the caller decides whether to ask a model to pick among its heading
 * lines (see `buildHeadingPrompt`) or to send it to review.
 */

export type Level = 'chapter' | 'topic' | 'subtopic';
export const LEVELS: readonly Level[] = ['chapter', 'topic', 'subtopic'];
export type DetectionMethod = 'numbered' | 'keyword' | 'title' | 'ai';

/** A segmented block, as much of it as detection needs. */
export interface HierarchyBlock {
  index: number;
  kind: string;
  format: string;
  title: string | null;
  text: string;
  page: number;
}

export interface HeadingHit {
  level: Level;
  /** The heading's name as printed, with its number and keyword stripped. */
  name: string;
  /** "3.1.1", "4", "IV" — or null for an unnumbered heading. */
  number: string | null;
  /** The whole line, as evidence. */
  line: string;
  page: number;
  blockIndex: number;
  /** Line of the block the heading is on. */
  lineIndex: number;
  /**
   * True when only headings come before it in its block: the block's content sits under it. A heading
   * further down a block moves the position for the blocks after it, not for the block it is in.
   */
  leading: boolean;
  confidence: number;
  method: DetectionMethod;
}

export interface DetectedLevel {
  name: string;
  number: string | null;
  evidence: string;
  page: number;
  confidence: number;
  method: DetectionMethod;
}

export interface DetectedPath {
  /** Normalised chapter|topic|sub-topic names; '' for an unresolved level. */
  key: string;
  chapter: DetectedLevel | null;
  topic: DetectedLevel | null;
  subtopic: DetectedLevel | null;
  blockIndexes: number[];
  /** The weakest detected level's confidence. */
  confidence: number;
}

export interface HierarchyDetection {
  method: DetectionMethod | 'none';
  /** True when the document's own structure is strong enough to propose a hierarchy from. */
  sufficient: boolean;
  headings: HeadingHit[];
  paths: DetectedPath[];
  /** Path key for each block index, or null for a block before any heading. */
  blockPath: (string | null)[];
  notes: string[];
}

// ---------------------------------------------------------------- normalisation and grounding

/** Lowercase, Unicode-normalised, punctuation to spaces, `&` spelled out, whitespace collapsed. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A heading's identity: its words, without a leading "Chapter 3"/"3.1"/"Unit IV" label. */
export function normalizeName(name: string): string {
  const stripped = name
    .trim()
    .replace(/^(?:chapter|unit|lesson|part|topic|sub-?topic|section)\s+(?:\d+(?:\.\d+)*|[ivxlcdm]+)\b\s*[:.)\-–—]?\s*/i, '')
    .replace(/^\d+(?:\.\d+)*\s*[.):\-–—]?\s+/, '');
  return normalizeText(stripped);
}

/**
 * Whether a name is supported by the document: its normalised words appear, in order and as whole
 * words, in the normalised text of the PDF. This is the check that stops a model — or an admin's edit
 * — from introducing a syllabus name the uploaded content does not contain.
 */
export function isGrounded(name: string, documentText: string): boolean {
  const needle = normalizeName(name);
  if (needle.length < 2) return false;
  return ` ${normalizeText(documentText)} `.includes(` ${needle} `);
}

// ---------------------------------------------------------------- detection

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,2})(\.?)\s+(.+)$/;
const CHAPTER_KEYWORD = /^(?:chapter|unit|lesson)\s+(\d{1,3}|[ivxlcdm]{1,7})\b\s*[:.\-–—]?\s*(.*)$/i;
const TOPIC_KEYWORD = /^topic\s+(\d{1,2}(?:\.\d{1,2})*)\b\s*[:.\-–—]?\s*(.+)$/i;
const SUBTOPIC_KEYWORD = /^sub-?topic\s+(\d{1,2}(?:\.\d{1,2})*)\b\s*[:.\-–—]?\s*(.+)$/i;

/**
 * A line that announces a new section on its own evidence: "3.1 Distance and Displacement",
 * "3.1.1 Average Speed", "Chapter 4: Gravitation", "Topic 2 Kinematics". Segmentation starts a new
 * block at such a line, so a section's text is not glued to the one before it when the PDF's text
 * layer has no blank line between them. A bare "3 Motion" is not on this list: alone it is too easily
 * a wrapped line of prose ("10 Newton per metre …"), so it only counts where a block begins.
 */
export function isStructuralHeadingLine(line: string): boolean {
  const text = line.trim();
  const numbered = /^(\d{1,2}(?:\.\d{1,2}){1,2})\s+(.+)$/.exec(text);
  if (numbered) return looksLikeHeading(numbered[2]!);
  const chapter = CHAPTER_KEYWORD.exec(text);
  if (chapter) return chapter[2]!.trim().length === 0 || looksLikeHeading(chapter[2]!.trim());
  const sub = TOPIC_KEYWORD.exec(text) ?? SUBTOPIC_KEYWORD.exec(text);
  return sub !== null && looksLikeHeading(sub[2]!.trim());
}

/** Heading-shaped: short, starts with a capital, no sentence punctuation, not a question or formula. */
export function looksLikeHeading(name: string): boolean {
  const text = name.trim();
  if (text.length < 2 || text.length > 80) return false;
  if (!/^\p{Lu}/u.test(text)) return false;
  if (/[.?!,;:]$/.test(text)) return false;
  if (/[?=]/.test(text)) return false;
  if (text.split(/\s+/).length > 10) return false;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters >= Math.max(2, text.replace(/\s/g, '').length * 0.6);
}

type HeadingShape = Omit<HeadingHit, 'line' | 'page' | 'blockIndex' | 'lineIndex' | 'leading'> & { usesNextLine?: boolean };

/** The lines of a block that may be headings. Questions and solutions never carry the syllabus. */
function blockLines(block: HierarchyBlock): string[] {
  if (block.kind === 'question' || block.kind === 'solution') return [];
  const lines = block.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (block.title?.trim() && lines.length > 0) lines[0] = block.title.trim();
  return lines;
}

/**
 * Numbered and keyword headings, in reading order — every line of a block, not only its first, because
 * a PDF's text layer often runs a heading straight into its paragraph with no blank line between.
 */
export function findHeadings(blocks: readonly HierarchyBlock[]): HeadingHit[] {
  const hits: HeadingHit[] = [];
  for (const block of blocks) {
    const lines = blockLines(block);
    let consumedTo = -1; // the last line taken up by headings stacked at the top of the block
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const next = lines[i + 1] ?? null;
      const hit = numberedHeading(line, lines.length === 1, next, lines[i - 1] ?? null) ?? keywordHeading(line, next);
      if (!hit) continue;
      const leading = i <= consumedTo + 1;
      const { usesNextLine, ...shape } = hit;
      hits.push({ ...shape, line: usesNextLine ? `${line} ${next}` : line, page: block.page, blockIndex: block.index, lineIndex: i, leading });
      if (leading) consumedTo = i + (usesNextLine ? 1 : 0);
      if (usesNextLine) i += 1;
    }
  }
  return hits;
}

function numberedHeading(line: string, singleLine: boolean, next: string | null, prev: string | null): HeadingShape | null {
  const match = NUMBERED.exec(line);
  if (!match) return null;
  const [, number, trailingDot, rest] = match as unknown as [string, string, string, string];
  const name = rest.trim();
  if (!looksLikeHeading(name)) return null;
  const depth = number.split('.').length;
  // "1. Motion" is how a list item or a question starts as well as a chapter heading; only a line
  // standing on its own is trusted, and less than "1 Motion".
  if (depth === 1 && trailingDot && !singleLine) return null;
  // "1 Inertia" next to "2 Momentum" is a numbered list, not a chapter heading — whichever item this is.
  const listItem = (other: string | null) => other !== null && /^\d{1,2}\.?\s+\S/.test(other);
  if (depth === 1 && (listItem(next) || listItem(prev))) return null;
  const level = LEVELS[depth - 1]!;
  const confidence = depth === 1 ? (trailingDot ? 0.75 : 0.9) : 0.95;
  return { level, name, number, confidence, method: 'numbered' };
}

function keywordHeading(line: string, next: string | null): HeadingShape | null {
  const chapter = CHAPTER_KEYWORD.exec(line);
  if (chapter) {
    const inline = chapter[2]!.trim();
    const name = inline.length > 0 ? inline : (next ?? '');
    if (!looksLikeHeading(name)) return null;
    return { level: 'chapter', name, number: chapter[1]!, confidence: 0.9, method: 'keyword', usesNextLine: inline.length === 0 };
  }
  for (const [pattern, level] of [[TOPIC_KEYWORD, 'topic'], [SUBTOPIC_KEYWORD, 'subtopic']] as const) {
    const match = pattern.exec(line);
    if (match && looksLikeHeading(match[2]!.trim())) {
      return { level, name: match[2]!.trim(), number: match[1]!, confidence: 0.9, method: 'keyword' };
    }
  }
  return null;
}

/** Unnumbered single-line heading blocks: weak evidence, used only under an explicit chapter. */
function titleHeadings(blocks: readonly HierarchyBlock[], taken: ReadonlySet<number>): HeadingHit[] {
  return blocks
    .filter((b) => !taken.has(b.index) && b.format === 'heading' && b.title && looksLikeHeading(b.title))
    .map((b) => ({ level: 'topic' as const, name: b.title!.trim(), number: null, line: b.title!.trim(), page: b.page, blockIndex: b.index, lineIndex: 0, leading: true, confidence: 0.6, method: 'title' as const }));
}

/**
 * The hierarchy the document prints.
 *
 * Numbered and keyword headings are read first. If there are none, the document's structure is not
 * trusted: the result is `sufficient: false` and carries no paths, so nothing is proposed from it.
 */
export function detectHierarchy(blocks: readonly HierarchyBlock[]): HierarchyDetection {
  const structural = findHeadings(blocks);
  const notes: string[] = [];
  if (structural.length === 0) {
    return {
      method: 'none',
      sufficient: false,
      headings: [],
      paths: [],
      blockPath: blocks.map(() => null),
      notes: ['no numbered or "Chapter N" headings were found, so the PDF does not state its own chapter/topic/sub-topic structure'],
    };
  }

  let headings = structural;
  const hasChapterKeyword = structural.some((h) => h.method === 'keyword' && h.level === 'chapter');
  const hasDeeperLevels = structural.some((h) => h.level !== 'chapter');
  if (hasChapterKeyword && !hasDeeperLevels) {
    const titles = titleHeadings(blocks, new Set(structural.map((h) => h.blockIndex)));
    if (titles.length > 0) {
      headings = [...structural, ...titles].sort((a, b) => a.blockIndex - b.blockIndex || a.lineIndex - b.lineIndex);
      notes.push('topics were read from unnumbered title lines under explicit chapter headings, with lower confidence');
    }
  }

  const method: DetectionMethod = headings.some((h) => h.method === 'numbered')
    ? 'numbered'
    : headings.some((h) => h.method === 'title')
      ? 'title'
      : 'keyword';
  const assembled = assemblePaths(blocks, headings, { checkNumbering: true });
  const sufficient = headings.some((h) => (h.level === 'chapter' || h.level === 'topic') && h.confidence >= 0.75);
  if (!sufficient) notes.push('only weak or sub-topic-level headings were found; the hierarchy needs a person to confirm it');
  return { method, sufficient, headings, ...assembled, notes: [...notes, ...assembled.notes] };
}

/**
 * Walks the blocks in reading order, carrying the current chapter → topic → sub-topic, and gives each
 * block the path it sits under. A heading resets the levels below it.
 *
 * With `checkNumbering`, a "3.1" heading only sits under chapter "3": if the document never printed
 * chapter 3 (or the current chapter has another number), that chapter level is left unresolved for
 * it rather than borrowed from whatever chapter came before.
 */
export function assemblePaths(
  blocks: readonly HierarchyBlock[],
  headings: readonly HeadingHit[],
  options: { checkNumbering: boolean },
): { paths: DetectedPath[]; blockPath: (string | null)[]; notes: string[] } {
  const byBlock = new Map<number, HeadingHit[]>();
  for (const h of headings) byBlock.set(h.blockIndex, [...(byBlock.get(h.blockIndex) ?? []), h]);

  let chapter: HeadingHit | null = null;
  let topic: HeadingHit | null = null;
  let subtopic: HeadingHit | null = null;
  const notes = new Set<string>();
  const paths = new Map<string, DetectedPath>();
  const blockPath: (string | null)[] = [];

  /**
   * Whether a numbered heading sits under the given parent. "3.1.1" sits under topic "3.1" and chapter
   * "3"; under chapter "4" it does not. Unnumbered, Roman-numbered or model-chosen parents cannot be
   * compared, so they are accepted.
   */
  const consistent = (child: HeadingHit, parent: HeadingHit): boolean => {
    if (!options.checkNumbering || child.method !== 'numbered' || !child.number) return true;
    if (!parent.number || !/^\d+(?:\.\d+)*$/.test(parent.number)) return true;
    return child.number.startsWith(`${parent.number}.`);
  };

  /** A heading resets the levels below it, and drops a parent its numbering says it is not under. */
  const same = (a: HeadingHit | null, b: HeadingHit): boolean => a !== null && a.number === b.number && normalizeName(a.name) === normalizeName(b.name);
  const apply = (heading: HeadingHit): void => {
    // A running header ("Chapter 3: Motion" at the top of every page) repeats the heading already in
    // force; it must not reset the topic and sub-topic the text is still under.
    if ((heading.level === 'chapter' && same(chapter, heading)) || (heading.level === 'topic' && same(topic, heading))) return;
    if (heading.level === 'chapter') {
      chapter = heading;
      topic = null;
      subtopic = null;
    } else if (heading.level === 'topic') {
      if (chapter && !consistent(heading, chapter)) {
        notes.add(`"${heading.line}" is not numbered under the chapter before it, so its chapter is left unresolved`);
        chapter = null;
      }
      topic = heading;
      subtopic = null;
    } else {
      if (topic && !consistent(heading, topic)) {
        notes.add(`"${heading.line}" is not numbered under the topic before it, so its topic is left unresolved`);
        topic = null;
      }
      if (chapter && !consistent(heading, chapter)) chapter = null;
      subtopic = heading;
    }
  };

  for (const block of [...blocks].sort((a, b) => a.index - b.index)) {
    const here = byBlock.get(block.index) ?? [];
    for (const heading of here.filter((h) => h.leading)) apply(heading);

    const current: (HeadingHit | null)[] = [chapter, topic, subtopic];
    if (current.every((h) => h === null)) {
      blockPath[block.index] = null;
    } else {
      const [c, t, st] = current.map(toLevel) as [DetectedLevel | null, DetectedLevel | null, DetectedLevel | null];
      const key = pathKey(c?.name ?? null, t?.name ?? null, st?.name ?? null);
      const existing = paths.get(key);
      if (existing) existing.blockIndexes.push(block.index);
      else {
        const confidence = Math.min(...[c, t, st].filter((l): l is DetectedLevel => l !== null).map((l) => l.confidence));
        paths.set(key, { key, chapter: c, topic: t, subtopic: st, blockIndexes: [block.index], confidence: round3(confidence) });
      }
      blockPath[block.index] = key;
    }

    const later = here.filter((h) => !h.leading);
    if (later.length > 0) notes.add('some headings run on inside a block of text; such a block is filed under the heading above it');
    for (const heading of later) apply(heading);
  }
  return { paths: [...paths.values()], blockPath, notes: [...notes] };
}

function toLevel(h: HeadingHit | null): DetectedLevel | null {
  return h ? { name: h.name, number: h.number, evidence: h.line, page: h.page, confidence: h.confidence, method: h.method } : null;
}

export function pathKey(chapter: string | null, topic: string | null, subtopic: string | null): string {
  return [chapter, topic, subtopic].map((n) => (n ? normalizeName(n) : '')).join('|');
}

// ---------------------------------------------------------------- the optional model step

/**
 * When the document has no numbered or keyword structure, a model may be asked which of the
 * document's *own* heading lines are chapters, topics or sub-topics. It chooses among numbered lines
 * and returns line numbers, never names, so it cannot introduce a name the PDF does not contain.
 */
export function headingCandidates(blocks: readonly HierarchyBlock[]): { blockIndex: number; lineIndex: number; line: string; page: number }[] {
  const out: { blockIndex: number; lineIndex: number; line: string; page: number }[] = [];
  for (const block of blocks) {
    const lines = blockLines(block);
    lines.forEach((line, i) => {
      if (line.length > 100 || !looksLikeHeading(line.replace(/^\d+(?:\.\d+)*\s*[.)]?\s+/, ''))) return;
      // A wrapped line of prose looks like a short title; the lowercase line continuing it gives it away.
      const next = lines[i + 1];
      if (next !== undefined && /^\p{Ll}/u.test(next)) return;
      // A heading starts after a finished sentence (or another heading), not mid-sentence.
      const prev = lines[i - 1];
      if (prev !== undefined && !/[.?!:]$/.test(prev) && !looksLikeHeading(prev)) return;
      out.push({ blockIndex: block.index, lineIndex: i, line, page: block.page });
    });
  }
  return out.slice(0, 80);
}

export function buildHeadingPrompt(subjectName: string, candidates: readonly { line: string; page: number }[]): string {
  return [
    `You are reading the heading lines of a ${subjectName} study document, in reading order.`,
    'Decide which lines are the document\'s own chapter, topic or sub-topic headings.',
    'Rules:',
    '- Choose only from the numbered lines below. Do not rename, merge, translate or invent anything.',
    '- A line that is a box title, figure caption, example label, exercise heading or sentence is "none".',
    '- If you are not sure, answer "none" for that line.',
    '- Reply with JSON only: {"headings":[{"line":<number>,"level":"chapter"|"topic"|"subtopic"}]}. Omit lines that are "none".',
    '',
    ...candidates.map((c, i) => `${i + 1}. [page ${c.page}] ${c.line.replace(/\s+/g, ' ').slice(0, 100)}`),
  ].join('\n');
}

export function parseHeadingReply(text: string, candidateCount: number): { ok: true; value: { line: number; level: Level }[] } | { ok: false; reason: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'reply contained no JSON object' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'reply was not valid JSON' };
  }
  const list = (parsed as { headings?: unknown }).headings;
  if (!Array.isArray(list)) return { ok: false, reason: 'reply has no "headings" array' };
  const out: { line: number; level: Level }[] = [];
  for (const item of list) {
    const line = (item as { line?: unknown }).line;
    const level = (item as { level?: unknown }).level;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > candidateCount) continue;
    if (level !== 'chapter' && level !== 'topic' && level !== 'subtopic') continue;
    out.push({ line, level });
  }
  return { ok: true, value: out };
}

/**
 * Turns a model's choice of lines into a detection. Every name is re-checked against the document
 * text; a line that does not ground is dropped. The result is never stronger than 0.6 confidence, so
 * nothing a model chose is mistaken for structure the document printed.
 */
export function detectionFromModel(
  blocks: readonly HierarchyBlock[],
  candidates: readonly { blockIndex: number; lineIndex?: number; line: string; page: number }[],
  choices: readonly { line: number; level: Level }[],
  documentText: string,
): HierarchyDetection {
  const hits: HeadingHit[] = [];
  const dropped: string[] = [];
  for (const choice of choices) {
    const candidate = candidates[choice.line - 1];
    if (!candidate) continue;
    const name = candidate.line.replace(/^\d+(?:\.\d+)*\s*[.)]?\s+/, '').trim();
    if (!isGrounded(name, documentText)) {
      dropped.push(candidate.line);
      continue;
    }
    const lineIndex = candidate.lineIndex ?? 0;
    hits.push({ level: choice.level, name, number: null, line: candidate.line, page: candidate.page, blockIndex: candidate.blockIndex, lineIndex, leading: lineIndex === 0, confidence: 0.6, method: 'ai' });
  }
  hits.sort((a, b) => a.blockIndex - b.blockIndex || a.lineIndex - b.lineIndex);
  const assembled = assemblePaths(blocks, hits, { checkNumbering: false });
  const notes = ['heading levels were chosen by a model from the PDF\'s own heading lines; every level needs a person to confirm it', ...assembled.notes];
  if (dropped.length > 0) notes.push(`${dropped.length} model choice(s) were discarded because they did not match the PDF text`);
  const sufficient = hits.some((h) => h.level === 'chapter' || h.level === 'topic');
  return { method: 'ai', sufficient, headings: hits, ...assembled, notes };
}

// ---------------------------------------------------------------- matching

export interface ExistingNode {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'archived';
}
export interface ExistingTopic extends ExistingNode {
  subtopics: ExistingNode[];
}
export interface ExistingChapter extends ExistingNode {
  topics: ExistingTopic[];
}
export interface ExistingTree {
  chapters: ExistingChapter[];
}

export type MatchHow = 'exact' | 'near_exact' | 'overlap' | 'none';

export interface LevelMatch {
  /** The detected name (null when the level is unresolved). */
  detectedName: string | null;
  existingId: string | null;
  existingName: string | null;
  existingStatus: ExistingNode['status'] | null;
  score: number;
  how: MatchHow;
  /** The nearest existing node below the reuse floor, so a reviewer sees what was considered. */
  closest: { id: string; name: string; score: number } | null;
}

export interface PathMatch {
  chapter: LevelMatch;
  topic: LevelMatch;
  subtopic: LevelMatch;
  /** All three levels exist and are published: content can be filed directly, as before. */
  resolvedSubtopicId: string | null;
  /** Lowest of the detection confidence and the score of every reused level. */
  confidence: number;
  reason: string;
}

/** A level is reused at or above this score; below it the level is proposed as new. */
export const REUSE_MIN = 0.8;

const NEAR_EXACT = 0.92;

/** How well a detected name matches an existing node's name: 1 exact, 0.92 near-exact, else word overlap. */
export function nameScore(detected: string, existing: string): { score: number; how: MatchHow } {
  const a = normalizeName(detected);
  const b = normalizeName(existing);
  if (a.length === 0 || b.length === 0) return { score: 0, how: 'none' };
  if (a === b) return { score: 1, how: 'exact' };
  const sa = singular(a);
  const sb = singular(b);
  if (sa === sb || similarity(a, b) >= 0.9) return { score: NEAR_EXACT, how: 'near_exact' };
  const ta = new Set(sa.split(' '));
  const tb = new Set(sb.split(' '));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = shared / new Set([...ta, ...tb]).size;
  return jaccard > 0 ? { score: round3(jaccard * 0.9), how: 'overlap' } : { score: 0, how: 'none' };
}

/** Best existing node for a name among siblings that are not archived. */
export function matchLevel(detectedName: string | null, siblings: readonly ExistingNode[]): LevelMatch {
  const empty: LevelMatch = { detectedName, existingId: null, existingName: null, existingStatus: null, score: 0, how: 'none', closest: null };
  if (!detectedName) return empty;
  let best: { node: ExistingNode; score: number; how: MatchHow } | null = null;
  for (const node of siblings) {
    if (node.status === 'archived') continue;
    const { score, how } = nameScore(detectedName, node.name);
    if (score > (best?.score ?? 0) || (best && score === best.score && node.id < best.node.id)) best = { node, score, how };
  }
  if (!best) return empty;
  if (best.score >= REUSE_MIN) {
    return { detectedName, existingId: best.node.id, existingName: best.node.name, existingStatus: best.node.status, score: best.score, how: best.how, closest: null };
  }
  return { ...empty, closest: { id: best.node.id, name: best.node.name, score: best.score } };
}

/** Matches a path level by level inside one subject's tree. */
export function matchPath(path: Pick<DetectedPath, 'chapter' | 'topic' | 'subtopic' | 'confidence'>, tree: ExistingTree): PathMatch {
  const chapter = matchLevel(path.chapter?.name ?? null, tree.chapters);
  const chapterNode = tree.chapters.find((c) => c.id === chapter.existingId) ?? null;
  const topic = matchLevel(path.topic?.name ?? null, chapterNode?.topics ?? []);
  const topicNode = chapterNode?.topics.find((t) => t.id === topic.existingId) ?? null;
  const subtopic = matchLevel(path.subtopic?.name ?? null, topicNode?.subtopics ?? []);

  const levels = [chapter, topic, subtopic];
  const reused = levels.filter((l) => l.existingId !== null);
  const confidence = round3(Math.min(path.confidence, ...reused.map((l) => l.score)));
  const allPublished = levels.every((l) => l.existingId !== null && l.existingStatus === 'published');
  const describe = (label: string, l: LevelMatch): string =>
    l.detectedName === null
      ? `${label} not stated in the PDF`
      : l.existingId
        ? `${label} "${l.detectedName}" matches existing "${l.existingName}" (${l.how.replace('_', '-')}${l.existingStatus === 'published' ? '' : `, ${l.existingStatus}`})`
        : `${label} "${l.detectedName}" is new${l.closest ? ` (closest existing "${l.closest.name}" at ${l.closest.score})` : ''}`;
  const reason = [describe('chapter', chapter), describe('topic', topic), describe('sub-topic', subtopic)].join('; ');
  return { chapter, topic, subtopic, resolvedSubtopicId: allPublished ? subtopic.existingId : null, confidence, reason };
}

// ---------------------------------------------------------------- helpers

function singular(text: string): string {
  return text
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/** 1 - normalised Levenshtein distance. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) / Math.max(m, n) > 0.2) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** A URL-safe slug for a new node (the syllabus tables require `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 80). */
export function slugFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'section';
}
