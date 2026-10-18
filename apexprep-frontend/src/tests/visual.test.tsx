import { renderToString } from 'react-dom/server'
import { SceneRenderer } from '@/components/learning/SceneRenderer'
import { VisualExplanationPanel } from '@/components/learning/VisualExplanationPanel'
import type { Scene } from '@/lib/learning-ai'
import { expect, runTests, test } from './harness'

/**
 * "Explain visually" on the client: it is the student's choice, and a scene can only ever draw.
 *
 * The scene arrives validated by the server, but the renderer is the last line: whatever text a scene carries
 * is rendered as SVG text by React, so markup in a label is shown as characters, never interpreted.
 */

test('the panel starts as a button: no visual is requested or shown until the student asks', () => {
  let requests = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => {
    requests += 1
    return Promise.reject(new Error('no network in tests'))
  }) as typeof fetch
  try {
    const html = renderToString(<VisualExplanationPanel questionId="00000000-0000-4000-8000-000000000001" />)
    expect(html.includes('Explain visually'), 'the Explain visually button is missing')
    expect(!html.includes('<svg') || html.split('<svg').length - 1 === 1, 'a visual was drawn before the student asked')
    expect(!html.includes('Back to question'), 'the visual panel opened by itself')
    expect(requests === 0, 'a request was made before the student asked')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('scene text is rendered as text: markup in a label cannot execute', () => {
  const scene: Scene = {
    width: 300,
    height: 200,
    elements: [
      { id: 't', kind: 'text', x: 10, y: 20, text: '<script>alert(1)</script><img src=x onerror=alert(2)>' },
      { id: 'r', kind: 'rect', x: 10, y: 40, w: 100, h: 50 },
    ],
  }
  const html = renderToString(<SceneRenderer scene={scene} animate={false} title="Test <b>title</b>" />)
  expect(!html.includes('<script>'), 'a script tag reached the output')
  expect(!html.includes('<img'), 'an img tag reached the output')
  expect(html.includes('&lt;script&gt;'), 'the label text was not rendered as escaped text')
  // The escaped label may contain the characters "onerror=" as text; what must not exist is such an attribute
  // inside a real tag. Escaped text cannot contain "<", so every "<" in the output opens a genuine tag.
  expect(!/<[^>]*\son[a-z]+\s*=/i.test(html), 'an event handler attribute reached a real tag')
})

test('a graph draws the server-sampled points, and steps show one at a time', () => {
  const scene: Scene = {
    width: 400,
    height: 300,
    elements: [
      { id: 'ax', kind: 'axes', x: 40, y: 20, w: 320, h: 240, xMin: 0, xMax: 10, yMin: 0, yMax: 30 },
      { id: 'p', kind: 'plot', axesId: 'ax', segments: [[[0, 8], [5, 18], [10, 28]]] },
      { id: 'a', kind: 'text', x: 50, y: 50, text: 'first' },
      { id: 'b', kind: 'text', x: 50, y: 80, text: 'second' },
    ],
    steps: [
      { caption: 'Step one', show: ['a'] },
      { caption: 'Step two', show: ['a', 'b'] },
    ],
  }
  const html = renderToString(<SceneRenderer scene={scene} animate={false} title="Graph" />)
  expect(html.includes('<polyline'), 'the plot was not drawn')
  expect(html.includes('first') && !html.includes('second'), 'step one should show only its own elements')
  // React's server render separates adjacent text nodes with <!-- --> markers.
  expect(html.replace(/<!-- -->/g, '').includes('Step 1 of 2'), 'the step controls are missing')
})

await runTests('explain visually')
