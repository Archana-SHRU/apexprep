import { z } from 'zod';
import { extractJsonObject } from '../../ai/prompts';
import { findAnswerLeaks, type LeakAnswer } from '../leakage';
import { compileExpression, sampleCurve } from './expression';

/**
 * The visual-explanation format: a small, closed scene description the frontend draws as SVG.
 *
 * The model never writes SVG, HTML or code. It fills in this schema — lines, shapes, text, axes, plots,
 * points and motion paths, plus optional steps — and everything is validated here: bounded sizes and
 * counts, known element kinds only, references that resolve, formulas compiled by the safe evaluator,
 * and every piece of text checked against the question's answer key. What reaches the browser is data
 * the renderer fully controls, so there is nothing to inject and nothing that can execute.
 */

export const VISUAL_FORMATS = ['diagram', 'graph', 'step_by_step', 'animation', 'illustration', 'image', 'none'] as const;
export type VisualFormat = (typeof VISUAL_FORMATS)[number];

export const SCENE_LIMITS = { elements: 80, steps: 8, text: 80, caption: 240, polyPoints: 60 } as const;

const COLORS = ['ink', 'primary', 'accent', 'muted', 'success', 'warning'] as const;
const coord = z.number().finite();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
const label = z.string().trim().min(1).max(SCENE_LIMITS.text);
const point = z.tuple([coord, coord]);

/**
 * A yes/no flag, tolerant of the ways models write one: `true`, `"true"`, `"yes"`, or a colour name given for
 * `fill` (which means "filled"). Normalised here, deterministically, so a harmless type slip does not cost a
 * whole visual; every safety check below still runs on the normalised scene. Anything that is not a boolean
 * or a string is still refused.
 */
const flag = z.preprocess(
  (v) => (typeof v === 'string' ? !['false', 'no', 'none', '0', ''].includes(v.trim().toLowerCase()) : v),
  z.boolean(),
);
/** An arc's arrowhead: a flag, or the words a line uses ("end", "both", "none"). */
const arcArrow = z.preprocess((v) => (typeof v === 'string' && ['end', 'both', 'start'].includes(v.trim().toLowerCase()) ? true : v), flag);

const base = { id, color: z.enum(COLORS).optional().catch(undefined), emphasis: flag.optional() };

const elementSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('line'), x1: coord, y1: coord, x2: coord, y2: coord, dashed: flag.optional(), arrow: z.enum(['none', 'end', 'both']).optional() }).strip(),
  z.object({ ...base, kind: z.literal('rect'), x: coord, y: coord, w: z.number().positive(), h: z.number().positive(), fill: flag.optional() }).strip(),
  z.object({ ...base, kind: z.literal('circle'), cx: coord, cy: coord, r: z.number().positive(), fill: flag.optional() }).strip(),
  z.object({ ...base, kind: z.literal('ellipse'), cx: coord, cy: coord, rx: z.number().positive(), ry: z.number().positive(), fill: flag.optional() }).strip(),
  z.object({ ...base, kind: z.literal('polygon'), points: z.array(point).min(3).max(SCENE_LIMITS.polyPoints), fill: flag.optional() }).strip(),
  z.object({ ...base, kind: z.literal('polyline'), points: z.array(point).min(2).max(SCENE_LIMITS.polyPoints), arrow: z.enum(['none', 'end']).optional(), dashed: flag.optional() }).strip(),
  z.object({ ...base, kind: z.literal('arc'), cx: coord, cy: coord, r: z.number().positive(), startDeg: coord, endDeg: coord, arrow: arcArrow.optional() }).strip(),
  z.object({ ...base, kind: z.literal('text'), x: coord, y: coord, text: label, size: z.enum(['sm', 'md', 'lg']).optional(), anchor: z.enum(['start', 'middle', 'end']).optional() }).strip(),
  z
    .object({
      ...base,
      kind: z.literal('axes'),
      x: coord,
      y: coord,
      w: z.number().positive(),
      h: z.number().positive(),
      xMin: coord,
      xMax: coord,
      yMin: coord,
      yMax: coord,
      xLabel: label.optional(),
      yLabel: label.optional(),
      grid: flag.optional(),
    })
    .strip(),
  z.object({ ...base, kind: z.literal('plot'), axesId: id, fn: z.string().max(200).optional(), points: z.array(point).min(2).max(200).optional(), dashed: flag.optional(), label: label.optional() }).strip(),
  z.object({ ...base, kind: z.literal('point'), axesId: id.optional(), x: coord, y: coord, label: label.optional() }).strip(),
  z.object({ ...base, kind: z.literal('motion'), targetId: id, path: z.array(point).min(2).max(20), durationMs: z.number().int().min(500).max(8000) }).strip(),
]);

