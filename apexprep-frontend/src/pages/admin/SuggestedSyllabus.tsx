import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, ListTree, Pencil, TriangleAlert, X } from 'lucide-react'
import { Badge, Button, Card, CardBody, Input } from '@/components/ui'
import type { HierarchySummary, SuggestionLevel, SuggestionNames, SyllabusSuggestion } from '@/lib/admin-content'
import { cn } from '@/lib/utils'

/**
 * "Suggested Syllabus": the chapter → topic → sub-topic hierarchy the pipeline read from an upload's own
 * headings, for an admin to approve, edit or reject.
 *
 * A suggestion is not a syllabus node. Nothing is created until the admin approves; approving creates only the
 * levels marked NEW (published, under the upload's track and subject) and files the waiting blocks under the
 * sub-topic. The blocks themselves still need the normal approve → publish below.
 */

const LEVELS = [
  ['chapter', 'Chapter'],
  ['topic', 'Topic'],
  ['subtopic', 'Sub-topic'],
] as const

/** One line saying what hierarchy detection made of an upload — shared by Upload, Processing and Review. */
export function HierarchyStatus({ hierarchy, className }: { hierarchy: HierarchySummary | null | undefined; className?: string }) {
  if (!hierarchy) return null
  if (hierarchy.status === 'needs_review') {
    return (
      <span className={cn('inline-flex items-center gap-1 font-mono text-label-sm text-velocity', className)}>
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Hierarchy needs review
      </span>
    )
  }
  if (hierarchy.status === 'not_applicable') return <span className={cn('font-mono text-label-sm text-ink-muted', className)}>No subject chosen — hierarchy not detected</span>
  const waiting = hierarchy.blocksAwaitingApproval ?? 0
  return (
    <span className={cn('font-mono text-label-sm text-ink-muted', className)}>
      Hierarchy detected{waiting > 0 ? ` · ${waiting} block${waiting === 1 ? '' : 's'} await syllabus approval` : ''}
    </span>
  )
}

function LevelBadge({ level }: { level: SuggestionLevel }) {
  const style =
    level.state === 'new'
      ? 'border-primary/40 bg-primary/10 text-primary'
      : level.state === 'existing'
        ? 'border-mastery/40 bg-mastery/10 text-mastery'
        : 'border-velocity/40 bg-velocity/10 text-velocity'
  return <Badge className={cn('border uppercase', style)}>{level.state === 'unresolved' ? 'Unresolved' : level.state === 'new' ? 'New' : 'Existing'}</Badge>
}

/** What the reviewer needs about one level: the name, NEW/EXISTING, where it came from, what it matched. */
function LevelRow({ label, level }: { label: string; level: SuggestionLevel }) {
  const matched = level.state === 'existing' && level.existingName && level.existingName !== level.name
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 py-1.5">
      <span className="text-body-sm text-ink-muted">{label}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-body-sm font-medium', level.name ? 'text-ink' : 'italic text-ink-muted')}>{level.name ?? 'Not stated in the PDF'}</span>
          <LevelBadge level={level} />
          {level.state === 'existing' && level.existingStatus === 'draft' && <span className="text-label-sm text-ink-muted">draft — published on approval</span>}
        </div>
        <p className="text-label-sm text-ink-muted">
          {level.evidence?.heading ? `From “${level.evidence.heading}”${level.evidence.page ? ` · page ${level.evidence.page}` : ''}` : level.state === 'unresolved' ? 'Enter it with Edit & Approve, as the PDF prints it' : ''}
          {matched ? ` · matches existing “${level.existingName}”` : ''}
        </p>
      </div>
    </div>
  )
}

