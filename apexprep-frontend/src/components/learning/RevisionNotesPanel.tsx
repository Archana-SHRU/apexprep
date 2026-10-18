import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BookOpen, ListChecks, NotebookPen, RefreshCw, Sigma, Zap } from 'lucide-react'
import { Button, Card, CardBody, Tabs } from '@/components/ui'
import { learningAi, type NoteScopeLevel, type RevisionNotes } from '@/lib/learning-ai'
import { aiErrorMessage } from './aiError'

type Section = 'notes' | 'concepts' | 'formulas' | 'mistakes' | 'quick'

/**
 * Quick revision / short notes for a syllabus node.
 *
 * The notes are written by the server only from the published notes under this node, each item citing its
 * source, and cached until that source changes. The panel first asks for the cached state (no generation),
 * so opening a topic never spends a provider call; generation happens only when the learner asks.
 */
export function RevisionNotesPanel({ level, id }: { level: NoteScopeLevel; id: string }) {
  const [data, setData] = useState<RevisionNotes | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('notes')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    learningAi
      .readNotes(level, id)
      .then((d) => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [level, id])

  async function create() {
    setWorking(true)
    setError(null)
    try {
      setData(await learningAi.createNotes(level, id))
      setSection('notes')
    } catch (err) {
      setError(aiErrorMessage(err))
    } finally {
      setWorking(false)
    }
  }

  const titles = useMemo(() => new Map((data?.notes?.sources ?? []).map((s) => [s.blockId, s.title])), [data])
  const from = (ids: string[]) => {
    const named = [...new Set(ids.map((i) => titles.get(i)).filter((t): t is string => Boolean(t)))]
    return named.length > 0 ? `From: ${named.join(', ')}` : null
  }

  if (loading) return <div className="h-20 animate-pulse rounded bg-deck" aria-label="Loading revision notes" />
  if (!data || data.state === 'no_source') return null

  const notes = data.state === 'ready' ? data.notes : null

  return (
    <Card>
      <CardBody>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="eyebrow inline-flex items-center gap-1.5 text-primary"><NotebookPen className="h-3.5 w-3.5" /> Quick revision</p>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              {notes
                ? `Short notes written from the ${data.sourceBlockCount} published note${data.sourceBlockCount === 1 ? '' : 's'} here.`
                : data.state === 'outdated'
                  ? 'The notes here have changed since your revision notes were made.'
                  : 'Turn these notes into short notes, key points, formulas and common mistakes.'}
            </p>
          </div>
          {!notes && (
            <Button size="sm" onClick={() => void create()} disabled={working}>
              {data.state === 'outdated' ? <RefreshCw className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
              {working ? 'Writing notes…' : data.state === 'outdated' ? 'Update short notes' : 'Create short notes'}
            </Button>
          )}
        </div>

        {working && <p className="mt-3 text-body-sm text-ink-muted" aria-live="polite">Reading the published notes and writing a short version. Large topics take a little longer.</p>}
        {error && <p className="mt-3 rounded border border-line bg-deck px-3 py-2 text-body-sm text-ink-soft">{error}</p>}

        {notes && (
          <div className="mt-4 space-y-4">
            <Tabs
              value={section}
              onChange={(v) => setSection(v as Section)}
              items={[
                { id: 'notes', label: 'Short notes' },
                { id: 'concepts', label: `Concepts (${notes.concepts.length})` },
                { id: 'formulas', label: `Formulas (${notes.formulas.length})` },
                { id: 'mistakes', label: `Common mistakes (${notes.commonMistakes.length})` },
                { id: 'quick', label: 'Last-minute' },
              ]}
            />

            {section === 'notes' && (
              <div>
                <h3 className="text-headline-sm text-ink">{notes.title}</h3>
                <p className="mt-1 text-body-md text-ink-soft">{notes.overview}</p>
                <ul className="mt-3 space-y-2">
                  {notes.keyPoints.map((k, i) => (
                    <li key={i} className="flex gap-2 text-body-md text-ink-soft">
                      <ListChecks className="mt-1 h-4 w-4 shrink-0 text-primary" />
                      <span>{k.text}{from(k.sourceBlockIds) && <span className="block font-mono text-label-sm text-ink-muted">{from(k.sourceBlockIds)}</span>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {section === 'concepts' && (
              <Empty when={notes.concepts.length === 0} text="The notes here do not define separate concepts.">
                <dl className="space-y-3">
                  {notes.concepts.map((c, i) => (
                    <div key={i} className="rounded border-l-2 border-primary bg-[rgba(67,97,238,0.04)] px-4 py-3">
                      <dt className="text-body-sm font-semibold text-ink">{c.term}</dt>
                      <dd className="mt-1 text-body-sm text-ink-soft">{c.explanation}</dd>
                    </div>
                  ))}
                </dl>
              </Empty>
            )}

            {section === 'formulas' && (
              <Empty when={notes.formulas.length === 0} text="No formulas appear in these notes, so none are listed.">
                <div className="space-y-3">
                  {notes.formulas.map((f, i) => (
                    <Card key={i} className="bg-deck">
                      <CardBody className="py-3">
                        <p className="inline-flex items-center gap-1.5 font-mono text-body-lg text-ink"><Sigma className="h-4 w-4 text-ink-muted" /> {f.expression}</p>
                        <p className="mt-1 text-body-sm text-ink-soft">{f.meaning}</p>
                      </CardBody>
                    </Card>
                  ))}
                </div>
              </Empty>
            )}

            {section === 'mistakes' && (
              <Empty when={notes.commonMistakes.length === 0} text="The notes do not warn about particular mistakes here.">
                <ul className="space-y-2">
                  {notes.commonMistakes.map((m, i) => (
                    <li key={i} className="flex gap-2 rounded border-l-2 border-velocity bg-velocity/5 px-4 py-2 text-body-sm text-ink-soft">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-velocity" /> {m.text}
                    </li>
                  ))}
                </ul>
              </Empty>
            )}

            {section === 'quick' && (
              <Empty when={notes.quickRevision.length === 0} text="Nothing to add beyond the short notes.">
                <ol className="list-decimal space-y-1.5 pl-5 text-body-md text-ink-soft">
                  {notes.quickRevision.map((q, i) => <li key={i}>{q.text}</li>)}
                </ol>
              </Empty>
            )}

            <p className="inline-flex items-center gap-1.5 font-mono text-label-sm text-ink-muted">
              <BookOpen className="h-3 w-3" /> Written only from your course’s published notes · {new Date(notes.generatedAt).toLocaleDateString()}
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function Empty({ when, text, children }: { when: boolean; text: string; children: React.ReactNode }) {
  return when ? <p className="text-body-sm text-ink-muted">{text}</p> : <>{children}</>
}
