import {
  buildHeadingPrompt,
  detectHierarchy,
  detectionFromModel,
  headingCandidates,
  isGrounded,
  matchPath,
  nameScore,
  normalizeName,
  parseHeadingReply,
  slugFor,
  type ExistingTree,
  type HierarchyBlock,
} from '../../src/ingestion/hierarchy';
import { segmentPages } from '../../src/ingestion/segmentation';

/** Real page text through the real segmenter, so detection is tested on what the pipeline gives it. */
function blocksOf(...pages: string[]): HierarchyBlock[] {
  return segmentPages(pages.map((text, i) => ({ pageNumber: i + 1, text }))).map((b, index) => ({
    index,
    kind: b.kind,
    format: b.format,
    title: b.title,
    text: b.text,
    page: b.sourcePage,
  }));
}

const NUMBERED = [
  '3 Motion',
  '',
  'Motion is a change in position with time.',
  '',
  '3.1 Distance and Displacement',
  '',
  'Distance is the length of the path travelled; displacement is the change in position.',
  '',
  '3.1.1 Average Speed',
  '',
  'Average speed is the total distance travelled divided by the total time taken.',
  '',
  '1. A car travels 100 m in 20 s. Find its average speed.',
  'Answer: 5',
  '',
  '3.1.2 Average Velocity',
  '',
  'Average velocity is the displacement divided by the time taken.',
].join('\n');

const EMPTY_TREE: ExistingTree = { chapters: [] };

describe('A/B. deterministic, numbered hierarchy detection', () => {
  const detection = detectHierarchy(blocksOf(NUMBERED));

  it('reads chapter, topic and sub-topic from the numbering, with names exactly as printed', () => {
    expect(detection.method).toBe('numbered');
    expect(detection.sufficient).toBe(true);
    const full = detection.paths.filter((p) => p.subtopic);
    expect(full.map((p) => [p.chapter?.name, p.topic?.name, p.subtopic?.name])).toEqual([
      ['Motion', 'Distance and Displacement', 'Average Speed'],
      ['Motion', 'Distance and Displacement', 'Average Velocity'],
    ]);
    expect(full[0]!.chapter!.evidence).toBe('3 Motion');
    expect(full[0]!.subtopic!.number).toBe('3.1.1');
    expect(full[0]!.confidence).toBe(0.9);
  });

  it('files every block — including the question — under the path in force where it appears', () => {
    const blocks = blocksOf(NUMBERED);
    const question = blocks.findIndex((b) => b.kind === 'question');
    expect(detection.blockPath[question]).toBe('motion|distance and displacement|average speed');
    // The chapter's own introduction sits at chapter level, with topic and sub-topic unresolved.
    const intro = blocks.findIndex((b) => b.text.startsWith('Motion is a change'));
    expect(detection.blockPath[intro]).toBe('motion||');
  });

  it('reads a heading run into its paragraph (no blank line), as PDF text layers often print it', () => {
    const blocks = blocksOf('2 Gravitation\nGravity pulls masses together.\n2.1 Universal Law\n2.1.1 Inverse Square Law\nThe force between two masses falls with the square of the distance.');
    // Segmentation starts a block at each numbered section heading, so a section's text is its own block.
    const paragraph = blocks.findIndex((b) => b.text.includes('The force between two masses'));
    const intro = blocks.findIndex((b) => b.text.includes('Gravity pulls'));
    expect(paragraph).not.toBe(intro);
    const glued = detectHierarchy(blocks);
    expect(glued.blockPath[paragraph]).toBe('gravitation|universal law|inverse square law');
    expect(glued.blockPath[intro]).toBe('gravitation||');
  });

  it('a running page header repeating the chapter does not reset the topic and sub-topic', () => {
    const blocks = blocksOf(
      'Chapter 3: Motion\n\n3.1 Speed\n\n3.1.1 Average Speed\n\nAverage speed is distance over time.',
      'Chapter 3: Motion\n\nIt is measured in metres per second.',
    );
    const detection = detectHierarchy(blocks);
    const pageTwo = blocks.findIndex((b) => b.text.includes('metres per second'));
    expect(detection.blockPath[pageTwo]).toBe('motion|speed|average speed');
  });

  it('does not borrow a chapter its numbering says it is not under', () => {
    const wrong = detectHierarchy(blocksOf('3 Motion\n\nText.\n\n4.1 Work Done\n\nWork is force times displacement.'));
    const work = wrong.paths.find((p) => p.topic?.name === 'Work Done')!;
    expect(work.chapter).toBeNull();
    expect(wrong.notes.join(' ')).toMatch(/not numbered under the chapter/);
  });

  it('is not fooled by numbered lists, numbered questions or quantities', () => {
    const noise = detectHierarchy(blocksOf('1 Inertia\n2 Momentum\n\n2 kg of water is heated.\n\n1. A ball is dropped. Find its speed after 2 s.\nAnswer: 20'));
    expect(noise.headings).toEqual([]);
    expect(noise.sufficient).toBe(false);
  });
});

