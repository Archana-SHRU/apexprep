/**
 * Deterministic label layout for visual-explanation scenes.
 *
 * Scenes are drawn from coordinates a model chose, and models place labels approximately: live scenes put
 * "Discs rotate together" on top of "Disc P (spinning)", and labels past the edge of the drawing. This pass
 * fixes that at render time, for every scene including ones already cached, without changing the stored
 * schema: it only moves, shrinks or wraps label text.
 *
 *   1. **Fit** — a label wider than the scene is shrunk (down to a readable minimum), then wrapped.
 *   2. **Contain** — its box is moved back inside the scene, keeping its anchor.
 *   3. **Separate** — labels are placed top to bottom; one that would overlap an already placed label tries
 *      a fixed sequence of nearby positions and takes the first free one (or the least overlapping).
 *
 * Text width is estimated, not measured — there is no DOM in a server render or a test — with a deliberately
 * generous per-character width, so estimated boxes are at least as large as the real ones. Pure and
 * deterministic: the same scene always lays out the same way.
 */

export type Anchor = 'start' | 'middle' | 'end'

export interface LabelInput {
  id: string
  x: number
  y: number
  text: string
  size: number
  anchor: Anchor
}

export interface PlacedLabel {
  id: string
  /** Where to draw the first line's baseline, with the label's own anchor. */
  x: number
  y: number
  size: number
  anchor: Anchor
  lines: string[]
}

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

const PAD = 4
const MIN_SIZE = 9
const CHAR_WIDTH = 0.6 // of the font size; generous for proportional fonts
const LINE_HEIGHT = 1.2
const GAP = 2

export const textWidth = (text: string, size: number): number => Array.from(text).length * size * CHAR_WIDTH

function wrap(text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (line && textWidth(next, size) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : [text]
}

function boxOf(x: number, y: number, size: number, anchor: Anchor, lines: string[]): Box {
  const width = Math.max(...lines.map((l) => textWidth(l, size)))
  const left = anchor === 'start' ? x : anchor === 'middle' ? x - width / 2 : x - width
  return { left, right: left + width, top: y - size * 0.85, bottom: y + (lines.length - 1) * size * LINE_HEIGHT + size * 0.3 }
}

const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left) + GAP) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + GAP)

export function layoutLabels(scene: { width: number; height: number }, labels: readonly LabelInput[]): Map<string, PlacedLabel> {
  const maxWidth = scene.width - 2 * PAD
  // Top to bottom, then left to right: the natural reading order, and a stable one.
  const ordered = [...labels].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  const placed: Box[] = []
  const out = new Map<string, PlacedLabel>()

  for (const label of ordered) {
    // 1. Fit.
    let size = label.size
    if (textWidth(label.text, size) > maxWidth) size = Math.max(MIN_SIZE, Math.floor((maxWidth / (Array.from(label.text).length * CHAR_WIDTH)) * 10) / 10)
    const lines = textWidth(label.text, size) > maxWidth ? wrap(label.text, size, maxWidth) : [label.text]

    // 2 + 3. Contain, then separate: try nearby positions in a fixed order.
    const contained = (x: number, y: number) => {
      const b = boxOf(x, y, size, label.anchor, lines)
      const dx = b.left < PAD ? PAD - b.left : b.right > scene.width - PAD ? scene.width - PAD - b.right : 0
      const dy = b.top < PAD ? PAD - b.top : b.bottom > scene.height - PAD ? scene.height - PAD - b.bottom : 0
      return { x: x + dx, y: y + dy, box: boxOf(x + dx, y + dy, size, label.anchor, lines) }
    }
    const first = contained(label.x, label.y)
    const step = first.box.bottom - first.box.top + GAP
    const width = first.box.right - first.box.left + GAP
    const offsets: [number, number][] = [[0, 0]]
    for (let k = 1; k <= 4; k += 1) offsets.push([0, k * step], [0, -k * step])
    for (const dx of [width, -width]) for (let k = 0; k <= 2; k += 1) offsets.push([dx, k * step], [dx, -k * step])

    let best = first
    let bestOverlap = Infinity
    for (const [dx, dy] of offsets) {
      const candidate = contained(first.x + dx, first.y + dy)
      const total = placed.reduce((sum, b) => sum + overlap(candidate.box, b), 0)
      if (total < bestOverlap) {
        best = candidate
        bestOverlap = total
      }
      if (total === 0) break
    }
    placed.push(best.box)
    out.set(label.id, { id: label.id, x: round(best.x), y: round(best.y), size, anchor: label.anchor, lines })
  }
  return out
}

/** The axis-aligned boxes of placed labels, for tests and diagnostics. */
export function placedBox(label: PlacedLabel): Box {
  return boxOf(label.x, label.y, label.size, label.anchor, label.lines)
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
}

function round(v: number): number {
  return Math.round(v * 10) / 10
}
