import { adminContent } from '@/lib/admin-content'
import { expect, runTests, test } from './harness'

/**
 * The document-approval client sends exactly what the backend's DTOs accept: the approval, the bulk values and a
 * block edit each go to their own route with the field names the API validates (`forbidNonWhitelisted` rejects
 * anything else). The live shapes are checked by the backend's `ingestion-approval.e2e-spec.ts`.
 */

interface Captured { url: string; method: string; body: unknown }

function stubFetch(respond: unknown): { captured: Captured; restore: () => void } {
  const realFetch = globalThis.fetch
  const captured: Captured = { url: '', method: '', body: undefined }
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    captured.url = String(url)
    captured.method = init?.method ?? 'GET'
    captured.body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return Promise.resolve(new Response(JSON.stringify(respond), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }) as typeof fetch
  return { captured, restore: () => void (globalThis.fetch = realFetch) }
}

test('Approve and Publish posts to the job with confirmFlagged and dryRun, and nothing else', async () => {
  const stub = stubFetch({ dryRun: true, suggestions: [], blocks: [], totals: { published: 0, confirmed: 0, skipped: 0, blocked: 0, failed: 0 }, complete: false, embeddings: null })
  try {
    await adminContent.approveDocument('job-1', { confirmFlagged: true, dryRun: true })
    expect(stub.captured.url.endsWith('/v1/admin/ingestion/jobs/job-1/approve'), 'must post to the job\'s approve route')
    expect(stub.captured.method === 'POST', 'approval is a POST')
    expect(JSON.stringify(stub.captured.body) === JSON.stringify({ confirmFlagged: true, dryRun: true }), 'body is {confirmFlagged, dryRun}')
  } finally {
    stub.restore()
  }
})

test('the bulk values are sent per question type and are never a hidden default', async () => {
  const stub = stubFetch({ updated: 2, questions: 2 })
  try {
    const res = await adminContent.applyDefaults('job-1', { expectedTimeSecondsByType: { single_correct: 90 } })
    expect(stub.captured.url.endsWith('/v1/admin/ingestion/jobs/job-1/defaults'), 'must post to the job\'s defaults route')
    expect(JSON.stringify(stub.captured.body) === JSON.stringify({ expectedTimeSecondsByType: { single_correct: 90 } }), 'only what the admin typed is sent')
    expect(res.updated === 2, 'the count is read from updated')
  } finally {
    stub.restore()
  }
})

test('a question edit is a PATCH of the block with the question patch the API validates', async () => {
  const stub = stubFetch({ id: 'b-1' })
  try {
    await adminContent.edit('b-1', { question: { confirmAnswer: true, acceptSuggested: true }, solutionText: 'Because.' })
    expect(stub.captured.url.endsWith('/v1/admin/ingestion/blocks/b-1'), 'must patch the block')
    expect(stub.captured.method === 'PATCH', 'an edit is a PATCH')
    expect(JSON.stringify(stub.captured.body) === JSON.stringify({ question: { confirmAnswer: true, acceptSuggested: true }, solutionText: 'Because.' }), 'body carries question and solutionText')
  } finally {
    stub.restore()
  }
})

test('the preview is read from the job\'s preview route', async () => {
  const stub = stubFetch({ job: { id: 'job-1' }, summary: { canApprove: true }, syllabus: { hierarchy: null, suggestions: [] }, blocks: [] })
  try {
    const res = await adminContent.preview('job-1')
    expect(stub.captured.url.endsWith('/v1/admin/ingestion/jobs/job-1/preview'), 'must get the preview route')
    expect(res.summary.canApprove === true, 'summary.canApprove is read from the response')
  } finally {
    stub.restore()
  }
})

await runTests('document approval client')
