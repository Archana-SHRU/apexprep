import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui'
import type { Scene, SceneColor, SceneElement } from '@/lib/learning-ai'
import { layoutLabels, type LabelInput, type PlacedLabel } from '@/lib/scene-layout'

/**
 * Draws a visual explanation's scene as SVG.
 *
 * The scene is data the backend validated against a closed schema; this component turns each known element
 * kind into SVG with React and nothing else — no HTML strings, no `dangerouslySetInnerHTML`, no scripts — so
 * there is nothing in a scene that can execute. Plots arrive already sampled into points by the server.
 *
 * Steps: an element named in any step is shown only while the current step lists it; everything else is the
 * backdrop and always visible. An animation advances through the steps on its own (unless the learner prefers
 * reduced motion) and plays any motion paths; a step-by-step visual waits for the learner.
 */

const PALETTE: Record<SceneColor, string> = {
  ink: '#0B132B',
  primary: '#4361EE',
  accent: '#F59E0B',
  muted: '#64748B',
  success: '#10B981',
  warning: '#EF4444',
}
const colorOf = (e: { color?: SceneColor }) => PALETTE[e.color ?? 'ink']
const FONT = { sm: 11, md: 14, lg: 18 } as const
const STEP_MS = 2400

type Axes = Extract<SceneElement, { kind: 'axes' }>

