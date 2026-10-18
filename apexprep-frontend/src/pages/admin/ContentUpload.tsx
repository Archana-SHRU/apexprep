import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { FileUp, TriangleAlert } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Button, Card, CardBody } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { adminContent, type IngestionJob, type UploadResult } from '@/lib/admin-content'
import { HierarchyStatus } from './SuggestedSyllabus'
import { SELECT } from './Syllabus'

/**
 * Upload a real source PDF — a textbook chapter, notes, a question paper — for one track and subject.
 *
 * Only the track and subject are chosen here: the chapter → topic → sub-topic structure is read from the PDF's
 * own headings and matched against that subject's syllabus. Missing levels come back as suggestions for an
 * admin to approve on the review screen; a PDF that does not state its structure is flagged "Hierarchy needs
 * review" rather than having one invented for it. Nothing is published until a person approves it.
 */

/** Statuses after which a job is no longer moving on its own. */
const SETTLED: IngestionJob['status'][] = ['awaiting_review', 'published', 'failed', 'cancelled']
export default function ContentUpload() {
  const { data: tracks, loading, error, refetch } = useApi(() => adminContent.tracks(), [])
  const [trackId, setTrackId] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [job, setJob] = useState<IngestionJob | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const track = useMemo(() => tracks?.find((t) => t.id === trackId) ?? null, [tracks, trackId])
  useEffect(() => {
    if (track) setSubjectId(track.subjects[0]?.id ?? '')
    else setSubjectId('')
  }, [track])

  // Follow the job just uploaded until it settles, so the outcome — including "Hierarchy needs review" — is
  // shown here. Bounded: two minutes at most, then the Processing screen is the place to look.
  useEffect(() => {
    if (!result) return
    let stopped = false
    let tries = 0
    const tick = async () => {
      try {
        const current = await adminContent.job(result.jobId)
        if (stopped) return
        setJob(current)
        if (SETTLED.includes(current.status)) return
      } catch {
        /* a failed poll is retried on the next tick */
      }
      if (++tries < 60 && !stopped) timer = setTimeout(() => void tick(), 2000)
    }
    let timer = setTimeout(() => void tick(), 500)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [result])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setUploadError(null)
    setResult(null)
    setJob(null)
    try {
      setResult(await adminContent.upload(file, { trackId: trackId || undefined, subjectId: subjectId || undefined }))
      setFile(null)
      if (input.current) input.current.value = ''
    } catch (err) {
      setUploadError(errorMessage(err instanceof Error ? err : null))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <PageSkeleton />
  if (error) return <EmptyState icon={TriangleAlert} title="Could not load tracks" description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />

  return (
    <div className="space-y-6">
      <PageHeader title="Content Upload" subtitle="Choose a track and subject, then upload the PDF. Its chapters, topics and sub-topics are read from the PDF itself." />

      <Card>
        <CardBody>
          <form className="space-y-4" onSubmit={(e) => void submit(e)}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="track" className="eyebrow">Track</label>
                <select id="track" className={SELECT} value={trackId} onChange={(e) => setTrackId(e.target.value)}>
                  <option value="">Auto-detect from PDF content</option>
                  {tracks?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="subject" className="eyebrow">Subject</label>
                <select id="subject" className={SELECT} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={!trackId}>
                  <option value="">Auto-detect Subject from PDF content</option>
                  {track?.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>

            {track && track.subjects.length === 0 && (
              <p className="rounded border border-line bg-deck px-3 py-2 text-body-sm text-ink-soft">
                {track.name} has no subjects yet. A PDF is uploaded for a subject, so <Link className="text-primary underline" to="/admin/syllabus">add its subjects</Link> first; chapters, topics and sub-topics are not needed in advance.
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="pdf" className="eyebrow">PDF</label>
              <input id="pdf" ref={input} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-body-sm text-ink-soft file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-primary" />
              <p className="text-body-sm text-ink-muted">Text-based PDFs work best. Automatic pipeline analyzes subject, topics, formulas, questions and auto-publishes validated high-confidence content.</p>
            </div>

            <Button type="submit" disabled={!file || busy}><FileUp className="h-4 w-4" /> {busy ? 'Uploading…' : 'Upload and process'}</Button>
          </form>

          {uploadError && <p className="mt-4 rounded border border-deficit bg-[#FEF2F2] px-3 py-2 text-body-sm text-deficit">{uploadError}</p>}
          {result && (
            <div className="mt-4 rounded border border-mastery/40 bg-mastery/5 px-4 py-3 text-body-sm text-ink-soft">
              Uploaded: {result.pageCount} page{result.pageCount === 1 ? '' : 's'}. Processing has started —{' '}
              <Link className="text-primary underline" to="/admin/processing">follow it on the Processing screen</Link>, then{' '}
              <Link className="text-primary underline" to={`/admin/review?job=${result.jobId}`}>review what it found</Link>.
              {job && (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-2">
                    {SETTLED.includes(job.status) ? (
                      job.status === 'published' ? (
                        <span className="rounded bg-mastery/20 px-2 py-0.5 text-xs font-semibold text-mastery">✓ Auto-published</span>
                      ) : job.status === 'awaiting_review' ? (
                        <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-700">Awaiting Review</span>
                      ) : (
                        <span className="text-deficit">Processing {job.status}{job.errorMessage ? `: ${job.errorMessage}` : ''}</span>
                      )
                    ) : (
                      <span className="font-mono text-label-sm text-ink-muted">{job.status.replace(/_/g, ' ')} · {job.progressPct}%</span>
                    )}
                    {job.hierarchy && <HierarchyStatus hierarchy={job.hierarchy} />}
                  </div>

                  {job.hierarchy && (
                    <div className="rounded border border-line bg-canvas p-3">
                      <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">Real Processing Statistics</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-ink-soft">
                        <div className="rounded bg-deck/50 p-2"><span className="text-xs text-ink-muted block">Pages</span><span className="font-mono text-body-md font-bold text-ink">{job.pagesTotal}</span></div>
                        <div className="rounded bg-deck/50 p-2"><span className="text-xs text-ink-muted block">Topics detected</span><span className="font-mono text-body-md font-bold text-ink">{job.hierarchy.topicsDetected ?? job.hierarchy.paths ?? 0}</span></div>
                        <div className="rounded bg-deck/50 p-2"><span className="text-xs text-ink-muted block">Subtopics detected</span><span className="font-mono text-body-md font-bold text-ink">{job.hierarchy.subtopicsDetected ?? job.hierarchy.blocksFiledToExisting ?? 0}</span></div>
                        <div className="rounded bg-deck/50 p-2"><span className="text-xs text-ink-muted block">Theory blocks</span><span className="font-mono text-body-md font-bold text-ink">{job.blocks.theory ?? 0}</span></div>
                        <div className="rounded bg-deck/50 p-2"><span className="text-xs text-ink-muted block">Questions</span><span className="font-mono text-body-md font-bold text-ink">{job.blocks.question ?? 0}</span></div>
                        <div className="rounded bg-mastery/10 p-2"><span className="text-xs text-mastery block">Auto-published</span><span className="font-mono text-body-md font-bold text-mastery">{job.hierarchy.autoPublished ?? (job.status === 'published' ? (job.blocks.theory + job.blocks.question) : 0)}</span></div>
                        <div className="rounded bg-amber-500/10 p-2"><span className="text-xs text-amber-700 block">Needs review</span><span className="font-mono text-body-md font-bold text-amber-700">{job.hierarchy.needsReview ?? job.openReviewTasks}</span></div>
                        <div className="rounded bg-deck/50 p-2"><span className="text-xs text-ink-muted block">Failed</span><span className="font-mono text-body-md font-bold text-ink-muted">{job.hierarchy.failed ?? 0}</span></div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