describe('C. "Chapter N" and title-based detection', () => {
  it('reads keyword chapters, and title lines under them as topics with lower confidence', () => {
    const detection = detectHierarchy(blocksOf('Chapter 4: Gravitation\n\nIntro text about gravity.\n\nKepler Laws\n\nPlanets move in ellipses.\n\nEscape Velocity\n\nThe speed needed to leave a body.'));
    expect(detection.sufficient).toBe(true);
    expect(detection.method).toBe('title');
    const kepler = detection.paths.find((p) => p.topic?.name === 'Kepler Laws')!;
    expect(kepler.chapter!.name).toBe('Gravitation');
    expect(kepler.topic!.confidence).toBe(0.6);
    expect(kepler.subtopic).toBeNull(); // never invented
  });

  it('reads a chapter name printed on the line after "Chapter 5"', () => {
    const detection = detectHierarchy(blocksOf('Chapter 5\nLaws of Motion\n5.1 Inertia\nText about inertia.'));
    const path = detection.paths.find((p) => p.topic)!;
    expect([path.chapter?.name, path.topic?.name]).toEqual(['Laws of Motion', 'Inertia']);
  });
});

describe('D. ambiguous PDF → review, nothing invented', () => {
  it('a document with only title lines is insufficient and proposes no path', () => {
    const detection = detectHierarchy(blocksOf('Angular Momentum\n\nThe angular momentum of a rigid body is I times omega.\n\nSolutions\n\nSolution 1. It is 0.5.'));
    expect(detection.method).toBe('none');
    expect(detection.sufficient).toBe(false);
    expect(detection.paths).toEqual([]);
    expect(detection.blockPath.every((p) => p === null)).toBe(true);
  });

  it('a model may only choose among the PDF\'s own lines, and every name is re-grounded', () => {
    const blocks = blocksOf('Optics\n\nLight travels in straight lines.\n\nReflection\n\nAngle of incidence equals angle of reflection.');
    const candidates = headingCandidates(blocks);
    expect(candidates.map((c) => c.line)).toEqual(['Optics', 'Reflection']);
    const prompt = buildHeadingPrompt('Physics', candidates);
    expect(prompt).toMatch(/Do not rename, merge, translate or invent/);
    expect(prompt).toMatch(/1\. \[page 1\] Optics/);

    expect(parseHeadingReply('no json', 2).ok).toBe(false);
    const parsed = parseHeadingReply('{"headings":[{"line":1,"level":"chapter"},{"line":2,"level":"topic"},{"line":9,"level":"topic"},{"line":2,"level":"galaxy"}]}', 2);
    expect(parsed).toEqual({ ok: true, value: [{ line: 1, level: 'chapter' }, { line: 2, level: 'topic' }] });

    const text = blocks.map((b) => b.text).join('\n');
    const detection = detectionFromModel(blocks, candidates, parsed.ok ? parsed.value : [], text);
    expect(detection.method).toBe('ai');
    expect(detection.paths.find((p) => p.topic)!.chapter!.name).toBe('Optics');
    expect(Math.max(...detection.paths.map((p) => p.confidence))).toBeLessThanOrEqual(0.6);
  });

  it('X. a model reply cannot add a name: extra fields are ignored, and a choice that does not ground is dropped', () => {
    const blocks = blocksOf('Optics\n\nLight travels in straight lines.\n\nReflection\n\nAngle of incidence equals angle of reflection.');
    const candidates = headingCandidates(blocks);
    const parsed = parseHeadingReply('{"headings":[{"line":1,"level":"chapter","name":"Geometrical Optics"},{"line":2,"level":"topic"}]}', candidates.length);
    expect(parsed).toEqual({ ok: true, value: [{ line: 1, level: 'chapter' }, { line: 2, level: 'topic' }] });
    // Checked against text that lacks "Reflection" (as if the line had not come from this PDF): that level is dropped.
    const detection = detectionFromModel(blocks, candidates, parsed.ok ? parsed.value : [], 'Optics. Light travels in straight lines.');
    expect(detection.headings.map((h) => h.name)).toEqual(['Optics']);
    expect(detection.notes.join(' ')).toMatch(/discarded because they did not match the PDF text/);
    expect(JSON.stringify(detection)).not.toContain('Geometrical Optics');
  });

  it('candidate heading lines come from anywhere in a block, but never a wrapped line of prose', () => {
    const blocks = blocksOf('Light Basics\nLight travels in straight lines\nin a uniform medium.\nReflection Laws\nThe angle of incidence equals\nthe angle of reflection.');
    expect(blocks).toHaveLength(1); // no paragraph breaks recovered: one block
    expect(headingCandidates(blocks).map((c) => [c.line, c.lineIndex])).toEqual([['Light Basics', 0], ['Reflection Laws', 3]]);
    // Cutting at the chosen lines puts each section's text under its own heading.
    const recut = segmentPages([{ pageNumber: 1, text: blocks[0]!.text }], { boundaries: new Set(['Reflection Laws']) });
    expect(recut.map((b) => b.text.split('\n')[0])).toEqual(['Light Basics', 'Reflection Laws']);
  });

  it('a name not present in the PDF is never grounded', () => {
    const text = '3 Motion\n3.1 Distance and Displacement';
    expect(isGrounded('Distance and Displacement', text)).toBe(true);
    expect(isGrounded('3.1 distance & displacement', text)).toBe(true);
    expect(isGrounded('Kinematics', text)).toBe(false);
    expect(isGrounded('Distance', 'Displacements')).toBe(false); // whole words only
  });
});