export type SceneElement = z.infer<typeof elementSchema>;

const sceneSchema = z
  .object({
    width: z.number().int().min(200).max(800),
    height: z.number().int().min(150).max(600),
    elements: z.array(elementSchema).min(1).max(SCENE_LIMITS.elements),
    steps: z
      .array(z.object({ caption: z.string().trim().min(1).max(SCENE_LIMITS.caption), show: z.array(id).min(1).max(SCENE_LIMITS.elements) }).strip())
      .max(SCENE_LIMITS.steps)
      .optional(),
    loop: flag.optional(),
  })
  .strip();

export type Scene = z.infer<typeof sceneSchema>;

const replySchema = z
  .object({
    concept: z.string().trim().min(1).max(300),
    useful: z.boolean(),
    reason: z.string().trim().min(1).max(600),
    format: z.enum(VISUAL_FORMATS),
    mustNotShow: z.array(z.string().trim().max(200)).max(10).default([]),
    title: z.string().trim().max(120).default(''),
    caption: z.string().trim().max(SCENE_LIMITS.caption).default(''),
    imagePrompt: z.string().trim().max(1000).nullish(),
    scene: sceneSchema.nullish(),
  })
  .strip();

export type VisualReply = z.infer<typeof replySchema>;

export function parseVisualReply(raw: string): { ok: true; value: VisualReply } | { ok: false; reason: string } {
  const json = extractJsonObject(raw);
  if (json === null) return { ok: false, reason: 'reply contained no JSON object' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'reply was not valid JSON' };
  }
  const result = replySchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: result.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  return { ok: true, value: result.data };
}

/** A plot after validation: its formula sampled into drawable segments, in data coordinates. */
export type ResolvedElement = SceneElement | (Extract<SceneElement, { kind: 'plot' }> & { segments: [number, number][][] });

export interface VisualValidation {
  ok: boolean;
  failures: string[];
  /** The scene with plots resolved to segments, ready to store and draw. Null when there is none. */
  scene: (Omit<Scene, 'elements'> & { elements: ResolvedElement[] }) | null;
  leaks: string[];
}

const DRAWN_FORMATS: readonly VisualFormat[] = ['diagram', 'graph', 'step_by_step', 'animation', 'illustration'];

/**
 * Validates a visual reply. `answer` is the question's authoritative key: it is used here, to check the
 * output, and is never put in front of the model.
 */
