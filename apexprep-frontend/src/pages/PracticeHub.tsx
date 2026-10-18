import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox, Target, TriangleAlert } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button, Card, CardBody, Progress, Tabs } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { levelLabel, levelToBar, pct, sinceDays } from '@/lib/format'
import type { Subject } from '@/types'

/**
 * Everywhere the learner can start an adaptive set.
 *
 * This page previously imported the mock `topics` and `subjects` arrays directly, bypassing the API layer
 * entirely, and derived a difficulty chip by dividing a fabricated mastery percentage by 20. It now walks the
 * real syllabus of the chosen track and shows, per sub-topic, the engine's own L1–L5 level for this learner —
 * the same value the engine will start their next set from, not a number computed here.
 *
 * Only sub-topics with published questions are listed: offering "Start adaptive set" where the engine has
 * nothing to serve would be a button that always fails.
 */
export default function PracticeHub() {
  const [trackId, setTrackId] = useState<string | null>(null)
  const { student } = useAuth()
  const { data: tracks, loading: tracksLoading, error: tracksError, refetch } = useApi(() => api.getTracks(), [])

  useEffect(() => {
    if (trackId || !tracks || tracks.length === 0) return
    const primary = student?.primaryTrackId && tracks.some((t) => t.id === student.primaryTrackId) ? student.primaryTrackId : tracks[0].id
    setTrackId(primary)
  }, [tracks, student?.primaryTrackId, trackId])

  const { data: subjects } = useApi(() => (trackId ? api.getSubjects(trackId) : Promise.resolve([])), [trackId])
  const { data: sets, loading: setsLoading } = useApi(
    () => (trackId ? api.getPractisableSubtopics(trackId) : Promise.resolve([])),
    [trackId],
  )

  if (tracksLoading) return <PageSkeleton />

  if (tracksError || !tracks || tracks.length === 0) {
    return (
      <EmptyState
        icon={tracksError ? TriangleAlert : Inbox}
        title={tracksError ? 'Could not load your tracks' : 'No tracks published yet'}
        description={tracksError ? errorMessage(tracksError) : 'Once an administrator publishes a track, its practice sets appear here.'}
        actionLabel={tracksError ? 'Try again' : undefined}
        onAction={tracksError ? refetch : undefined}
      />
    )
  }

  const colorOf = (subjectId: string) => (subjects ?? []).find((s: Subject) => s.id === subjectId)?.color ?? '#4361EE'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Practice (Adaptive)"
        subtitle="Each set is chosen question by question from your current level across L1–L5."
      />

      <Tabs items={tracks.map((t) => ({ id: t.id, label: t.shortName }))} value={trackId ?? tracks[0].id} onChange={setTrackId} />

      {setsLoading && <PageSkeleton />}

      {!setsLoading && sets?.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="No practice sets available yet"
          description="No sub-topic in this track has published questions. Once questions are published, sets appear here."
        />
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(sets ?? []).map((s) => (
          <Card key={s.id} className="flex h-full flex-col">
            <CardBody className="flex flex-1 flex-col">
              <div className="flex items-start justify-between gap-2">
                <p className="eyebrow">{s.topicName}</p>
                {/* The learner's level here, from the engine — not a difficulty derived in the browser. */}
                <span className="font-mono text-label-sm text-ink-muted">{levelLabel(s.level)}</span>
              </div>
              <h3 className="mt-2 text-headline-sm text-ink">{s.name}</h3>
              <p className="mt-1 font-mono text-label-sm text-ink-muted">
                {s.questionCount} questions available
                {s.lastPracticedDays !== null && ` • practised ${sinceDays(s.lastPracticedDays)}`}
              </p>
              <Progress className="mt-3" value={levelToBar(s.level)} color={colorOf(s.subjectId ?? '')} />
              <p className="mt-1.5 text-body-sm text-ink-muted">
                {s.level === null
                  ? 'Not started — your first set here begins with a short placement'
                  : `Level ${levelLabel(s.level)} of L5${s.accuracy === null ? '' : ` • ${pct(s.accuracy)} accuracy`}`}
              </p>
              <div className="mt-auto pt-4">
                <Link to={`/practice/${s.id}`}>
                  <Button className="w-full"><Target className="h-4 w-4" /> Start adaptive set</Button>
                </Link>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  )
}
