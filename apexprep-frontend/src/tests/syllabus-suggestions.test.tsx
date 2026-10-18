import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { SuggestionLevel, SyllabusSuggestion } from '@/lib/admin-content'
import { HierarchyStatus, SuggestedSyllabusPanel } from '@/pages/admin/SuggestedSyllabus'
import { expect, runTests, test } from './harness'

/**
 * The "Suggested Syllabus" section of Content Review: what each state shows, and that it never hides whether a
 * level is new, existing or not stated in the PDF.
 */

const level = (over: Partial<SuggestionLevel>): SuggestionLevel => ({
  name: null,
  state: 'unresolved',
  existingId: null,
  existingName: null,
  existingStatus: null,
  createdId: null,
  evidence: null,
  ...over,
})

const suggestion = (over: Partial<SyllabusSuggestion> = {}): SyllabusSuggestion => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  jobId: '00000000-0000-4000-8000-0000000000bb',
  status: 'pending',
  trackId: 't',
  trackName: 'Class 9',
  subjectId: 's',
  subjectName: 'Physics',
  chapter: level({ name: 'Motion', state: 'new', evidence: { heading: '3 Motion', page: 1 } }),
  topic: level({ name: 'Distance and Displacement', state: 'existing', existingId: 'x', existingName: 'Distance & Displacement', existingStatus: 'published', evidence: { heading: '3.1 Distance and Displacement', page: 1 } }),
  subtopic: level({ name: 'Average Speed', state: 'new', evidence: { heading: '3.1.1 Average Speed', page: 2 } }),
  confidence: 0.9,
  mappingReason: 'chapter "Motion" is new; topic matches existing; sub-topic "Average Speed" is new',
  evidence: { method: 'numbered', notes: [] },
  linkedBlocks: 3,
  needsNames: false,
  reviewedBy: null,
  reviewedAt: null,
  rejectionReason: null,
  createdAt: '2026-10-05T00:00:00.000Z',
  ...over,
})

const render = (node: React.ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>).replace(/<!-- -->/g, '')
const noop = () => undefined

test('shows the Suggested Syllabus with track, subject, every level, NEW vs EXISTING, evidence and counts', () => {
  const html = render(<SuggestedSyllabusPanel hierarchy={{ status: 'detected', method: 'numbered', blocksAwaitingApproval: 3 }} suggestions={[suggestion()]} busyId={null} onApprove={noop} onReject={noop} />)
  expect(html.includes('Suggested Syllabus'), 'section heading missing')
  expect(html.includes('Class 9 › Physics'), 'track and subject missing')
  for (const name of ['Motion', 'Distance and Displacement', 'Average Speed']) expect(html.includes(name), `${name} missing`)
  expect((html.match(/>New</g) ?? []).length === 2 && (html.match(/>Existing</g) ?? []).length === 1, 'NEW/EXISTING badges wrong')
  expect(html.includes('From “3 Motion” · page 1'), 'heading evidence missing')
  expect(html.includes('matches existing “Distance &amp; Displacement”'), 'existing match missing')
  expect(html.includes('confidence 90%') && html.includes('3 linked blocks'), 'confidence or linked count missing')
  expect(html.includes('Why: chapter'), 'reason missing')
  expect(html.includes('Approve') && html.includes('Edit &amp; Approve') && html.includes('Reject'), 'actions missing')
})

test('a level the PDF does not state is shown as unresolved, and plain Approve is disabled', () => {
  const html = render(
    <SuggestedSyllabusPanel hierarchy={null} suggestions={[suggestion({ subtopic: level({}), needsNames: true })]} busyId={null} onApprove={noop} onReject={noop} />,
  )
  expect(html.includes('Unresolved') && html.includes('Not stated in the PDF'), 'unresolved level not shown')
  expect(/<button[^>]*disabled[^>]*title="A level is not stated in the PDF/.test(html), 'Approve should be disabled until the name is entered')
})

test('"Hierarchy needs review" is shown clearly when the PDF does not state its structure', () => {
  const html = render(
    <SuggestedSyllabusPanel hierarchy={{ status: 'needs_review', method: 'none', notes: ['no numbered or "Chapter N" headings were found.'] }} suggestions={[]} busyId={null} onApprove={noop} onReject={noop} />,
  )
  expect(html.includes('Hierarchy needs review'), 'needs-review notice missing')
  expect(html.includes('Nothing was invented'), 'the notice should say nothing was invented')
  expect(html.includes('href="/admin/syllabus"'), 'no way to the manual syllabus page')
})

test('decided suggestions show their outcome and offer no actions', () => {
  const html = render(
    <SuggestedSyllabusPanel
      hierarchy={null}
      suggestions={[suggestion({ status: 'rejected', rejectionReason: 'not in this course' })]}
      busyId={null}
      onApprove={noop}
      onReject={noop}
    />,
  )
  expect(html.includes('rejected') && html.includes('Rejected: not in this course'), 'rejection not shown')
  expect(!html.includes('Edit &amp; Approve'), 'a decided suggestion must not offer actions')
  expect(html.includes('All suggestions from this upload have been decided'), 'summary missing')
})

test('the shared status line', () => {
  expect(render(<HierarchyStatus hierarchy={{ status: 'needs_review', method: 'none' }} />).includes('Hierarchy needs review'), 'needs review')
  expect(render(<HierarchyStatus hierarchy={{ status: 'detected', method: 'numbered', blocksAwaitingApproval: 2 }} />).includes('2 blocks await syllabus approval'), 'detected')
  expect(render(<HierarchyStatus hierarchy={null} />) === '', 'nothing before processing')
})

await runTests('suggested syllabus')
