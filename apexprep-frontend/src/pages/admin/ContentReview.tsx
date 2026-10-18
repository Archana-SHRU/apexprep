import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FileCheck2, Save, Send, TriangleAlert, X } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Button, Card, CardBody, Input, Textarea } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import {
  adminContent,
  type ApprovalResult,
  type BlockEdit,
  type JobPreview,
  type Readiness,
  type ReviewedBlock,
  type RevisionNotes,
  type SuggestionNames,
  type SyllabusSuggestion,
  type TrackTree,
} from '@/lib/admin-content'
import { cn } from '@/lib/utils'
import { SuggestedSyllabusPanel } from './SuggestedSyllabus'
import { SELECT } from './Syllabus'

const KINDS: ReviewedBlock['kind'][] = ['theory', 'question', 'solution', 'ambiguous']

const READINESS_STYLE: Record<Readiness, string> = {
  ready: 'bg-mastery/15 text-mastery',
  flagged: 'bg-velocity/15 text-velocity',
  blocked: 'bg-deficit/15 text-deficit',
  done: 'bg-deck text-ink-muted',
  excluded: 'bg-deck text-ink-muted',
}
const READINESS_LABEL: Record<Readiness, string> = {
  ready: 'Ready',
  flagged: 'Needs your confirmation',
  blocked: 'Needs an edit',
  done: 'Published',
  excluded: 'Left out',
}
const ORIGIN_LABEL = { extracted: 'Extracted from the PDF', ai_assisted: 'AI-assisted', ai_generated: 'Written by AI' } as const

/**
 * One document, one review, one approval.
 *
 * What the pipeline made of an upload is laid out in reading order: theory, questions with their solutions, and any
 * learning material a model drafted. Every block can be edited here, and each says where it stands — **ready**,
 * **needs your confirmation** (nothing is wrong, but the rules want a person to look), or **needs an edit** (something
 * only a person can supply, such as the expected time). Nothing is published until **Approve and Publish**, and that
 * publishes under your name. A block's origin is always shown: extracted text is the PDF's own; anything a model read,
 * rewrote or wrote is labelled, and a model's answer, difficulty and time stay suggestions until you accept them.
 */
