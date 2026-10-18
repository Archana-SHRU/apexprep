import { Link, useParams } from 'react-router-dom'
import { BookOpen, Inbox, Target, TriangleAlert } from 'lucide-react'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Button, Card, CardBody, Progress } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { levelLabel, levelToBar, pct, sinceDays } from '@/lib/format'

/**
 * A chapter's topics and sub-topics — the page where practice actually starts.
 *
 * This is the one place in the syllabus where the learner's level is real, because the sub-topic is the unit
 * the adaptive engine holds an ability score for. Each sub-topic shows the engine's L1–L5 band, the learner's
 * accuracy there, and when they last practised it; a sub-topic they have never opened shows "—" rather than a
 * zero. The bar beside a sub-topic is that level drawn on the existing track (L1→20% … L5→100%).
 *
 * The topic line above them no longer claims a mastery or a retention percentage. The engine keeps neither at
 * topic level: mastery is per sub-topic, and retention is not implemented at all. Both were mock fields.
 */
export default function ChapterView() {
  const { subjectId = '', chapterId = '' } = useParams()
  const { data: subject } = useApi(() => api.getSubject(subjectId), [subjectId])
  const { data: chapter, loading, error, refetch } = useApi(() => api.getChapter(chapterId), [chapterId])
  const { data: topics } = useApi(() => api.getTopics(chapterId), [chapterId])

  if (loading) return <PageSkeleton />

  if (error || !chapter) {
    return (
      <EmptyState icon={TriangleAlert} title="Could not load this chapter"
        description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />
    )
  }

  const color = subject?.color ?? '#4361EE'
  const list = topics ?? []

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[
        { label: 'Learn', to: '/learn' },
        { label: subject?.name ?? 'Subject', to: `/learn/${subjectId}` },
        { label: chapter.name },
      ]} />
      <PageHeader
        title={chapter.name}
        subtitle={[
          chapter.weightage === null ? 'Weightage not set' : `Weightage ${chapter.weightage}%`,
          `${list.length} topics`,
          `${chapter.questionCount.toLocaleString()} questions published`,
        ].join(' • ')}
      />

      {list.length === 0 && (
        <EmptyState icon={Inbox} title="No topics published yet"
          description="This chapter has no published topics. They will appear here once an administrator publishes them." />
      )}

      <div className="space-y-4">
        {list.map((t) => (
          <Card key={t.id}>
            <CardBody>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-headline-sm text-ink">{t.name}</h3>
                  <p className="mt-1 font-mono text-label-sm text-ink-muted">
                    {t.subTopics.length} sub-topics • {t.questionCount.toLocaleString()} questions
                  </p>
                </div>
              </div>

              <ul className="mt-4 divide-y divide-line border-t border-line">
                {t.subTopics.map((s) => (
                  <li key={s.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-body-md font-medium text-ink">{s.name}</p>
                      <p className="mt-0.5 font-mono text-label-sm text-ink-muted">
                        {s.questionCount} questions
                        {/* The engine's level for this learner here, labelled as a level. */}
                        {' • '}Level {levelLabel(s.level)}
                        {s.accuracy !== null && ` • ${pct(s.accuracy)} accuracy`}
                        {s.lastPracticedDays !== null && ` • practised ${sinceDays(s.lastPracticedDays)}`}
                      </p>
                      {s.level !== null && (
                        <Progress className="mt-2 sm:max-w-xs" value={levelToBar(s.level)} color={color} />
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {/* Theory is addressed by sub-topic, and the button appears only when some is published. */}
                      {s.hasTheory && (
                        <Link to={`/theory/${s.id}`}>
                          <Button variant="secondary" size="sm"><BookOpen className="h-3.5 w-3.5" /> Theory</Button>
                        </Link>
                      )}
                      <Link to={`/practice/${s.id}`}>
                        <Button size="sm" disabled={s.questionCount === 0}><Target className="h-3.5 w-3.5" /> Practice</Button>
                      </Link>
                    </div>
                  </li>
                ))}
                {t.subTopics.length === 0 && (
                  <li className="py-3 font-mono text-label-sm text-ink-muted">No published sub-topics in this topic yet.</li>
                )}
              </ul>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  )
}