export function SceneRenderer({ scene, animate, title }: { scene: Scene; animate: boolean; title: string }) {
  const steps = scene.steps ?? []
  const [step, setStep] = useState(0)
  const reducedMotion = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, [])
  const [playing, setPlaying] = useState(animate && !reducedMotion)

  useEffect(() => {
    if (!playing || steps.length < 2) return
    const id = setInterval(() => {
      setStep((s) => {
        if (s + 1 < steps.length) return s + 1
        if (scene.loop) return 0
        setPlaying(false)
        return s
      })
    }, STEP_MS)
    return () => clearInterval(id)
  }, [playing, steps.length, scene.loop])

  const stepped = useMemo(() => new Set(steps.flatMap((s) => s.show)), [steps])
  const visible = (id: string) => steps.length === 0 || !stepped.has(id) || (steps[step]?.show.includes(id) ?? false)
  const axes = useMemo(() => new Map(scene.elements.filter((e): e is Axes => e.kind === 'axes').map((a) => [a.id, a])), [scene.elements])
  const motions = useMemo(
    () => new Map(scene.elements.filter((e): e is Extract<SceneElement, { kind: 'motion' }> => e.kind === 'motion').map((m) => [m.targetId, m])),
    [scene.elements],
  )
  const colors = [...new Set(scene.elements.map(colorOf))]
  // Every label's final position, computed once for the whole scene so it does not jump between steps.
  const layout = useMemo(() => layoutLabels(scene, labelsOf(scene.elements, axes)), [scene, axes])

  return (
    <div>
      <svg viewBox={`0 0 ${scene.width} ${scene.height}`} className="h-auto w-full rounded border border-line bg-canvas" role="img"
        aria-label={[title, steps[step]?.caption].filter(Boolean).join('. ')}>
        <defs>
          {colors.map((c) => (
            <marker key={c} id={markerId(c)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
            </marker>
          ))}
        </defs>
        {scene.elements.map((e) => {
          if (e.kind === 'motion' || !visible(e.id)) return null
          const motion = motions.get(e.id)
          const drawn = <Element key={e.id} e={e} axes={axes} layout={layout} />
          if (!motion || !playing) return drawn
          const [x0, y0] = motion.path[0]!
          const d = motion.path.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x - x0} ${y - y0}`).join(' ')
          return (
            <g key={e.id}>
              {drawn}
              <animateMotion dur={`${motion.durationMs}ms`} repeatCount={scene.loop ? 'indefinite' : '1'} fill="freeze" path={d} />
            </g>
          )
        })}
      </svg>

      {steps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)) }} disabled={step === 0} aria-label="Previous step">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="font-mono text-label-sm text-ink-muted">Step {step + 1} of {steps.length}</span>
          <Button variant="secondary" size="sm" onClick={() => { setPlaying(false); setStep((s) => Math.min(steps.length - 1, s + 1)) }} disabled={step >= steps.length - 1} aria-label="Next step">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          {animate && steps.length > 1 && (
            <Button variant="ghost" size="sm" onClick={() => { if (!playing && step >= steps.length - 1) setStep(0); setPlaying((p) => !p) }}>
              {playing ? <><Pause className="h-3.5 w-3.5" /> Pause</> : <><Play className="h-3.5 w-3.5" /> Play</>}
            </Button>
          )}
          <p className="w-full text-body-sm text-ink-soft" aria-live="polite">{steps[step]?.caption}</p>
        </div>
      )}
    </div>
  )
}

function markerId(color: string): string {
  return `arrow-${color.replace('#', '')}`
}

/** Data coordinates on a set of axes → scene pixels (SVG y grows downwards). */
function toPixels(a: Axes, x: number, y: number): [number, number] {
  return [a.x + ((x - a.xMin) / (a.xMax - a.xMin)) * a.w, a.y + a.h - ((y - a.yMin) / (a.yMax - a.yMin)) * a.h]
}

function Element({ e, axes, layout }: { e: SceneElement; axes: Map<string, Axes>; layout: Map<string, PlacedLabel> }) {
  const stroke = colorOf(e)
  const width = e.emphasis ? 3 : 2
  const fillOf = (fill?: boolean) => (fill ? `${stroke}26` : 'none')
  const arrow = (end: boolean) => (end ? `url(#${markerId(stroke)})` : undefined)

  switch (e.kind) {
    case 'line':
      return (
        <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={stroke} strokeWidth={width} strokeDasharray={e.dashed ? '6 4' : undefined}
          markerEnd={arrow(e.arrow === 'end' || e.arrow === 'both')} markerStart={arrow(e.arrow === 'both')} />
      )
    case 'rect':
      return <rect x={e.x} y={e.y} width={e.w} height={e.h} stroke={stroke} strokeWidth={width} fill={fillOf(e.fill)} />
    case 'circle':
      return <circle cx={e.cx} cy={e.cy} r={e.r} stroke={stroke} strokeWidth={width} fill={fillOf(e.fill)} />
    case 'ellipse':
      return <ellipse cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} stroke={stroke} strokeWidth={width} fill={fillOf(e.fill)} />
    case 'polygon':
      return <polygon points={e.points.map((p) => p.join(',')).join(' ')} stroke={stroke} strokeWidth={width} fill={fillOf(e.fill)} />
    case 'polyline':
      return (
        <polyline points={e.points.map((p) => p.join(',')).join(' ')} stroke={stroke} strokeWidth={width} fill="none"
          strokeDasharray={e.dashed ? '6 4' : undefined} markerEnd={arrow(e.arrow === 'end')} />
      )
    case 'arc': {
      const rad = (d: number) => (d * Math.PI) / 180
      const [sx, sy] = [e.cx + e.r * Math.cos(rad(e.startDeg)), e.cy - e.r * Math.sin(rad(e.startDeg))]
      const [ex, ey] = [e.cx + e.r * Math.cos(rad(e.endDeg)), e.cy - e.r * Math.sin(rad(e.endDeg))]
      const sweep = e.endDeg - e.startDeg
      const large = Math.abs(sweep) % 360 > 180 ? 1 : 0
      // Counter-clockwise on screen (y down) is sweep-flag 0.
      return <path d={`M ${sx} ${sy} A ${e.r} ${e.r} 0 ${large} ${sweep > 0 ? 0 : 1} ${ex} ${ey}`} stroke={stroke} strokeWidth={width} fill="none" markerEnd={arrow(Boolean(e.arrow))} />
    }
    case 'text':
      return <Label placed={layout.get(e.id)} fill={stroke} weight={e.emphasis ? 600 : 400} />
    case 'axes': {
      const grid = e.grid ? [1, 2, 3, 4].map((i) => i / 5) : []
      const zeroX = e.xMin < 0 && e.xMax > 0 ? toPixels(e, 0, e.yMin)[0] : null
      const zeroY = e.yMin < 0 && e.yMax > 0 ? toPixels(e, e.xMin, 0)[1] : null
      return (
        <g>
          {grid.map((f) => <line key={`gx${f}`} x1={e.x + f * e.w} y1={e.y} x2={e.x + f * e.w} y2={e.y + e.h} stroke="#E2E8F0" />)}
          {grid.map((f) => <line key={`gy${f}`} x1={e.x} y1={e.y + f * e.h} x2={e.x + e.w} y2={e.y + f * e.h} stroke="#E2E8F0" />)}
          <rect x={e.x} y={e.y} width={e.w} height={e.h} fill="none" stroke="#CBD5E1" />
          {zeroX !== null && <line x1={zeroX} y1={e.y} x2={zeroX} y2={e.y + e.h} stroke="#64748B" />}
          {zeroY !== null && <line x1={e.x} y1={zeroY} x2={e.x + e.w} y2={zeroY} stroke="#64748B" />}
          <text x={e.x} y={e.y + e.h + 14} fontSize={10} fill="#64748B" fontFamily="monospace">{fmt(e.xMin)}</text>
          <text x={e.x + e.w} y={e.y + e.h + 14} fontSize={10} fill="#64748B" textAnchor="end" fontFamily="monospace">{fmt(e.xMax)}</text>
          <text x={e.x - 4} y={e.y + e.h} fontSize={10} fill="#64748B" textAnchor="end" fontFamily="monospace">{fmt(e.yMin)}</text>
          <text x={e.x - 4} y={e.y + 10} fontSize={10} fill="#64748B" textAnchor="end" fontFamily="monospace">{fmt(e.yMax)}</text>
          {e.xLabel && <text x={e.x + e.w / 2} y={e.y + e.h + 28} fontSize={12} fill="#1C2541" textAnchor="middle">{e.xLabel}</text>}
          {e.yLabel && <text x={e.x - 28} y={e.y + e.h / 2} fontSize={12} fill="#1C2541" textAnchor="middle" transform={`rotate(-90 ${e.x - 28} ${e.y + e.h / 2})`}>{e.yLabel}</text>}
        </g>
      )
    }
    case 'plot': {
      const a = axes.get(e.axesId)
      if (!a) return null
      return (
        <g>
          {e.segments.map((seg, i) => (
            <polyline key={i} points={seg.map(([x, y]) => toPixels(a, x, y).join(',')).join(' ')} stroke={stroke} strokeWidth={width} fill="none"
              strokeDasharray={e.dashed ? '6 4' : undefined} />
          ))}
          {e.label && <Label placed={layout.get(`${e.id}#label`)} fill={stroke} />}
        </g>
      )
    }
    case 'point': {
      const a = e.axesId ? axes.get(e.axesId) : undefined
      const [px, py] = a ? toPixels(a, e.x, e.y) : [e.x, e.y]
      return (
        <g>
          <circle cx={px} cy={py} r={e.emphasis ? 5 : 4} fill={stroke} />
          {e.label && <Label placed={layout.get(`${e.id}#label`)} fill={stroke} />}
        </g>
      )
    }
    case 'motion':
      return null
  }
}

/**
 * One laid-out label. React renders the text as text, so markup in a label is shown, never interpreted. The
 * white halo (stroke painted under the fill) keeps it readable where it crosses a line or a shape.
 */
function Label({ placed, fill, weight = 400 }: { placed: PlacedLabel | undefined; fill: string; weight?: number }) {
  if (!placed) return null
  return (
    <text x={placed.x} y={placed.y} fill={fill} fontSize={placed.size} textAnchor={placed.anchor} fontWeight={weight}
      fontFamily="Inter, system-ui, sans-serif" stroke="#FFFFFF" strokeWidth={3} strokeLinejoin="round" style={{ paintOrder: 'stroke' }}>
      {placed.lines.length === 1
        ? placed.lines[0]
        : placed.lines.map((line, i) => <tspan key={i} x={placed.x} dy={i === 0 ? 0 : placed.size * 1.2}>{line}</tspan>)}
    </text>
  )
}

/** Every label in a scene, in scene pixels, for the layout pass. */
function labelsOf(elements: SceneElement[], axes: Map<string, Axes>): LabelInput[] {
  const labels: LabelInput[] = []
  for (const e of elements) {
    if (e.kind === 'text') labels.push({ id: e.id, x: e.x, y: e.y, text: e.text, size: FONT[e.size ?? 'md'], anchor: e.anchor ?? 'start' })
    if (e.kind === 'point' && e.label) {
      const a = e.axesId ? axes.get(e.axesId) : undefined
      const [px, py] = a ? toPixels(a, e.x, e.y) : [e.x, e.y]
      labels.push({ id: `${e.id}#label`, x: px + 7, y: py - 7, text: e.label, size: 12, anchor: 'start' })
    }
    if (e.kind === 'plot' && e.label) {
      const a = axes.get(e.axesId)
      const last = e.segments[e.segments.length - 1]
      const end = last?.[last.length - 1]
      if (a && end) {
        const [lx, ly] = toPixels(a, end[0], end[1])
        labels.push({ id: `${e.id}#label`, x: lx - 4, y: ly - 6, text: e.label, size: 12, anchor: 'end' })
      }
    }
  }
  return labels
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}
