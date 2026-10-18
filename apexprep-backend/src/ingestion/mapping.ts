/**
 * Deciding which sub-topic a block belongs to.
 *
 * The rule the requirements set, and the one thing this module exists to guarantee: **only
 * existing syllabus nodes are used.** A block whose subject matter has no node is not filed
 * under a near-enough one and no node is created for it — it comes back unmapped with a proposal
 * a human can accept or reject. Taxonomy is the course author's to change, never the pipeline's.
 *
 * Candidate sub-topics are supplied by the caller, already narrowed to the tenant and to the
 * track and subject the uploader named. Matching is term overlap against each node's name and
 * its ancestors' names, which is transparent and reproducible; a semantic ranker can be layered
 * in behind the same interface, because nothing here decides *whether* to map — only which
 * candidate is best and how sure it is.
 *
 * Pure: no database, no configuration, no clock.
 */

export interface SyllabusCandidate {
  subtopicId: string;
  subtopicName: string;
  topicName: string;
  chapterName: string;
  subjectName: string;
  trackSlug: string;
  /** Whether this candidate sits under the track and subject the uploader named. */
  matchesUploadHint: boolean;
}

export interface MappingInput {
  text: string;
  /** The block's own heading, when it had one: a strong signal. */
  title?: string | null;
  candidates: readonly SyllabusCandidate[];
}

export interface MappingResult {
  subtopicId: string | null;
  /** 0-1. The caller compares this with the configured floor to decide on review. */
  confidence: number;
  /** Written onto the review task so a human sees why, not just what. */
  reason: string;
  /** The runners-up, so a reviewer can pick one without searching the whole syllabus. */
  alternatives: { subtopicId: string; score: number }[];
  /** Set when nothing matched: the sub-topic the content seems to want, for a human to judge. */
  proposedSubtopicName: string | null;
}

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','have','in','into','is','it','its','of','on','or','that','the','their','then','there','these','this','to','was','were','which','with','when','where','while','can','may','if','so','not','no','all','any','each','per','using','use','used','also','such','than','both','other','more','most','some','only','very','how','what','why',
]);

/** Content terms of a text: lowercased, punctuation stripped, stopwords and 1-character tokens out. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Weights for where a matching term appeared. A sub-topic's own name naming a term is much
 * stronger evidence than its chapter's name doing so, because a chapter name is shared by every
 * sub-topic under it and so distinguishes nothing.
 */
const WEIGHTS = { subtopic: 1, topic: 0.5, chapter: 0.25, subject: 0.1 } as const;

export function mapToSubtopic(input: MappingInput): MappingResult {
  const blockTerms = terms(`${input.title ?? ''}\n${input.text}`);
  if (blockTerms.size === 0 || input.candidates.length === 0) {
    return {
      subtopicId: null,
      confidence: 0,
      reason: input.candidates.length === 0 ? 'no published sub-topic exists under the track and subject given at upload' : 'the block has no content terms to match on',
      alternatives: [],
      proposedSubtopicName: proposeName(input.title, input.text),
    };
  }

  const scored = input.candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, blockTerms) }))
    .sort((a, b) => b.score - a.score || a.candidate.subtopicId.localeCompare(b.candidate.subtopicId));

  const best = scored[0]!;
  const runnerUp = scored[1];

  // Nothing overlapped at all: the syllabus has no home for this block. Propose, never create.
  if (best.score === 0) {
    return {
      subtopicId: null,
      confidence: 0,
      reason: 'no existing sub-topic shares any term with this block',
      alternatives: [],
      proposedSubtopicName: proposeName(input.title, input.text),
    };
  }

  // Confidence has three parts, and it needs all three.
  //
  //   * **share** — how much of the total evidence the winner holds;
  //   * **margin** — how far clear of the runner-up it is, so two nodes that match equally well
  //     score low, which is exactly when a human should choose;
  //   * **strength** — how much of the winner's *own* name actually matched.
  //
  // Strength is the one that cannot be left out. Share and margin are both relative, so a single
  // block matched against a single candidate on one incidental word — "motion" in a passage about
  // stellar parallax, against a topic called "Laws of Motion" — would hold all the evidence and
  // have no rival, and score 1.0 on the other two. Weighing how much of the candidate's name was
  // matched is what keeps that block below the review floor instead of auto-approving it.
  const total = scored.reduce((sum, s) => sum + s.score, 0);
  const share = best.score / total;
  const margin = runnerUp && runnerUp.score > 0 ? 1 - runnerUp.score / best.score : 1;
  const strength = Math.min(1, best.score / Math.max(maxScore(best.candidate), 0.001));
  let confidence = round3(Math.min(1, share * 0.25 + margin * 0.25 + strength * 0.5));
  if (!best.candidate.matchesUploadHint) confidence = round3(confidence * 0.7);

  return {
    subtopicId: best.candidate.subtopicId,
    confidence,
    reason:
      `matched "${best.candidate.subtopicName}" on ${best.score.toFixed(2)} of ${total.toFixed(2)} term weight` +
      (runnerUp && runnerUp.score > 0 ? `; next best "${runnerUp.candidate.subtopicName}" at ${runnerUp.score.toFixed(2)}` : '; no other candidate matched') +
      (best.candidate.matchesUploadHint ? '' : '; outside the track and subject given at upload'),
    alternatives: scored.slice(1, 4).filter((s) => s.score > 0).map((s) => ({ subtopicId: s.candidate.subtopicId, score: round3(s.score) })),
    proposedSubtopicName: null,
  };
}

/** Every level of a candidate's ancestry, with the weight a term matched there earns. */
function levelsOf(candidate: SyllabusCandidate): [keyof typeof WEIGHTS, string][] {
  return [
    ['subtopic', candidate.subtopicName],
    ['topic', candidate.topicName],
    ['chapter', candidate.chapterName],
    ['subject', candidate.subjectName],
  ];
}

/** What this candidate would score if every term in its own names were matched. */
function maxScore(candidate: SyllabusCandidate): number {
  let total = 0;
  const seen = new Set<string>();
  for (const [level, name] of levelsOf(candidate)) {
    for (const term of terms(name)) {
      if (seen.has(term)) continue;
      seen.add(term);
      total += WEIGHTS[level];
    }
  }
  return round3(total);
}

function scoreCandidate(candidate: SyllabusCandidate, blockTerms: ReadonlySet<string>): number {
  let score = 0;
  const seen = new Set<string>();
  for (const [level, name] of levelsOf(candidate)) {
    for (const term of terms(name)) {
      // A term counts once, at the narrowest level that mentions it.
      if (seen.has(term) || !blockTerms.has(term)) continue;
      seen.add(term);
      score += WEIGHTS[level];
    }
  }
  return round3(score);
}

/**
 * A name to propose when nothing fits: the block's own heading, or its opening words. It is only
 * ever a suggestion written onto a review task — nothing creates a node from it.
 */
function proposeName(title: string | null | undefined, text: string): string | null {
  const source = (title ?? text.split('\n')[0] ?? '').trim();
  if (source.length === 0) return null;
  const words = source.split(/\s+/).slice(0, 6).join(' ');
  return words.length > 80 ? `${words.slice(0, 77)}…` : words;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
