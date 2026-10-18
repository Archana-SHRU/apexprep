import { Link, useNavigate, useParams } from 'react-router-dom'
import { BookOpen, Clock, Inbox, Lightbulb, Sigma, Target, TriangleAlert } from 'lucide-react'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { EmptyState } from '@/components/EmptyState'
import { RevisionNotesPanel } from '@/components/learning/RevisionNotesPanel'
import { TutorPanel } from '@/components/learning/TutorPanel'
import { Button, Card, CardBody } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { levelLabel } from '@/lib/format'
import type { TheoryBlock } from '@/types'

/**
 * A sub-topic's published theory.
 *
 * The route parameter is still called `theoryId` — the URL shape is part of the approved app — but it is a
 * **sub-topic** id, because that is how the backend addresses theory: `GET /v1/subtopics/:id/theory` returns the
 * published blocks in reading order. There is no separate theory entity to fetch by its own id.
 *
 * Eight block types can come back. The four the approved design styles (paragraph, formula, callout, list) keep
 * their exact treatment; heading, table, figure and example are rendered plainly rather than being dropped,
 * because a block the server published and the page silently discards is content the learner has lost.
 */
export default function Theory() {
  const { theoryId = '' } = useParams()
  const navigate = useNavigate()
  const subTopicId = theoryId
  const { data: theory, loading, error, refetch } = useApi(() => api.getTheoryBySubTopic(subTopicId), [subTopicId])
  const { data: context } = useApi(() => api.getSubtopicContext(subTopicId), [subTopicId])

  if (loading) return <PageSkeleton />

  if (error) {
    return (
      <EmptyState icon={TriangleAlert} title="Could not load this theory"
        description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />
    )
  }

  const crumbs = [
    { label: 'Learn', to: '/learn' },
    ...(context?.subjectId && context?.subjectName ? [{ label: context.subjectName, to: `/learn/${context.subjectId}` }] : []),
    ...(context?.chapterId && context?.chapterName && context?.subjectId
      ? [{ label: context.chapterName, to: `/learn/${context.subjectId}/${context.chapterId}` }]
      : []),
    { label: context?.name ?? 'Theory' },
  ]

  // Nothing published is a real state of a working system, not an error.
  if (!theory) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Breadcrumbs items={crumbs} />
        <EmptyState
          icon={Inbox}
          title="No theory published for this sub-topic yet"
          description="Theory notes have not been published here. You can still practise the questions that are available."
          actionLabel="Start practice"
          onAction={() => navigate(`/practice/${subTopicId}`)}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs items={crumbs} />

      <header>
        <h1 className="text-headline-lg text-ink">{theory.title}</h1>
        <p className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-label-sm text-ink-muted">
          <Clock className="h-3.5 w-3.5" /> {theory.readMinutes} min read
        </p>
      </header>

      {/* Short notes from exactly this sub-topic's published theory; cached, and generated only on request. */}
      <RevisionNotesPanel level="subtopic" id={theory.subTopicId} />

      <article className="space-y-4">
        {theory.blocks.map((b, i) => <Block key={i} block={b} />)}
      </article>

      {/* A doubt about what was just read, answered from these notes and kept to this topic. */}
      <TutorPanel subtopicId={theory.subTopicId} title="Ask a doubt about this topic" />

      <Card>
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-body-md font-semibold text-ink">Ready to apply it?</p>
            {/*
              This line used to assert the set "starts at L2 and escalates with your streak". The engine does
              start a brand-new sub-topic at L2, but a returning learner starts from the level they are actually
              at — so the copy states the learner's real level when the backend knows one.
            */}
            <p className="mt-0.5 text-body-sm text-ink-muted">
              {context?.level
                ? `Your adaptive set here starts from ${levelLabel(context.level)}.`
                : 'Your first set here begins with a short placement, then adapts to you.'}
            </p>
          </div>
          <Link to={`/practice/${theory.subTopicId}`}>
            <Button size="lg" disabled={context?.questionCount === 0}><Target className="h-4 w-4" /> Start practice</Button>
          </Link>
        </CardBody>
      </Card>
    </div>
  )
}

/** One theory block. The four styled types are unchanged; the other four render legibly rather than vanishing. */
function Block({ block: b }: { block: TheoryBlock }) {
  switch (b.type) {
    case 'paragraph':
      return <p className="text-body-lg text-ink-soft">{b.body}</p>

    case 'heading':
      return <h2 className="pt-2 text-headline-sm text-ink">{b.title ?? b.body}</h2>

    case 'formula':
      return (
        <Card className="bg-deck">
          <CardBody className="py-4">
            <p className="eyebrow inline-flex items-center gap-1.5"><Sigma className="h-3.5 w-3.5" /> {b.title}</p>
            <p className="mt-2 font-mono text-body-lg text-ink">{b.body}</p>
          </CardBody>
        </Card>
      )

    case 'callout':
      return (
        <div className="rounded border-l-2 border-primary bg-[rgba(67,97,238,0.04)] px-4 py-3">
          <p className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-primary"><Lightbulb className="h-3.5 w-3.5" /> {b.title}</p>
          <p className="mt-1 text-body-sm text-ink-soft">{b.body}</p>
        </div>
      )

    case 'example':
      return (
        <div className="rounded border-l-2 border-mastery bg-mastery/5 px-4 py-3">
          <p className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-mastery"><BookOpen className="h-3.5 w-3.5" /> {b.title ?? 'Example'}</p>
          <p className="mt-1 text-body-sm text-ink-soft">{b.body}</p>
        </div>
      )

    case 'table':
      return (
        <div className="overflow-x-auto">
          {b.title && <p className="eyebrow mb-2">{b.title}</p>}
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr>
                {b.table?.columns.map((col) => (
                  <th key={col} className="border border-line bg-deck px-3 py-2 text-left font-mono text-label-sm text-ink">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.table?.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => <td key={ci} className="border border-line px-3 py-2 text-ink-soft">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'figure':
      // A figure block carries a caption; image delivery is not implemented server-side, so the caption is
      // shown on its own rather than as a broken image.
      return (
        <figure className="rounded border border-dashed border-line-strong bg-deck px-4 py-3">
          <figcaption className="text-body-sm text-ink-muted">{b.title ?? b.body}</figcaption>
        </figure>
      )

    case 'list':
      return (
        <div>
          {b.title && <p className="eyebrow">{b.title}</p>}
          <ul className="mt-2 space-y-1.5">
            {b.items?.map((it) => (
              <li key={it} className="flex gap-2 text-body-md text-ink-soft"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />{it}</li>
            ))}
          </ul>
        </div>
      )
  }
}
