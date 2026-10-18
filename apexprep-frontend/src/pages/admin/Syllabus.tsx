import { useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, FolderTree, Plus, TriangleAlert } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Button, Card, CardBody, Input } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { adminContent, type NodeLevel, type NodeStatus, type TrackTree } from '@/lib/admin-content'
import { cn } from '@/lib/utils'

const CHILD: Record<'track' | NodeLevel, NodeLevel | null> = { track: 'subject', subject: 'chapter', chapter: 'topic', topic: 'subtopic', subtopic: null }
const LABEL: Record<NodeLevel, string> = { subject: 'subject', chapter: 'chapter', topic: 'topic', subtopic: 'sub-topic' }

/**
 * The syllabus a track's content is filed under.
 *
 * The ingestion pipeline maps uploaded material onto **existing** sub-topics only — it never invents a node —
 * so a track (a class, an exam, an Olympiad) needs its subjects, chapters, topics and sub-topics before its
 * PDFs can be filed. This screen builds that structure through the admin syllabus API. It creates structure,
 * not content: theory and questions come only from uploaded, reviewed material.
 */
export default function Syllabus() {
  const { data: tracks, loading, error, refetch } = useApi(() => adminContent.tracks(), [])
  const [trackId, setTrackId] = useState<string>('')
  const [tree, setTree] = useState<TrackTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)

  useEffect(() => {
    if (!trackId && tracks?.length) setTrackId(tracks[0]!.id)
  }, [tracks, trackId])

  async function loadTree(id: string) {
    setTreeError(null)
    try {
      setTree(await adminContent.tree(id))
    } catch (err) {
      setTreeError(errorMessage(err instanceof Error ? err : null))
    }
  }

  useEffect(() => {
    if (trackId) void loadTree(trackId)
  }, [trackId])

  if (loading) return <PageSkeleton />
  if (error) return <EmptyState icon={TriangleAlert} title="Could not load tracks" description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />

  return (
    <div className="space-y-6">
      <PageHeader title="Syllabus" subtitle="The subjects, chapters, topics and sub-topics uploaded content is filed under." />

      <Card>
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label htmlFor="track" className="eyebrow">Track</label>
          <select id="track" value={trackId} onChange={(e) => setTrackId(e.target.value)} className={SELECT}>
            {tracks?.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.kind ? ` — ${KIND[t.kind] ?? t.kind}` : ''}{t.status !== 'published' ? ` (${t.status})` : ''}</option>
            ))}
          </select>
        </CardBody>
      </Card>

      {treeError && <p className="text-body-sm text-deficit">{treeError}</p>}

      {tree && (
        <Card>
          <CardBody>
            <p className="eyebrow inline-flex items-center gap-1.5"><FolderTree className="h-3.5 w-3.5" /> {tree.track.name}</p>
            {tree.subjects.length === 0 && (
              <p className="mt-2 text-body-sm text-ink-muted">This track has no subjects yet. Add the first one to start filing content under it.</p>
            )}
            <ul className="mt-3 space-y-1">
              {tree.subjects.map((s) => (
                <Node key={s.id} level="subject" id={s.id} name={s.name} status={s.status} onChanged={() => loadTree(trackId)}>
                  {s.chapters.map((c) => (
                    <Node key={c.id} level="chapter" id={c.id} name={c.name} status={c.status} onChanged={() => loadTree(trackId)}>
                      {c.topics.map((tp) => (
                        <Node key={tp.id} level="topic" id={tp.id} name={tp.name} status={tp.status} onChanged={() => loadTree(trackId)}>
                          {tp.subtopics.map((st) => (
                            <Node key={st.id} level="subtopic" id={st.id} name={st.name} status={st.status} onChanged={() => loadTree(trackId)}
                              meta={`${st.hasTheory ? 'theory' : 'no theory yet'} · ${st.questionCount} question${st.questionCount === 1 ? '' : 's'}`} />
                          ))}
                        </Node>
                      ))}
                    </Node>
                  ))}
                </Node>
              ))}
            </ul>
            <AddChild parentLevel="track" parentId={tree.track.id} onAdded={() => loadTree(trackId)} />
          </CardBody>
        </Card>
      )}
    </div>
  )
}

const KIND: Record<string, string> = { school: 'School', competitive_exam: 'Competitive exam', olympiad: 'Olympiad', other: 'Other' }
export const SELECT = 'h-10 min-w-0 flex-1 rounded border border-line-strong bg-canvas px-3 text-body-sm text-ink focus:border-primary focus:outline-none'

function Node({ level, id, name, status, meta, onChanged, children }: {
  level: NodeLevel
  id: string
  name: string
  status: NodeStatus
  meta?: string
  onChanged: () => void
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const child = CHILD[level]

  async function toggleStatus() {
    setBusy(true)
    try {
      await adminContent.setStatus(level, id, status === 'published' ? 'draft' : 'published')
      onChanged()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not change the status', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="pl-3">
      <div className="flex flex-wrap items-center gap-2 py-1">
        {child ? (
          <button onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'} className="text-ink-muted">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : <span className="w-3.5" />}
        <span className="text-body-sm font-medium text-ink">{name}</span>
        <span className="font-mono text-label-sm text-ink-muted">{LABEL[level]}{meta ? ` · ${meta}` : ''}</span>
        <button onClick={() => void toggleStatus()} disabled={busy}
          className={cn('rounded border px-1.5 font-mono text-label-sm', status === 'published' ? 'border-mastery/40 text-mastery' : 'border-line-strong text-ink-muted')}>
          {status}
        </button>
      </div>
      {child && open && (
        <div className="border-l border-line pl-2">
          <ul className="space-y-1">{children}</ul>
          <AddChild parentLevel={level} parentId={id} onAdded={onChanged} />
        </div>
      )}
    </li>
  )
}

function AddChild({ parentLevel, parentId, onAdded }: { parentLevel: 'track' | NodeLevel; parentId: string; onAdded: () => void }) {
  const level = CHILD[parentLevel]
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  if (!level) return null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      await adminContent.createNode(level!, parentId, name)
      setName('')
      setAdding(false)
      onAdded()
    } catch (err) {
      toast({ tone: 'error', title: `Could not add the ${LABEL[level!]}`, description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setBusy(false)
    }
  }

  if (!adding) {
    return (
      <button onClick={() => setAdding(true)} className="ml-3 mt-1 inline-flex items-center gap-1 font-mono text-label-sm text-primary hover:underline">
        <Plus className="h-3 w-3" /> Add {LABEL[level]}
      </button>
    )
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="ml-3 mt-1 flex max-w-md gap-2">
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={`New ${LABEL[level]} name`} aria-label={`New ${LABEL[level]} name`} />
      <Button type="submit" size="sm" disabled={busy || !name.trim()}>Add</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
    </form>
  )
}