describe('E-J. matching inside the uploaded subject', () => {
  const tree: ExistingTree = {
    chapters: [
      {
        id: 'c-motion',
        name: 'Motion',
        status: 'published',
        topics: [
          {
            id: 't-dd',
            name: 'Distance & Displacement',
            status: 'published',
            subtopics: [{ id: 's-avg', name: 'Average speed', status: 'published' }],
          },
        ],
      },
      { id: 'c-old', name: 'Gravitation', status: 'archived', topics: [] },
      { id: 'c-draft', name: 'Work and Energy', status: 'draft', topics: [] },
    ],
  };
  const path = (c: string | null, t: string | null, s: string | null) => ({
    chapter: c ? { name: c, number: null, evidence: c, page: 1, confidence: 0.9, method: 'numbered' as const } : null,
    topic: t ? { name: t, number: null, evidence: t, page: 1, confidence: 0.95, method: 'numbered' as const } : null,
    subtopic: s ? { name: s, number: null, evidence: s, page: 1, confidence: 0.95, method: 'numbered' as const } : null,
    confidence: 0.9,
  });

  it('E/F/G. reuses an existing chapter, topic and sub-topic, and resolves to the sub-topic when all are published', () => {
    const m = matchPath(path('Motion', 'Distance and Displacement', 'Average Speed'), tree);
    expect([m.chapter.existingId, m.topic.existingId, m.subtopic.existingId]).toEqual(['c-motion', 't-dd', 's-avg']);
    expect(m.chapter.how).toBe('exact');
    expect(m.topic.how).toBe('exact'); // "&" and "and" normalise alike
    expect(m.resolvedSubtopicId).toBe('s-avg');
  });

  it('J. proposes only a missing sub-topic under existing chapter and topic', () => {
    const m = matchPath(path('Motion', 'Distance and Displacement', 'Average Velocity'), tree);
    expect([m.chapter.existingId, m.topic.existingId, m.subtopic.existingId]).toEqual(['c-motion', 't-dd', null]);
    expect(m.resolvedSubtopicId).toBeNull();
    expect(m.subtopic.closest?.name).toBe('Average speed'); // considered, below the reuse floor
    expect(m.reason).toMatch(/sub-topic "Average Velocity" is new/);
  });

  it('I. proposes a missing topic (and so its sub-topic) under an existing chapter', () => {
    const m = matchPath(path('Motion', 'Uniform Circular Motion', 'Angular Speed'), tree);
    expect([m.chapter.existingId, m.topic.existingId, m.subtopic.existingId]).toEqual(['c-motion', null, null]);
  });

  it('H. proposes a missing chapter; an archived namesake is not reused', () => {
    const m = matchPath(path('Gravitation', 'Universal Law', 'Inverse Square Law'), tree);
    expect([m.chapter.existingId, m.topic.existingId, m.subtopic.existingId]).toEqual([null, null, null]);
  });

  it('a draft node is reused but does not resolve the path: content waits for approval to publish it', () => {
    const m = matchPath(path('Work and Energy', null, null), tree);
    expect(m.chapter.existingId).toBe('c-draft');
    expect(m.resolvedSubtopicId).toBeNull();
  });

  it('only searches within the given subject tree (nothing else is passed in)', () => {
    expect(matchPath(path('Motion', 'Distance and Displacement', 'Average Speed'), EMPTY_TREE).resolvedSubtopicId).toBeNull();
  });

  it('scores exact, near-exact and overlapping names in that order', () => {
    expect(nameScore('Laws of Motion', 'laws of motion').how).toBe('exact');
    expect(nameScore('Newton Law', 'Newton Laws')).toEqual({ score: 0.92, how: 'near_exact' });
    expect(nameScore('Projectile Motion Basics', 'Projectile Motion').how).toBe('overlap');
    expect(nameScore('Projectile Motion Basics', 'Projectile Motion').score).toBeLessThan(0.8);
    expect(nameScore('Optics', 'Thermodynamics').how).toBe('none');
  });

  it('normalises numbering and keywords away, and makes valid slugs', () => {
    expect(normalizeName('Chapter 4: Gravitation')).toBe('gravitation');
    expect(normalizeName('3.1.1 Average Speed')).toBe('average speed');
    expect(slugFor('Distance & Displacement (1-D)')).toBe('distance-and-displacement-1-d');
    expect(slugFor('½')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
