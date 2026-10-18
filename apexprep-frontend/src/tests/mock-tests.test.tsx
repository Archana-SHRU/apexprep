import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import Tests from '@/pages/Tests'
import { expect, runTests, test } from './harness'

test('mock tests page renders title, filter tabs, and exam simulation guidelines', () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch

  try {
    const html = renderToString(
      <MemoryRouter>
        <Tests />
      </MemoryRouter>,
    )

    expect(html.includes('Mock Tests'), 'Mock Tests title is missing')
    expect(html.includes('Full Length Papers'), 'Full Length Papers filter tab is missing')
    expect(html.includes('Sectional Tests'), 'Sectional Tests filter tab is missing')
    expect(html.includes('Exam Simulation Features'), 'Exam Simulation Features banner is missing')
    expect(html.includes('+4 for correct'), 'Marking scheme explanation is missing')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('mock test score percentage and negative marking math', () => {
  const totalMarks = 300
  const correctCount = 45
  const incorrectCount = 15
  const positivePerQ = 4
  const negativePerQ = 1

  const scored = correctCount * positivePerQ - incorrectCount * negativePerQ // 180 - 15 = 165
  expect(scored === 165, `Expected score 165, got ${scored}`)

  const accuracy = Number(((correctCount / (correctCount + incorrectCount)) * 100).toFixed(2)) // 75%
  expect(accuracy === 75, `Expected accuracy 75%, got ${accuracy}`)

  const percentage = Number(((scored / totalMarks) * 100).toFixed(2)) // 55%
  expect(percentage === 55, `Expected percentage 55%, got ${percentage}`)
})

await runTests('mock tests')
