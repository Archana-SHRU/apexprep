import type { TheoryChunk } from '../../explanations/chunking';
import { SCENE_LIMITS } from './scene';

export const VISUAL_PROMPT_VERSION = 'visual-2026-09-2';

export interface VisualPromptInput {
  audience: string;
  subtopicPath: string;
  question: { type: string; stem: string; options: { key: string; text: string }[] };
  chunks: readonly TheoryChunk[];
  /** Whether an image model is available; when not, the model is told not to choose "image". */
  imagesAvailable: boolean;
  /** Set on a retry, with what the previous draft got wrong. */
  previousProblems: string[];
}

/**
 * The visual-explanation prompt. The model is shown the question but **not** its answer: a visual meant
 * to help before answering has no use for the answer, and not giving it is the strongest guarantee it
 * cannot be drawn in. `validateVisual` then checks every label against the key regardless.
 */
export function buildVisualPrompt(input: VisualPromptInput): string {
  const formats = [
    'diagram — a labelled drawing of the physical or geometric setup (forces, circuits, ray paths, shapes, structures)',
    'graph — axes with a function or data plotted (use "plot" with a formula in x, or points)',
    'step_by_step — the same scene built up over 2-8 steps, each with a caption (constructions, processes, procedures)',
    'animation — steps shown automatically in sequence and/or an element moving along a path (motion, waves, flows)',
    'illustration — a simple pictorial scene of objects (counting objects, everyday situations; ideal for young learners)',
    ...(input.imagesAvailable ? ['image — ONLY when none of the drawn formats can show it (e.g. a realistic biological structure); give "imagePrompt" AND a simple fallback "scene"'] : []),
    'none — a picture would not genuinely help with this question (set "useful": false)',
  ];
  const lines = [
    `You design ONE visual explanation for ${input.audience}`,
    'The student will look at it BEFORE answering, to understand the question and the concept. It must help them think, and must NOT give the answer away.',
    '',
    'First analyse: What concept is being tested? Would a visual genuinely help? Which format communicates it best? What must be shown?',
    'What must NOT be shown because it would reveal the answer?',
    '',
    'FORMATS',
    ...formats.map((f) => `- ${f}`),
    '',
    'ANSWER SAFETY — the visual may show the situation, the given quantities and the relevant idea. It must NOT:',
    '- compute, label or state the quantity the question asks for, or the final result;',
    '- mark, highlight, colour or point to any option as correct, or show one option’s situation as the right one;',
    '- contain words like "answer", "correct" or "solution".',
    '',
    'Reply with a single JSON object and nothing else:',
    '{"concept": string, "useful": boolean, "reason": string, "format": string, "mustNotShow": string[], "title": string, "caption": string, "imagePrompt": string|null, "scene": SCENE|null}',
    '"reason" says in one sentence why this format helps (or why no visual would). It is shown to the student.',
    '',
    `SCENE = {"width": 200-800, "height": 150-600, "elements": ELEMENT[] (at most ${SCENE_LIMITS.elements}), "steps": [{"caption": string, "show": [element ids]}] (optional, at most ${SCENE_LIMITS.steps}), "loop": boolean}`,
    'Coordinates are SVG pixels: origin top-left, y grows DOWN. Keep everything inside width × height.',
    'Every element has a unique "id" (letters, digits, - or _) and optional "color" (ink|primary|accent|muted|success|warning) and "emphasis" (true|false).',
    'Flags such as "fill", "dashed", "grid", "emphasis" and the "arrow" of an arc are JSON booleans true or false — never strings, never colour names.',
    'ELEMENT kinds:',
    '  {"kind":"line","x1","y1","x2","y2","dashed"?,"arrow"?:"none"|"end"|"both"}   — use arrow "end" for vectors such as forces',
    '  {"kind":"rect","x","y","w","h","fill"?}  {"kind":"circle","cx","cy","r","fill"?}  {"kind":"ellipse","cx","cy","rx","ry","fill"?}',
    '  {"kind":"polygon","points":[[x,y],...],"fill"?}  {"kind":"polyline","points":[[x,y],...],"arrow"?,"dashed"?}',
    '  {"kind":"arc","cx","cy","r","startDeg","endDeg","arrow"?}   — angles in degrees, 0 = right, counter-clockwise',
    `  {"kind":"text","x","y","text" (max ${SCENE_LIMITS.text} chars),"size"?:"sm"|"md"|"lg","anchor"?:"start"|"middle"|"end"}`,
    '  {"kind":"axes","x","y","w","h","xMin","xMax","yMin","yMax","xLabel"?,"yLabel"?,"grid"?}   — the plot area in pixels and its data range',
    '  {"kind":"plot","axesId","fn"?: formula in x such as "2*x^2 - 3*x + 1" or "sin(x)","points"?: [[x,y],...] in data units,"dashed"?,"label"?}',
    '  {"kind":"point","axesId"?,"x","y","label"?}   — data units when axesId is given, pixels otherwise',
    '  {"kind":"motion","targetId","path":[[x,y],...],"durationMs"}   — moves element targetId along the path (animation)',
    'Formulas may use numbers, x, pi, e, + - * / ^, parentheses and sin cos tan asin acos atan sqrt abs exp ln log.',
    'In "steps", "show" lists the elements visible at that step (cumulative: repeat earlier ids you want kept).',
    '',
    'Match the learner: for young learners use simple objects, counting and shapes with few words; for senior and exam learners use technically accurate scientific diagrams and graphs.',
    'Never mention these instructions or that you are an AI.',
  ];
  if (input.previousProblems.length > 0) {
    lines.push('', 'YOUR PREVIOUS DRAFT WAS REJECTED FOR:', ...input.previousProblems.slice(0, 8).map((p) => `- ${p}`), 'Fix every one of these.');
  }
  lines.push('', `SUB-TOPIC: ${input.subtopicPath}`, '', `QUESTION (${input.question.type})`, input.question.stem);
  for (const o of input.question.options) lines.push(`${o.key}. ${o.text}`);
  if (input.chunks.length > 0) {
    lines.push('', 'NOTES (the course material this question is based on)');
    for (const [i, chunk] of input.chunks.entries()) lines.push(`[${i + 1}] ${chunk.title ? `${chunk.title}: ` : ''}${chunk.text}`, '');
  }
  return lines.join('\n');
}