export default function ContentReview() {
  const [params, setParams] = useSearchParams()
  const { data: jobs, loading, error, refetch } = useApi(() => adminContent.jobs(), [])
  const reviewable = useMemo(() => (jobs ?? []).filter((j) => j.status === 'awaiting_review' || j.status === 'published'), [jobs])
  const jobId = params.get('job') ?? reviewable[0]?.id ?? ''

  const { data: tracks } = useApi(() => adminContent.tracks(), [])
  const [trackId, setTrackId] = useState('')
  const [tree, setTree] = useState<TrackTree | null>(null)
  const [preview, setPreview] = useState<JobPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    if (!trackId && tracks?.length) setTrackId(tracks[0]!.id)
  }, [tracks, trackId])
  useEffect(() => {
    if (trackId) void adminContent.tree(trackId).then(setTree).catch(() => setTree(null))
  }, [trackId])

  const load = useCallback(async (id: string) => {
    setPreviewError(null)
    try {
      setPreview(await adminContent.preview(id))
    } catch (err) {
      setPreviewError(errorMessage(err instanceof Error ? err : null))
    }
  }, [])
  useEffect(() => {
    setPreview(null)
    if (jobId) void load(jobId)
  }, [jobId, load])

  async function decide(s: SyllabusSuggestion, run: () => Promise<unknown>, done: string) {
    setDeciding(s.id)
    try {
      await run()
      toast({ tone: 'success', title: done })
      await load(jobId)
      if (trackId) setTree(await adminContent.tree(trackId))
    } catch (err) {
      toast({ tone: 'error', title: 'Could not save the decision', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setDeciding(null)
    }
  }
  const approveSuggestion = (s: SyllabusSuggestion, names: SuggestionNames) =>
    void decide(s, () => adminContent.approveSuggestion(jobId, s.id, names), 'Syllabus approved — the linked blocks are filed under it.')
  const rejectSuggestion = (s: SyllabusSuggestion, reason: string) =>
    void decide(s, () => adminContent.rejectSuggestion(jobId, s.id, reason || undefined), 'Suggestion rejected — nothing was added to the syllabus.')

  const subtopics = useMemo(
    () =>
      (tree?.subjects ?? []).flatMap((s) =>
        s.chapters.flatMap((c) => c.topics.flatMap((tp) => tp.subtopics.map((st) => ({ id: st.id, label: `${s.name} › ${c.name} › ${tp.name} › ${st.name}` })))),
      ),
    [tree],
  )
  const subtopicLabel = useMemo(() => new Map(subtopics.map((s) => [s.id, s.label])), [subtopics])

  const replaceBlock = (updated: ReviewedBlock) =>
    setPreview((prev) => (prev ? { ...prev, blocks: prev.blocks.map((b) => (b.id === updated.id ? updated : b)) } : prev))

  if (loading) return <PageSkeleton />
  if (error) return <EmptyState icon={TriangleAlert} title="Could not load jobs" description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />

  const live = (preview?.blocks ?? []).filter((b) => b.status !== 'superseded' || b.draft)

  return (
    <div className="space-y-6">
      <PageHeader title="Content Review" subtitle="Check, correct and approve a whole document at once." />

      {reviewable.length === 0 ? (
        <EmptyState icon={FileCheck2} title="Nothing waiting for review" description="When an uploaded PDF finishes processing, what it found appears here for review." />
      ) : (
        <>
          <Card>
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="job" className="eyebrow">Upload</label>
                <select id="job" className={SELECT} value={jobId} onChange={(e) => setParams({ job: e.target.value })}>
                  {reviewable.map((j) => <option key={j.id} value={j.id}>{new Date(j.createdAt).toLocaleString()} — {j.pagesTotal} pages, {j.status.replace('_', ' ')}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="syllabus" className="eyebrow">File under the syllabus of</label>
                <select id="syllabus" className={SELECT} value={trackId} onChange={(e) => setTrackId(e.target.value)}>
                  {tracks?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </CardBody>
          </Card>

          {previewError && <p className="text-body-sm text-deficit">{previewError}</p>}
          {preview === null && !previewError && <PageSkeleton />}

          {preview && (
            <>
              <SummaryAndApproval jobId={jobId} preview={preview} onChanged={() => void load(jobId)} />
              <SuggestedSyllabusPanel hierarchy={preview.syllabus.hierarchy} suggestions={preview.syllabus.suggestions} busyId={deciding} onApprove={approveSuggestion} onReject={rejectSuggestion} />
              {live.length === 0 && <p className="text-body-sm text-ink-muted">This upload produced no blocks.</p>}
              <div className="space-y-3">
                {live.map((b) => (
                  <BlockCard key={b.id} block={b} subtopics={subtopics} subtopicLabel={subtopicLabel.get(b.subtopicId ?? '') ?? null} onChanged={replaceBlock} onReload={() => void load(jobId)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- the summary and the single approval

function SummaryAndApproval({ jobId, preview, onChanged }: { jobId: string; preview: JobPreview; onChanged: () => void }) {
  const { summary } = preview
  const [confirmFlagged, setConfirmFlagged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApprovalResult | null>(null)
  const [times, setTimes] = useState<Record<string, string>>({})
  const { toast } = useToast()

  const types = useMemo(
    () => [...new Set(preview.blocks.filter((b) => b.kind === 'question' && b.question && b.readiness !== 'done' && b.question.expectedTimeSeconds === null).map((b) => b.question!.type))],
    [preview.blocks],
  )
  const published = preview.job.status === 'published'

  async function run(dryRun: boolean) {
    setBusy(true)
    try {
      const res = await adminContent.approveDocument(jobId, { confirmFlagged, dryRun })
      setResult(res)
      if (!dryRun) {
        toast(
          res.complete
            ? { tone: 'success', title: 'Published', description: `${res.totals.published + res.totals.confirmed} item(s) are now live.` }
            : { tone: 'error', title: 'Published what could be published', description: `${res.totals.blocked} blocked, ${res.totals.skipped} left for confirmation, ${res.totals.failed} failed.` },
        )
        onChanged()
      }
    } catch (err) {
      toast({ tone: 'error', title: dryRun ? 'Could not check' : 'Could not approve', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setBusy(false)
    }
  }

  async function applyTimes(acceptSuggested: boolean) {
    const expectedTimeSecondsByType: Record<string, number> = {}
    for (const [type, value] of Object.entries(times)) if (value.trim() !== '' && Number.isFinite(Number(value))) expectedTimeSecondsByType[type] = Number(value)
    setBusy(true)
    try {
      const res = await adminContent.applyDefaults(jobId, { ...(Object.keys(expectedTimeSecondsByType).length ? { expectedTimeSecondsByType } : {}), ...(acceptSuggested ? { acceptSuggested: true } : {}) })
      toast({ tone: 'success', title: `${res.updated} value(s) filled in`, description: 'Only questions that had none were changed.' })
      onChanged()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not apply', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-2 font-mono text-label-sm">
          {(['ready', 'flagged', 'blocked', 'done', 'excluded'] as Readiness[]).map((r) => (
            <span key={r} className={cn('rounded px-2 py-0.5', READINESS_STYLE[r])}>{summary.readiness[r]} {READINESS_LABEL[r].toLowerCase()}</span>
          ))}
        </div>
        <p className="text-body-sm text-ink-soft">
          {summary.theory} theory block(s), {summary.questions} question(s) ({summary.solutionsAttached} with a solution){summary.drafts > 0 ? `, ${summary.drafts} AI-drafted learning item(s)` : ''}.
          Approving publishes {summary.wouldPublish.ready} now{summary.wouldPublish.withFlagged > summary.wouldPublish.ready ? `, or ${summary.wouldPublish.withFlagged} if you confirm the ones that need it` : ''}.
        </p>
        {summary.answersToVerify > 0 && (
          <p className="text-body-sm text-velocity">{summary.answersToVerify} question(s) have an answer a model proposed that the document does not state. Check each one before it can be published.</p>
        )}

        {!published && types.length > 0 && (
          <div className="space-y-2 rounded border border-line p-3">
            <p className="text-body-sm font-medium text-ink">Expected solving time for questions that have none</p>
            <p className="text-label-sm text-ink-muted">The PDF does not say how long a question should take, so nothing is invented. Set a figure per type; it fills only questions with no value.</p>
            <div className="flex flex-wrap items-end gap-3">
              {types.map((t) => (
                <div key={t} className="flex flex-col gap-1">
                  <label className="eyebrow" htmlFor={`time-${t}`}>{t.replace('_', ' ')} (seconds)</label>
                  <Input id={`time-${t}`} type="number" min={5} max={7200} className="w-32" value={times[t] ?? ''} onChange={(e) => setTimes({ ...times, [t]: e.target.value })} />
                </div>
              ))}
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void applyTimes(false)}>Apply</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void applyTimes(true)}>Accept all suggested values</Button>
            </div>
          </div>
        )}

        {!published && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-body-sm text-ink">
              <input type="checkbox" checked={confirmFlagged} onChange={(e) => setConfirmFlagged(e.target.checked)} />
              Also confirm the blocks that need it (marked as reviewed by you)
            </label>
            <Button variant="secondary" size="sm" disabled={busy || !summary.canApprove} onClick={() => void run(true)}>Check first</Button>
            <Button size="sm" disabled={busy || !summary.canApprove} onClick={() => void run(false)}><Send className="h-3.5 w-3.5" /> Approve and Publish</Button>
          </div>
        )}
        {summary.cannotApproveBecause && <p className="text-body-sm text-ink-muted">{summary.cannotApproveBecause}</p>}

        {result && (
          <div className="space-y-1 text-body-sm">
            <p className="font-medium text-ink">
              {result.dryRun ? 'If you approve now: ' : 'Result: '}
              {result.totals.published + result.totals.confirmed} published, {result.totals.skipped} left for confirmation, {result.totals.blocked} blocked, {result.totals.failed} failed.
            </p>
            <ul className="space-y-0.5 text-ink-soft">
              {result.blocks.filter((b) => b.outcome === 'blocked' || b.outcome === 'failed' || b.outcome === 'skipped').map((b) => (
                <li key={b.blockId}>• {b.title ?? `page ${b.sourcePage ?? '?'}`} — {b.outcome}: {b.reasons.join('; ')}</li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------- one block

function BlockCard({ block: b, subtopics, subtopicLabel, onChanged, onReload }: {
  block: ReviewedBlock
  subtopics: { id: string; label: string }[]
  subtopicLabel: string | null
  onChanged: (b: ReviewedBlock) => void
  onReload: () => void
}) {
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const locked = b.readiness === 'done' || b.status === 'published' || b.status === 'rejected'

  async function save(what: string, edit: BlockEdit) {
    setBusy(true)
    try {
      onChanged(await adminContent.edit(b.id, edit))
      toast({ tone: 'success', title: what })
    } catch (err) {
      toast({ tone: 'error', title: 'Could not save', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setBusy(false)
    }
  }
  async function act(what: string, run: () => Promise<unknown>) {
    setBusy(true)
    try {
      await run()
      onReload()
    } catch (err) {
      toast({ tone: 'error', title: `Could not ${what}`, description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={cn(b.readiness === 'done' && 'border-mastery/40', (b.status === 'rejected' || b.readiness === 'excluded') && 'opacity-60')}>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-label-sm">
          <span className="rounded bg-deck px-2 py-0.5 text-ink">{b.draft ? 'learning draft' : b.kind}</span>
          <span className={cn('rounded px-2 py-0.5', READINESS_STYLE[b.readiness])}>{READINESS_LABEL[b.readiness]}</span>
          <span className="text-ink-muted">{ORIGIN_LABEL[b.provenance.origin]}{b.provenance.edited ? ' · edited by you' : ''}</span>
          {b.sourcePage !== null && <span className="text-ink-muted">page {b.sourcePage}</span>}
          {b.classificationConfidence !== null && <span className="text-ink-muted">confidence {Math.round(b.classificationConfidence * 100)}%</span>}
          {b.fromOcr && <span className="text-velocity">from OCR</span>}
        </div>
        {b.readinessReasons.length > 0 && b.readiness !== 'done' && (
          <ul className={cn('space-y-0.5 text-body-sm', b.readiness === 'blocked' ? 'text-deficit' : 'text-velocity')}>
            {b.readinessReasons.map((r, i) => <li key={i}>• {r}</li>)}
          </ul>
        )}
        {b.provenance.inferred.length > 0 && <p className="text-label-sm text-ink-muted">Inferred, not printed: {b.provenance.inferred.join('; ')}</p>}

        {b.draft ? (
          <DraftEditor block={b} locked={locked} busy={busy} onSave={(notes) => void save('Draft saved', { draft: { notes } })} />
        ) : b.kind === 'question' && b.question ? (
          <QuestionEditor block={b} locked={locked} busy={busy} onSave={(edit, what) => void save(what, { question: edit.question, ...(edit.solutionText !== undefined ? { solutionText: edit.solutionText } : {}) })} />
        ) : (
          <TextEditor block={b} locked={locked} busy={busy} onSave={(edit) => void save('Saved', edit)} />
        )}

        {!locked && !b.draft && (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-1">
              <label className="eyebrow" htmlFor={`st-${b.id}`}>Sub-topic</label>
              <select id={`st-${b.id}`} className={SELECT} value={b.subtopicId ?? ''} disabled={busy}
                onChange={(e) => e.target.value && void save('Filed', { subtopicId: e.target.value })}>
                <option value="">{subtopicLabel ?? (b.subtopicId ? 'Mapped outside the chosen syllabus' : 'Not mapped — choose a sub-topic')}</option>
                {subtopics.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="eyebrow" htmlFor={`k-${b.id}`}>It is</label>
              <select id={`k-${b.id}`} className={SELECT} value={b.kind} disabled={busy}
                onChange={(e) => void act('reclassify', () => adminContent.reclassify(b.id, e.target.value as ReviewedBlock['kind']))}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
          </div>
        )}
        {b.mappingReason && !locked && <p className="text-label-sm text-ink-muted">Mapping: {b.mappingReason}</p>}

        {!locked && (
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void act('leave out', () => adminContent.reject(b.id))}><X className="h-3.5 w-3.5" /> Leave out</Button>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function TextEditor({ block: b, locked, busy, onSave }: { block: ReviewedBlock; locked: boolean; busy: boolean; onSave: (edit: BlockEdit) => void }) {
  const [title, setTitle] = useState(b.title ?? '')
  const [text, setText] = useState(b.text)
  useEffect(() => {
    setTitle(b.title ?? '')
    setText(b.text)
  }, [b.title, b.text])
  const dirty = title !== (b.title ?? '') || text !== b.text
  const rewritten = b.originalText !== b.text
  return (
    <div className="space-y-2">
      {!locked && b.kind !== 'solution' && <Input aria-label="Title" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />}
      {locked ? (
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-body-sm text-ink-soft">{b.text}</p>
      ) : (
        <Textarea aria-label="Text" className="min-h-[120px]" value={text} onChange={(e) => setText(e.target.value)} />
      )}
      {rewritten && <details className="text-label-sm text-ink-muted"><summary>The PDF's original wording</summary><p className="mt-1 whitespace-pre-wrap">{b.originalText}</p></details>}
      {!locked && dirty && (
        <Button size="sm" disabled={busy} onClick={() => onSave({ text, title: title === '' ? null : title })}><Save className="h-3.5 w-3.5" /> Save changes</Button>
      )}
    </div>
  )
}

type QuestionSave = { question: NonNullable<BlockEdit['question']>; solutionText?: string }

function QuestionEditor({ block: b, locked, busy, onSave }: { block: ReviewedBlock; locked: boolean; busy: boolean; onSave: (edit: QuestionSave, what: string) => void }) {
  const q = b.question!
  const [stem, setStem] = useState(q.stem)
  const [options, setOptions] = useState(q.options)
  const [numeric, setNumeric] = useState(q.numericAnswer ? String(q.numericAnswer.value) : '')
  const [difficulty, setDifficulty] = useState(q.difficultyLabel === null ? '' : String(q.difficultyLabel))
  const [time, setTime] = useState(q.expectedTimeSeconds === null ? '' : String(q.expectedTimeSeconds))
  const [solution, setSolution] = useState(b.solution?.text ?? '')
  useEffect(() => {
    setStem(q.stem)
    setOptions(q.options)
    setNumeric(q.numericAnswer ? String(q.numericAnswer.value) : '')
    setDifficulty(q.difficultyLabel === null ? '' : String(q.difficultyLabel))
    setTime(q.expectedTimeSeconds === null ? '' : String(q.expectedTimeSeconds))
    setSolution(b.solution?.text ?? '')
  }, [q, b.solution])

  const isNumeric = q.type === 'integer' || q.type === 'numeric'
  const unverified = q.answerSource === 'ai_unverified'

  function changes(): QuestionSave {
    const out: QuestionSave = { question: {} }
    if (stem !== q.stem) out.question.stem = stem
    if (!isNumeric && JSON.stringify(options) !== JSON.stringify(q.options)) out.question.options = options
    if (isNumeric && numeric !== '' && Number(numeric) !== q.numericAnswer?.value) out.question.numericAnswer = { ...(q.numericAnswer ?? {}), value: Number(numeric) }
    if (difficulty !== '' && Number(difficulty) !== q.difficultyLabel) out.question.difficultyLabel = Number(difficulty)
    if (time !== '' && Number(time) !== q.expectedTimeSeconds) out.question.expectedTimeSeconds = Number(time)
    if (solution !== (b.solution?.text ?? '') && solution.trim() !== '') out.solutionText = solution
    return out
  }
  const edit = changes()
  const dirty = Object.keys(edit.question).length > 0 || edit.solutionText !== undefined

  return (
    <div className="space-y-3">
      {locked ? (
        <p className="whitespace-pre-wrap text-body-sm text-ink-soft">{q.stem}</p>
      ) : (
        <Textarea aria-label="Question" value={stem} onChange={(e) => setStem(e.target.value)} />
      )}

      {!isNumeric && (
        <div className="space-y-1.5">
          {options.map((o, i) => (
            <div key={o.key} className="flex items-center gap-2">
              <input type="checkbox" aria-label={`Option ${o.key} is correct`} checked={o.isCorrect} disabled={locked}
                onChange={(e) => setOptions(options.map((x, j) => (q.type === 'single_correct' ? { ...x, isCorrect: j === i && e.target.checked } : j === i ? { ...x, isCorrect: e.target.checked } : x)))} />
              <span className="w-6 font-mono text-label-sm text-ink-muted">{o.key}</span>
              <Input aria-label={`Option ${o.key}`} disabled={locked} value={o.text} onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            </div>
          ))}
        </div>
      )}
      {isNumeric && (
        <div className="flex items-center gap-2">
          <label className="eyebrow" htmlFor={`num-${b.id}`}>Answer</label>
          <Input id={`num-${b.id}`} type="number" step="any" className="w-40" disabled={locked} value={numeric} onChange={(e) => setNumeric(e.target.value)} />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="eyebrow" htmlFor={`diff-${b.id}`}>Difficulty (L1–L5)</label>
          <Input id={`diff-${b.id}`} type="number" min={1} max={5} className="w-24" disabled={locked} value={difficulty} onChange={(e) => setDifficulty(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="eyebrow" htmlFor={`time-${b.id}`}>Expected time (seconds)</label>
          <Input id={`time-${b.id}`} type="number" min={5} max={7200} className="w-32" disabled={locked} value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        {q.suggested && !locked && (q.difficultyLabel === null || q.expectedTimeSeconds === null) && (
          <p className="text-label-sm text-ink-muted">
            Suggested by {q.suggested.by === 'ai' ? 'a model' : 'an estimate'}: L{q.suggested.difficultyLabel ?? '?'}, {q.suggested.expectedTimeSeconds ?? '?'} s — not counted until you accept it.
          </p>
        )}
      </div>

      {q.gaps.length > 0 && !locked && <p className="text-label-sm text-velocity">Still missing: {q.gaps.join('; ')}</p>}

      {(b.solution || !locked) && (
        <div className="flex flex-col gap-1">
          <label className="eyebrow" htmlFor={`sol-${b.id}`}>Solution{b.solution && !b.solution.confirmed ? ' (matched with low confidence)' : ''}</label>
          {locked ? <p className="whitespace-pre-wrap text-body-sm text-ink-soft">{b.solution?.text}</p> : (
            <Textarea id={`sol-${b.id}`} value={solution} onChange={(e) => setSolution(e.target.value)} />
          )}
        </div>
      )}

      {!locked && (
        <div className="flex flex-wrap gap-2">
          {dirty && <Button size="sm" disabled={busy} onClick={() => onSave(edit, 'Saved')}><Save className="h-3.5 w-3.5" /> Save changes</Button>}
          {unverified && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onSave({ question: { confirmAnswer: true } }, 'Answer confirmed')}>I have checked the answer — it is right</Button>
          )}
          {q.suggested && (q.difficultyLabel === null || q.expectedTimeSeconds === null) && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onSave({ question: { acceptSuggested: true } }, 'Suggested values accepted')}>Accept suggested values</Button>
          )}
        </div>
      )}
    </div>
  )
}

function DraftEditor({ block: b, locked, busy, onSave }: { block: ReviewedBlock; locked: boolean; busy: boolean; onSave: (notes: RevisionNotes) => void }) {
  const draft = b.draft!
  const [notes, setNotes] = useState<RevisionNotes>(draft.notes)
  useEffect(() => setNotes(draft.notes), [draft.notes])
  const dirty = JSON.stringify(notes) !== JSON.stringify(draft.notes)
  return (
    <div className="space-y-3">
      <p className="text-label-sm text-ink-muted">
        Written by a model from this document's theory and checked against it ({Math.round(draft.groundingScore * 100)}% of it traced to the source). It becomes the sub-topic's revision notes when you approve; it is never shown as theory.
      </p>
      <Input aria-label="Title" disabled={locked} value={notes.title} onChange={(e) => setNotes({ ...notes, title: e.target.value })} />
      <Textarea aria-label="Overview" disabled={locked} value={notes.overview} onChange={(e) => setNotes({ ...notes, overview: e.target.value })} />
      <div className="space-y-1.5">
        {notes.keyPoints.map((k, i) => (
          <Input key={i} aria-label={`Key point ${i + 1}`} disabled={locked} value={k.text}
            onChange={(e) => setNotes({ ...notes, keyPoints: notes.keyPoints.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
        ))}
      </div>
      {draft.activation?.skipped && <p className="text-label-sm text-velocity">{draft.activation.skipped}</p>}
      {!locked && dirty && <Button size="sm" disabled={busy} onClick={() => onSave(notes)}><Save className="h-3.5 w-3.5" /> Save changes</Button>}
    </div>
  )
}
