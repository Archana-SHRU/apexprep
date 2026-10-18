import { renderToString } from 'react-dom/server'
import { SceneRenderer } from '@/components/learning/SceneRenderer'
import type { Scene } from '@/lib/learning-ai'
import { boxesOverlap, layoutLabels, placedBox, textWidth, type LabelInput } from '@/lib/scene-layout'
import { expect, runTests, test } from './harness'

/** Label layout for AI-drawn scenes: inside the bounds, not on top of each other, readable, deterministic. */

const SCENE = { width: 520, height: 300 }
const label = (id: string, x: number, y: number, text: string, anchor: LabelInput['anchor'] = 'start', size = 12): LabelInput => ({ id, x, y, text, size, anchor })

function noOverlaps(placed: ReturnType<typeof layoutLabels>): string | null {
  const all = [...placed.values()]
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (boxesOverlap(placedBox(all[i]!), placedBox(all[j]!))) return `${all[i]!.id} overlaps ${all[j]!.id}`
    }
  }
  return null
}

function inside(placed: ReturnType<typeof layoutLabels>, scene = SCENE): string | null {
  for (const p of placed.values()) {
    const b = placedBox(p)
    if (b.left < 0 || b.top < 0 || b.right > scene.width || b.bottom > scene.height) return `${p.id} is outside the scene`
  }
  return null
}

test('separates the labels that overlapped in a live scene (discs coupling, visual 0009)', () => {
  // The three labels the model stacked on top of each other, at their original coordinates.
  const placed = layoutLabels(SCENE, [
    label('together', 360, 190, 'Discs rotate together'),
    label('speed', 360, 198, 'Common speed = ω_f'),
    label('discP', 360, 202, 'Disc P (spinning)'),
    label('IP', 360, 216, 'I_P = 0.5 kg·m²'),
  ])
  expect(noOverlaps(placed) === null, noOverlaps(placed) ?? '')
  expect(inside(placed) === null, inside(placed) ?? '')
})

test('leaves well-placed labels exactly where the scene put them', () => {
  const placed = layoutLabels(SCENE, [label('a', 40, 40, 'h'), label('b', 300, 120, 'v = ωR'), label('c', 100, 250, 'Rough floor')])
  expect(placed.get('a')!.x === 40 && placed.get('a')!.y === 40, 'a moved without reason')
  expect(placed.get('b')!.x === 300 && placed.get('b')!.y === 120, 'b moved without reason')
  expect(placed.get('c')!.x === 100 && placed.get('c')!.y === 250, 'c moved without reason')
})

test('pulls a label back inside the bounds, keeping its anchor', () => {
  const placed = layoutLabels(SCENE, [label('edge', 500, 10, 'Torque of friction about O', 'start'), label('bottom', 260, 299, 'Centre of mass', 'middle')])
  expect(inside(placed) === null, inside(placed) ?? '')
  expect(placed.get('edge')!.anchor === 'start', 'the anchor changed')
})

test('shrinks, then wraps, a label wider than the scene so it stays readable and inside', () => {
  const long = 'A uniform solid sphere of mass M and radius R is released from rest at the top of the incline and rolls down'
  const placed = layoutLabels({ width: 300, height: 200 }, [label('caption', 10, 30, long, 'start', 14)])
  const p = placed.get('caption')!
  expect(p.size >= 9, 'text shrank below the readable minimum')
  expect(p.lines.length > 1, 'a long label was not wrapped')
  expect(p.lines.every((l) => textWidth(l, p.size) <= 300 - 8), 'a wrapped line is still wider than the scene')
  expect(p.lines.join(' ') === long, 'wrapping changed the words')
  expect(inside(placed, { width: 300, height: 200 }) === null, inside(placed, { width: 300, height: 200 }) ?? '')
})

test('is deterministic: the same scene always lays out the same way', () => {
  const input = [label('x', 200, 100, 'first'), label('y', 202, 101, 'second'), label('z', 198, 99, 'third')]
  const a = JSON.stringify([...layoutLabels(SCENE, input).values()])
  const b = JSON.stringify([...layoutLabels(SCENE, [...input].reverse()).values()].sort((p, q) => p.id.localeCompare(q.id)))
  const a2 = JSON.stringify([...layoutLabels(SCENE, input).values()].sort((p, q) => p.id.localeCompare(q.id)))
  expect(a === JSON.stringify([...layoutLabels(SCENE, input).values()]), 'two runs differed')
  expect(a2 === b, 'input order changed the layout')
})

test('the renderer draws laid-out labels as escaped text with a readability halo, and old scenes still render', () => {
  const scene: Scene = {
    width: 400,
    height: 220,
    elements: [
      { id: 'r', kind: 'rect', x: 40, y: 40, w: 200, h: 100 },
      { id: 't1', kind: 'text', x: 60, y: 60, text: '<b>Disc P</b>' },
      { id: 't2', kind: 'text', x: 60, y: 62, text: 'Disc Q' },
      { id: 'ax', kind: 'axes', x: 260, y: 20, w: 120, h: 150, xMin: 0, xMax: 4, yMin: 0, yMax: 16 },
      { id: 'pt', kind: 'point', axesId: 'ax', x: 2, y: 4, label: 'P' },
    ],
  }
  const html = renderToString(<SceneRenderer scene={scene} animate={false} title="Discs" />)
  expect(html.includes('&lt;b&gt;Disc P&lt;/b&gt;'), 'label text was not escaped')
  expect(!html.includes('<b>'), 'markup from a label reached the output')
  expect(html.includes('paint-order:stroke'), 'labels have no readability halo')
  const ys = [...html.matchAll(/<text x="60" y="([\d.]+)"/g)].map((m) => Number(m[1]))
  expect(ys.length === 2 && Math.abs(ys[0]! - ys[1]!) >= 12, `the two overlapping labels were not separated (${ys.join(', ')})`)
})

await runTests('scene label layout')
