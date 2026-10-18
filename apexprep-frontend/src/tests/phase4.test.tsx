import { api } from '@/lib/api'
import type { AskQuestionResponseDto, BenchmarkDto, DivergenceCheckResultDto, PurgeEventsResultDto } from '@/types/api'
import { expect, runTests, test } from './harness'

/**
 * What these exercise: the client sends exactly what the backend's DTOs accept — URL, query and body field
 * names — and reads the fields the backend really returns. The response fixtures here are the backend's own
 * shapes (see `test/e2e/frontend-contract.e2e-spec.ts` in the backend, which checks the live API against the
 * same field lists), not the client's idea of them.
 */

interface Captured {
  url: string
  method: string
  body: unknown
}

function stubFetch(status: number, respond: unknown): { captured: Captured; restore: () => void } {
  const realFetch = globalThis.fetch
  const captured: Captured = { url: '', method: '', body: undefined }
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    captured.url = String(url)
    captured.method = init?.method ?? 'GET'
    captured.body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return Promise.resolve(new Response(JSON.stringify(respond), { status, headers: { 'Content-Type': 'application/json' } }))
  }) as typeof fetch
  return { captured, restore: () => void (globalThis.fetch = realFetch) }
}

test('the peer benchmark is requested for a sub-topic and read in the backend\'s shape', async () => {
  const published: BenchmarkDto = {
    subtopicId: 'st-1',
    isPublished: true,
    qualifyingStudents: 42,
    minQualifyingStudents: 30,
    topK: 10,
    topAccuracy: 0.885,
    topMedianTimeSeconds: 65,
    snapshotDate: '2026-10-06',
  }
  const stub = stubFetch(200, published)
  try {
    const res = await api.getBenchmark('st-1')
    expect(stub.captured.url.includes('/v1/me/benchmark'), 'must call /v1/me/benchmark')
    expect(stub.captured.url.includes('subtopicId=st-1'), 'the backend refuses the request without a subtopicId')
    expect(res.isPublished && res.qualifyingStudents === 42, 'qualifying students must be read from qualifyingStudents')
    expect(res.topAccuracy === 0.885, 'accuracy is a fraction of 1')
    expect(res.topMedianTimeSeconds === 65, 'pace must be read from topMedianTimeSeconds')
  } finally {
    stub.restore()
  }
})

test('a withheld benchmark carries no figures, only the reason', async () => {
  const withheld: BenchmarkDto = {
    subtopicId: 'st-1',
    isPublished: false,
    qualifyingStudents: 14,
    minQualifyingStudents: 30,
    topK: 10,
    topAccuracy: null,
    topMedianTimeSeconds: null,
    snapshotDate: '2026-10-06',
    message: 'Peer benchmark is withheld: requires at least 30 qualifying learners (currently 14).',
  }
  const stub = stubFetch(200, withheld)
  try {
    const res = await api.getBenchmark('st-1')
    expect(res.isPublished === false, 'must be withheld')
    expect(res.topAccuracy === null && res.topMedianTimeSeconds === null, 'a withheld benchmark has no figures')
    expect(res.message?.includes('14'), 'the reason must be passed through')
  } finally {
    stub.restore()
  }
})

test('asking a doubt sends message and intent, and reads the backend\'s answer fields', async () => {
  const reply: AskQuestionResponseDto = {
    questionId: 'q-999',
    answer: 'The work done by a centripetal force is zero because the displacement is perpendicular to the force.',
    steps: ['The force acts towards the centre.', 'The displacement is along the tangent.'],
    grounded: true,
    source: 'official_solution',
    keyConcept: 'Work done by a perpendicular force',
    answeredAt: '2026-10-06T12:05:00Z',
  }
  const stub = stubFetch(200, reply)
  try {
    const res = await api.askQuestion('q-999', 'Why is the work done zero here?', 'why_wrong')
    expect(stub.captured.url.includes('/v1/questions/q-999/ask'), 'URL must name the question')
    expect(stub.captured.method === 'POST', 'must POST')
    expect(JSON.stringify(stub.captured.body) === JSON.stringify({ message: 'Why is the work done zero here?', intent: 'why_wrong' }), 'body must be message and intent')
    expect(res.grounded === true && res.source === 'official_solution', 'grounding is read from grounded and source')
    expect(res.answer.includes('centripetal') && res.steps.length === 2, 'the answer and steps must be read')
  } finally {
    stub.restore()
  }
})

test('the divergence check sends the backend\'s field names and reads its result', async () => {
  const result: DivergenceCheckResultDto = {
    scannedCount: 150,
    divergingCount: 1,
    tasksOpened: 1,
    divergences: [
      { questionId: 'q-1', stem: 'A block slides…', currentLabel: 2, suggestedLabel: 4, observedB: 1410, expectedB: 1000, delta: 410, calibrationN: 45, reviewTaskId: 'task-1' },
    ],
  }
  const stub = stubFetch(200, result)
  try {
    const res = await api.checkDivergence(250, 30)
    expect(stub.captured.url.includes('/v1/admin/questions/check-divergence'), 'must call check-divergence')
    expect(JSON.stringify(stub.captured.body) === JSON.stringify({ threshold: 250, minCalibrations: 30 }), 'body fields are threshold and minCalibrations (anything else is rejected with 400)')
    expect(res.divergingCount === 1 && res.divergences[0]!.delta === 410, 'the result must be read from divergingCount and divergences')
  } finally {
    stub.restore()
  }
})

test('the event purge sends olderThanDays and reads purgedCount', async () => {
  const result: PurgeEventsResultDto = { purgedCount: 1420, cutoffDate: '2025-10-06T00:00:00.000Z', tenantId: 't-1' }
  const stub = stubFetch(200, result)
  try {
    const res = await api.purgeEvents(365)
    expect(stub.captured.url.includes('/v1/admin/maintenance/purge-events'), 'must call purge-events')
    expect(JSON.stringify(stub.captured.body) === JSON.stringify({ olderThanDays: 365 }), 'body field is olderThanDays (anything else is rejected with 400)')
    expect(res.purgedCount === 1420, 'the count must be read from purgedCount')
  } finally {
    stub.restore()
  }
})

await runTests('phase 4 contracts')