export function validateVisual(reply: VisualReply, answer: LeakAnswer): VisualValidation {
  const failures: string[] = [];

  // The decision must be coherent with itself.
  if (!reply.useful && reply.format !== 'none') failures.push('the analysis says a visual is not useful but chose a format');
  if (reply.useful && reply.format === 'none') failures.push('the analysis says a visual is useful but chose no format');
  if (DRAWN_FORMATS.includes(reply.format) && !reply.scene) failures.push(`format ${reply.format} needs a scene`);
  if (reply.format === 'image' && !reply.imagePrompt && !reply.scene) failures.push('an image needs an image prompt or a fallback scene');
  if (reply.format !== 'none' && reply.title.length === 0) failures.push('a visual needs a title');

  let scene: VisualValidation['scene'] = null;
  if (reply.scene && reply.format !== 'none') {
    const s = reply.scene;
    const ids = new Set<string>();
    for (const e of s.elements) {
      if (ids.has(e.id)) failures.push(`element id "${e.id}" is used twice`);
      ids.add(e.id);
    }
    const axes = new Map(s.elements.filter((e): e is Extract<SceneElement, { kind: 'axes' }> => e.kind === 'axes').map((a) => [a.id, a]));
    const within = (x: number, y: number) => x >= -0.1 * s.width && x <= 1.1 * s.width && y >= -0.1 * s.height && y <= 1.1 * s.height;

    const resolved: ResolvedElement[] = [];
    for (const e of s.elements) {
      switch (e.kind) {
        case 'line':
          if (!within(e.x1, e.y1) || !within(e.x2, e.y2)) failures.push(`line ${e.id} is outside the scene`);
          break;
        case 'rect':
          if (!within(e.x, e.y) || !within(e.x + e.w, e.y + e.h)) failures.push(`rect ${e.id} is outside the scene`);
          break;
        case 'circle':
          if (!within(e.cx, e.cy) || e.r > Math.max(s.width, s.height)) failures.push(`circle ${e.id} is outside the scene`);
          break;
        case 'ellipse':
          if (!within(e.cx, e.cy)) failures.push(`ellipse ${e.id} is outside the scene`);
          break;
        case 'polygon':
        case 'polyline':
          if (e.points.some(([x, y]) => !within(x, y))) failures.push(`${e.kind} ${e.id} is outside the scene`);
          break;
        case 'arc':
          if (!within(e.cx, e.cy)) failures.push(`arc ${e.id} is outside the scene`);
          break;
        case 'text':
          if (!within(e.x, e.y)) failures.push(`text ${e.id} is outside the scene`);
          break;
        case 'axes':
          if (!(e.xMin < e.xMax) || !(e.yMin < e.yMax)) failures.push(`axes ${e.id} have an empty range`);
          if (!within(e.x, e.y) || !within(e.x + e.w, e.y + e.h)) failures.push(`axes ${e.id} are outside the scene`);
          break;
        case 'plot': {
          const a = axes.get(e.axesId);
          if (!a) {
            failures.push(`plot ${e.id} refers to missing axes ${e.axesId}`);
            break;
          }
          if (!e.fn && !e.points) {
            failures.push(`plot ${e.id} has neither a formula nor points`);
            break;
          }
          let segments: [number, number][][] = [];
          if (e.fn) {
            const compiled = compileExpression(e.fn);
            if (!compiled.ok) {
              failures.push(`plot ${e.id}: ${compiled.reason}`);
              break;
            }
            segments = sampleCurve(compiled.fn, a);
            if (segments.length === 0) failures.push(`plot ${e.id} has no point inside its axes`);
          } else if (e.points) {
            segments = [e.points.filter(([x, y]) => x >= a.xMin && x <= a.xMax && y >= a.yMin && y <= a.yMax)];
            if (segments[0]!.length < 2) failures.push(`plot ${e.id} has no point inside its axes`);
          }
          resolved.push({ ...e, segments });
          continue;
        }
        case 'point': {
          if (e.axesId) {
            const a = axes.get(e.axesId);
            if (!a) failures.push(`point ${e.id} refers to missing axes ${e.axesId}`);
            else if (e.x < a.xMin || e.x > a.xMax || e.y < a.yMin || e.y > a.yMax) failures.push(`point ${e.id} is outside its axes`);
          } else if (!within(e.x, e.y)) failures.push(`point ${e.id} is outside the scene`);
          break;
        }
        case 'motion':
          if (!ids.has(e.targetId)) failures.push(`motion ${e.id} moves unknown element ${e.targetId}`);
          if (e.path.some(([x, y]) => !within(x, y))) failures.push(`motion ${e.id} leaves the scene`);
          break;
      }
      resolved.push(e);
    }
    for (const [i, step] of (s.steps ?? []).entries()) {
      for (const ref of step.show) if (!ids.has(ref)) failures.push(`step ${i + 1} shows unknown element ${ref}`);
    }
    if (reply.format === 'graph' && (axes.size === 0 || !s.elements.some((e) => e.kind === 'plot' || e.kind === 'point'))) {
      failures.push('a graph needs axes and something plotted on them');
    }
    if (reply.format === 'step_by_step' && (s.steps?.length ?? 0) < 2) failures.push('a step-by-step visual needs at least two steps');
    if (reply.format === 'animation' && (s.steps?.length ?? 0) < 2 && !s.elements.some((e) => e.kind === 'motion')) {
      failures.push('an animation needs steps or a motion path');
    }
    scene = { ...s, elements: resolved };
  }

  // Everything the student will read, checked against the key.
  const texts = [
    reply.title,
    reply.caption,
    reply.concept,
    reply.reason,
    reply.imagePrompt ?? '',
    ...(reply.scene?.elements ?? []).flatMap((e) => {
      if (e.kind === 'text') return [e.text];
      if (e.kind === 'axes') return [e.xLabel ?? '', e.yLabel ?? ''];
      if (e.kind === 'plot' || e.kind === 'point') return [e.label ?? ''];
      return [];
    }),
    ...(reply.scene?.steps ?? []).map((s) => s.caption),
  ].filter((t) => t.length > 0);
  const leaks = [...new Set(texts.flatMap((t) => findAnswerLeaks(t, answer).map((l) => l.detail)))];
  for (const leak of leaks) failures.push(`answer leak: ${leak}`);

  return { ok: failures.length === 0, failures, scene, leaks };
}
