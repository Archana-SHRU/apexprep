import { Link, useParams } from 'react-router-dom'
import { ChevronRight, Inbox, TriangleAlert } from 'lucide-react'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { NO_DATA, pct } from '@/lib/format'

/**
 * One subject's chapters.
 *
 * The chapter cards used to carry a mastery percentage per chapter. The engine holds an L1–L5 level per
 * **sub-topic** — that is the unit it practises and promotes at — and offers nothing at chapter level. Rolling
 * sub-topic levels up into a chapter figure here would be exactly the frontend-invented mastery formula this
 * phase forbids, so each card shows what the backend really has for a chapter: its exam weightage, how many
 * topics it holds, and how many published questions sit under it. The learner's own level appears one level
 * down, on the sub-topics in ChapterView, where the engine actually maintains it.
 */
export default function SubjectView() {
  const { subjectId = '' } = useParams()
  const { data: subject, loading: subjectLoading, error: subjectError, refetch } = useApi(() => api.getSubject(subjectId), [subjectId])
  const { data: chapters, loading: chaptersLoading } = useApi(() => api.getChapters(subjectId), [subjectId])

  if (subjectLoading || chaptersLoading) return <PageSkeleton />

  if (subjectError || !subject) {
    return (
      <EmptyState icon={TriangleAlert} title="Could not load this subject"
        description={errorMessage(subjectError)} actionLabel="Try again" onAction={refetch} />
    )
  }

  const list = chapters ?? []

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[{ label: 'Learn', to: '/learn' }, { label: subject.name }]} />
      <PageHeader
        title={subject.name}
        subtitle={[
          `${list.length} chapters`,
          `${subject.questionCount.toLocaleString()} questions published`,
          // The learner's own figures, which are null until they have practised here.
          subject.questionsSolved > 0 ? `${subject.questionsSolved.toLocaleString()} solved` : 'none solved yet',
          `${pct(subject.accuracy)} accuracy`,
        ].join(' • ')}
      />

      {list.length === 0 && (
        <EmptyState icon={Inbox} title="No chapters published yet"
          description="This subject has no published chapters. They will appear here once an administrator publishes them." />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {list.map((c) => (
          <Link key={c.id} to={`/learn/${subject.id}/${c.id}`}>
            <Card className="h-full transition-colors hover:border-line-strong">
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-headline-sm text-ink">{c.name}</h3>
                    <p className="mt-1 font-mono text-label-sm text-ink-muted">
                      {/* Weightage is nullable in the database and is genuinely unset on many chapters. */}
                      {c.weightage === null ? 'Weightage not set' : `Exam weightage ${c.weightage}%`} • {c.topicIds.length} topics
                    </p>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-muted" />
                </div>
                <div className="mt-4 flex items-center justify-between text-body-sm">
                  <span className="text-ink-muted">Questions</span>
                  <span className="font-mono text-label-sm" style={{ color: subject.color }}>
                    {c.questionCount > 0 ? c.questionCount.toLocaleString() : NO_DATA}
                  </span>
                </div>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