export function SuggestionCard({
  suggestion: s,
  busy,
  onApprove,
  onReject,
}: {
  suggestion: SyllabusSuggestion
  busy: boolean
  onApprove: (names: SuggestionNames) => void
  onReject: (reason: string) => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view')
  const [names, setNames] = useState({ chapter: s.chapter.name ?? '', topic: s.topic.name ?? '', subtopic: s.subtopic.name ?? '' })
  const [reason, setReason] = useState('')
  const pending = s.status === 'pending'

  function approveEdited() {
    const out: SuggestionNames = {}
    if (names.chapter.trim() && names.chapter.trim() !== s.chapter.name) out.chapterName = names.chapter.trim()
    if (names.topic.trim() && names.topic.trim() !== s.topic.name) out.topicName = names.topic.trim()
    if (names.subtopic.trim() && names.subtopic.trim() !== s.subtopic.name) out.subtopicName = names.subtopic.trim()
    onApprove(out)
  }

  return (
    <Card className={cn(s.status === 'approved' && 'border-mastery/40', s.status === 'rejected' && 'opacity-60')}>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-label-sm text-ink-muted">{s.trackName} › {s.subjectName}</p>
          <div className="flex items-center gap-2 font-mono text-label-sm text-ink-muted">
            <span>confidence {Math.round(s.confidence * 100)}%</span>
            <span>·</span>
            <span>{s.linkedBlocks} linked block{s.linkedBlocks === 1 ? '' : 's'}</span>
            {!pending && <Badge className={cn('border uppercase', s.status === 'approved' ? 'border-mastery/40 text-mastery' : 'border-deficit/40 text-deficit')}>{s.status}</Badge>}
          </div>
        </div>

        {mode === 'edit' ? (
          <div className="space-y-2">
            {LEVELS.map(([key, label]) => (
              <label key={key} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3">
                <span className="text-body-sm text-ink-muted">{label}</span>
                <Input value={names[key]} onChange={(e) => setNames({ ...names, [key]: e.target.value })} aria-label={`${label} name`} maxLength={200} disabled={busy} />
              </label>
            ))}
            <p className="text-label-sm text-ink-muted">A name that matches an existing node reuses it. A new name must appear in the uploaded PDF.</p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {LEVELS.map(([key, label]) => <LevelRow key={key} label={label} level={s[key]} />)}
          </div>
        )}

        <p className="text-label-sm text-ink-muted">Why: {s.mappingReason}</p>
        {s.rejectionReason && <p className="text-label-sm text-deficit">Rejected: {s.rejectionReason}</p>}

        {pending && mode === 'reject' && (
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is wrong (optional)" aria-label="Rejection reason" maxLength={2000} disabled={busy} />
        )}

        {pending && (
          <div className="flex flex-wrap gap-2 pt-1">
            {mode === 'view' && (
              <>
                <Button size="sm" disabled={busy || s.needsNames} onClick={() => onApprove({})} title={s.needsNames ? 'A level is not stated in the PDF: use Edit & Approve' : undefined}>
                  <Check className="h-3.5 w-3.5" /> Approve
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setMode('edit')}><Pencil className="h-3.5 w-3.5" /> Edit &amp; Approve</Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => setMode('reject')}><X className="h-3.5 w-3.5" /> Reject</Button>
              </>
            )}
            {mode === 'edit' && (
              <>
                <Button size="sm" disabled={busy || !names.chapter.trim() || !names.topic.trim() || !names.subtopic.trim()} onClick={approveEdited}><Check className="h-3.5 w-3.5" /> Approve</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode('view')}>Cancel</Button>
              </>
            )}
            {mode === 'reject' && (
              <>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => onReject(reason.trim())}><X className="h-3.5 w-3.5" /> Reject suggestion</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode('view')}>Cancel</Button>
              </>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/** The whole section: what detection concluded, then every suggestion, pending first. */
export function SuggestedSyllabusPanel({
  hierarchy,
  suggestions,
  busyId,
  onApprove,
  onReject,
}: {
  hierarchy: HierarchySummary | null
  suggestions: SyllabusSuggestion[]
  busyId: string | null
  onApprove: (s: SyllabusSuggestion, names: SuggestionNames) => void
  onReject: (s: SyllabusSuggestion, reason: string) => void
}) {
  const ordered = [...suggestions].sort((a, b) => Number(a.status !== 'pending') - Number(b.status !== 'pending'))
  const pending = suggestions.filter((s) => s.status === 'pending').length
  return (
    <section className="space-y-3" aria-labelledby="suggested-syllabus">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="suggested-syllabus" className="flex items-center gap-2 text-headline-sm text-ink"><ListTree className="h-5 w-5 text-primary" aria-hidden /> Suggested Syllabus</h2>
        <HierarchyStatus hierarchy={hierarchy} />
      </div>

      {hierarchy?.status === 'needs_review' && (
        <div role="status" className="rounded-lg border border-velocity/40 bg-velocity/5 p-3 text-body-sm text-ink-soft">
          <p className="font-medium text-ink">Hierarchy needs review</p>
          <p>{hierarchy.notes?.[0] ?? 'This PDF does not state its chapter/topic/sub-topic structure.'} Nothing was invented from it: file each block under an existing sub-topic below, or <Link className="text-primary underline" to="/admin/syllabus">author the syllabus</Link>.</p>
        </div>
      )}

      {suggestions.length === 0 ? (
        hierarchy?.status === 'detected' && <p className="text-body-sm text-ink-muted">Every heading in this PDF matched the existing syllabus, so its content was filed directly.</p>
      ) : (
        <>
          <p className="text-body-sm text-ink-muted">
            {pending > 0
              ? `${pending} suggestion${pending === 1 ? '' : 's'} waiting. Approving creates only the levels marked NEW and files the linked blocks; the blocks still need approving and publishing below.`
              : 'All suggestions from this upload have been decided.'}
          </p>
          <div className="space-y-3">
            {ordered.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} busy={busyId === s.id} onApprove={(names) => onApprove(s, names)} onReject={(reason) => onReject(s, reason)} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
