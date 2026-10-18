import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox, Search, TriangleAlert } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Card, CardBody, Input, Progress, Tabs } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { levelLabel, levelToBar, pct } from '@/lib/format'

/**
 * The syllabus, by track.
 *
 * The tracks are the organisation's published tracks and the subjects are that track's real subjects, with the
 * learner's own standing on each. Two numbers on these cards changed meaning, and the labels changed with them:
 *
 * * **"Mastery 78%" became "Level L3".** The backend defines mastery as θ mapped to an L1–L5 band, so there is
 *   no percentage to show. The bar is kept as the visual it always was, drawn from the level (L1→20% … L5→100%);
 *   the figure beside it is the level itself. Nothing here computes a mastery score.
 * * **A subject with no attempts shows "—", not 0.** The learner has no level there yet, which is a different
 *   statement from being at the bottom of the scale.
 */
export default function Learn() {
  const [trackId, setTrackId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const { student } = useAuth()
  const { data: tracks, loading: tracksLoading, error: tracksError, refetch } = useApi(() => api.getTracks(), [])

  // The learner's own primary track is the sensible default, rather than whichever track happens to be first.
  useEffect(() => {
    if (trackId || !tracks || tracks.length === 0) return
    const primary = student?.primaryTrackId && tracks.some((t) => t.id === student.primaryTrackId) ? student.primaryTrackId : tracks[0].id
    setTrackId(primary)
  }, [tracks, student?.primaryTrackId, trackId])

  const { data: subjects, loading: subjectsLoading, error: subjectsError } = useApi(
    () => (trackId ? api.getSubjects(trackId) : Promise.resolve([])),
    [trackId],
  )

  if (tracksLoading) return <PageSkeleton />

  if (tracksError) {
    return <EmptyState icon={TriangleAlert} title="Could not load your syllabus" description={errorMessage(tracksError)} actionLabel="Try again" onAction={refetch} />
  }

  if (!tracks || tracks.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No tracks published yet"
        description="Your organisation has no published tracks. Once an administrator publishes one, its subjects will appear here."
      />
    )
  }

  const visible = (subjects ?? []).filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <div className="space-y-6">
      <PageHeader title="Learn & Theory" subtitle="Pick a track, then work down: subject → chapter → topic → sub-topic." />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs items={tracks.map((t) => ({ id: t.id, label: t.shortName }))} value={trackId ?? tracks[0].id} onChange={setTrackId} />
        <div className="relative w-full lg:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <Input className="pl-9" placeholder="Filter subjects…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {subjectsLoading && <PageSkeleton />}

      {!subjectsLoading && subjectsError && (
        <p className="border border-line bg-deck px-4 py-3 text-body-sm text-ink-soft">{errorMessage(subjectsError)}</p>
      )}

      {!subjectsLoading && !subjectsError && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((s) => (
            <Link key={s.id} to={`/learn/${s.id}`}>
              <Card className="h-full transition-colors hover:border-line-strong">
                <CardBody>
                  <span className="inline-flex items-center gap-2 text-headline-sm text-ink">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.name}
                  </span>
                  <div className="mt-4 flex items-center justify-between text-body-sm">
                    {/* "Level", not "Mastery %": the engine reports a band, and the label now says so. */}
                    <span className="text-ink-muted">Level</span>
                    <span className="font-mono text-label-sm" style={{ color: s.color }}>{levelLabel(s.level)}</span>
                  </div>
                  <Progress className="mt-2" value={levelToBar(s.level)} color={s.color} />
                  <div className="mt-3 flex justify-between text-body-sm text-ink-muted">
                    <span>{s.questionsSolved.toLocaleString()} solved</span>
                    <span>{pct(s.accuracy)} accuracy</span>
                  </div>
                  <p className="mt-3 border-t border-line pt-3 font-mono text-label-sm text-ink-muted">
                    {s.chapterIds.length} chapters · {s.questionCount.toLocaleString()} questions
                  </p>
                </CardBody>
              </Card>
            </Link>
          ))}

          {visible.length === 0 && q.trim() !== '' && <p className="text-body-sm text-ink-muted">No subjects match that filter.</p>}

          {visible.length === 0 && q.trim() === '' && (
            <div className="sm:col-span-2 lg:col-span-3">
              <EmptyState
                icon={Inbox}
                title="This track has no published subjects yet"
                description="Nothing has been published under this track. Pick another track, or check back once content is added."
                actionLabel="See all tracks"
                onAction={() => setTrackId(tracks[0].id)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
