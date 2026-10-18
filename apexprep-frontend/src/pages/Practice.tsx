import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowRight, Eraser, Flag, Inbox, Timer, TrendingUp, TriangleAlert } from 'lucide-react'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { AIExplanation } from '@/components/AIExplanation'
import { EmptyState } from '@/components/EmptyState'
import { GenerateFreshPractice } from '@/components/learning/GenerateFreshPractice'
import { TutorPanel } from '@/components/learning/TutorPanel'
import { VisualExplanationPanel } from '@/components/learning/VisualExplanationPanel'
import { MatrixMatchCard } from '@/components/learning/MatrixMatchCard'
import { LongFormCard } from '@/components/learning/LongFormCard'
import { HintPanel } from '@/components/learning/HintPanel'
import { OptionCard } from '@/components/OptionCard'
import { QuestionPalette } from '@/components/QuestionPalette'
import { Button, Card, CardBody, DifficultyChip, Dialog, Input, Progress } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { usePracticeSession } from '@/hooks/usePracticeSession'
import { useToast } from '@/hooks/useToast'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/http'
import { QUESTION_TYPE_LABELS, revealedOptionKeys } from '@/lib/answer'
import { levelLabel, levelToBar, pct } from '@/lib/format'
import { formatClock, formatPace, pad2 } from '@/lib/utils'

/**
 * One adaptive practice session.
 *
 * The screen is the approved one; what sits behind it is entirely different. Questions arrive one at a time
 * from `GET /v1/practice/sessions/:id/next`, chosen by the engine from the learner's current θ. Answers go to
 * `POST /v1/practice/attempts`, which grades them and moves the level. The page never decides whether an
 * answer is right — it renders the verdict the server sent, and marks the options from the `revealedAnswer`
 * that came back with it.
 *
 * Three things the old screen showed and this one does not, because the backend has no such data and inventing
 * it is what this phase exists to stop:
 *
 * * **Per-question marks** (`+4.00 / −1.00`). Marking schemes belong to a test engine; there is none.
 * * **A difficulty index percentage.** The engine's item difficulty `b` is deliberately not sent to clients.
 * * **Hint text.** The API sends `hintCount` and no hint bodies, so the hint panel is hidden rather than
 *   filled with invented prompts. Recorded as a missing backend capability in docs/INTEGRATION-MAP.md §4.
 */
export default function Practice() {
  const { subTopicId } = useParams()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [paletteOpen, setPaletteOpen] = useState(false)

  const s = usePracticeSession(subTopicId)
  // Breadcrumbs come from the syllabus, not from the session, and a failure there must not block practice.
  const { data: subTopic } = useApi(
    () => (subTopicId ? api.getSubtopicContext(subTopicId) : Promise.resolve(null)),
    [subTopicId],
  )

  if (!subTopicId) {
    return <EmptyState icon={Inbox} title="No sub-topic chosen" description="Open a sub-topic from the syllabus to start practising." />
  }

  if (s.loading && s.questions.length === 0) return <PageSkeleton />

  if (s.error && s.questions.length === 0) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title="Could not start this practice session"
        description={errorMessage(s.error)}
        actionLabel="Try again"
        onAction={s.retry}
      />
    )
  }

  if (s.exhausted && s.questions.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={Inbox}
          title="No questions available here yet"
          description="The question bank has nothing published for this sub-topic that you have not already seen recently. You can ask for fresh questions written from this topic's notes at your level, try another sub-topic, or come back after new content is added."
          actionLabel="Back to syllabus"
          onAction={() => navigate('/learn')}
        />
        <div className="flex justify-center">
          <GenerateFreshPractice subtopicId={subTopicId} size="md" onGenerated={() => s.refill()} />
        </div>
      </div>
    )
  }

  const q = s.question
  const a = s.attempt
  if (!q || !a) return <PageSkeleton />

  const answered =
    a.selectedKeys.length > 0 ||
    Boolean((a.value ?? '').trim()) ||
    Boolean((a.text ?? '').trim()) ||
    Boolean(a.matrix && Object.values(a.matrix).some((v) => Array.isArray(v) && v.length > 0))
  const correctKeys = revealedOptionKeys(a.outcome?.revealedAnswer)
  const isLast = s.questions.length >= s.targetCount
  const numeric = q.type === 'integer' || q.type === 'numeric'

  /** After submission the server has told us the key, so options can be marked from it. */
  function optionState(key: string) {
    if (!a!.submitted || correctKeys.length === 0) return null
    if (correctKeys.includes(key)) return 'correct' as const
    if (a!.selectedKeys.includes(key)) return 'incorrect' as const
    return null
  }

  async function onNext() {
    if (isLast || s.exhausted) {
      await s.finish()
      toast({
        tone: 'success',
        title: 'Set complete',
        // The server's counts, not a tally kept here.
        description: `${s.score.correct} of ${s.score.graded} graded answers correct.`,
      })
      navigate('/analytics')
      return
    }
    await s.next()
  }

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[
        { label: 'Learn', to: '/learn' },
        {
          label: subTopic?.topicName ?? 'Topic',
          to: subTopic?.subjectId && subTopic?.chapterId ? `/learn/${subTopic.subjectId}/${subTopic.chapterId}` : '/learn',
        },
        { label: subTopic?.name ?? 'Practice' },
      ]} />

      {/* Session strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-canvas px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-body-sm font-semibold text-primary">Q.{pad2(s.current + 1)}</span>
          <span className="rounded bg-deck px-2 py-0.5 font-mono text-label-sm text-ink-soft">{QUESTION_TYPE_LABELS[q.type]}</span>
          <DifficultyChip level={q.difficulty} />
        </div>
        <div className="flex items-center gap-4 font-mono text-label-sm text-ink-muted">
          <span className="inline-flex items-center gap-1.5"><Timer className="h-3.5 w-3.5" />{formatClock(s.elapsed)}</span>
          {/* The backend's own calibrated expected time for this question. */}
          <span className="hidden sm:inline">Typical {formatPace(q.expectedTimeSec)}</span>
          {s.progress && <span className="hidden md:inline">Your level {levelLabel(s.progress.level)}</span>}
        </div>
      </div>

      <Progress value={(s.questions.length / s.targetCount) * 100} />
      <p className="font-mono text-label-sm text-ink-muted">Question {s.current + 1} of {s.targetCount}</p>

      {s.contentGap && (
        <p className="border border-line bg-deck px-4 py-2 text-body-sm text-ink-soft">
          Only {s.contentGap.eligibleCount} questions were eligible here, so the engine
          {s.contentGap.widenedToParentTopic ? ' widened its search to the parent topic' : ' relaxed its filters'}.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="space-y-4">
          <Card>
            <CardBody>
              <p className="text-body-lg text-ink">{q.stem}</p>

              {q.options.length > 0 ? (
                <div className="mt-5 space-y-2.5">
                  {q.options.map((o) => (
                    <OptionCard key={o.key} option={o} selected={a.selectedKeys.includes(o.key)} state={optionState(o.key)}
                      disabled={a.submitted} onSelect={() => s.select(o.key)} />
                  ))}
                  {q.type === 'multi_correct' && !a.submitted && (
                    <p className="font-mono text-label-sm text-ink-muted">More than one option may be correct.</p>
                  )}
                </div>
              ) : numeric ? (
                <div className="mt-5 max-w-xs">
                  <label className="eyebrow" htmlFor="numeric-answer">{QUESTION_TYPE_LABELS[q.type]}</label>
                  <Input id="numeric-answer" className="mt-1.5 text-right font-mono"
                    inputMode={q.type === 'integer' ? 'numeric' : 'decimal'} disabled={a.submitted}
                    value={a.value ?? ''} onChange={(e) => s.setValue(e.target.value)} placeholder={q.type === 'integer' ? '0' : '0.00'} />
                </div>
              ) : q.type === 'matrix_match' ? (
                <MatrixMatchCard
                  question={q}
                  selected={a.matrix ?? {}}
                  revealed={a.outcome?.revealedAnswer?.matrix as Record<string, string[]> | undefined}
                  submitted={a.submitted}
                  onToggle={(leftKey, rightKey) => s.toggleMatrix(leftKey, rightKey)}
                />
              ) : q.type === 'long_form' ? (
                <LongFormCard
                  text={a.text ?? ''}
                  submitted={a.submitted}
                  onChange={(text) => s.setText(text)}
                />
              ) : null}
            </CardBody>
          </Card>

          {/*
            Help the learner asks for, never forced. Before an answer the tutor is in hint mode (the server enforces
            it); after an answer the tutor lives in the explanation panel below, so it is not offered twice.
          */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <VisualExplanationPanel questionId={q.id} />
              {!a.submitted && <TutorPanel subtopicId={subTopicId} questionId={q.id} answered={false} />}
            </div>
            {q.hintCount > 0 && (
              <HintPanel
                hintCount={q.hintCount}
                revealedHints={a.revealedHints ?? []}
                revealing={s.revealingHint}
                submitted={a.submitted}
                onReveal={s.revealHint}
              />
            )}
          </div>

          {/* Action bar — sticky on mobile so it is always thumb-reachable */}
          <div className="sticky bottom-16 z-20 flex flex-wrap items-center gap-2 border border-line bg-canvas p-3 lg:static lg:bottom-auto">
            <Button variant="secondary" size="sm" onClick={s.toggleFlag} className={a.flagged ? 'border-tier-l5 text-tier-l5' : ''}>
              <Flag className="h-3.5 w-3.5" />{a.flagged ? 'Flagged' : 'Mark for review'}
            </Button>
            <Button variant="destructive" size="sm" onClick={s.clear} disabled={a.submitted || !answered}>
              <Eraser className="h-3.5 w-3.5" /> Clear
            </Button>
            <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setPaletteOpen(true)}>Navigator</Button>
            <div className="ml-auto flex gap-2">
              {!a.submitted ? (
                <Button size="sm" onClick={() => void s.submitCurrent()} disabled={!answered || s.submitting}>
                  {s.submitting ? 'Submitting…' : 'Submit answer'}
                </Button>
              ) : (
                <Button size="sm" onClick={() => void onNext()} disabled={s.submitting}>
                  {isLast || s.exhausted ? 'Finish set' : 'Next question'} <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          {/*
            Any failure in the session is shown here rather than swallowed.

            Both directions matter. A failed *submission* means the answer is not recorded, and the learner has to
            know that before they move on. A failed *next* means the set cannot continue — most often because the
            backend paused the session after too many rushed answers (409 `SESSION_PAUSED`), which is a real rule
            of the engine and comes with a sentence the server wrote for a person. Either way the message shown is
            the server's; where the session cannot be continued at all, the only honest offer is a fresh one.
          */}
          {s.error && (
            <div className="space-y-2 border border-deficit bg-[#FEF2F2] px-4 py-3">
              <p className="text-body-sm text-deficit">{errorMessage(s.error)}</p>
              {blocksTheSession(s.error) && (
                <Button variant="secondary" size="sm" onClick={s.retry}>Start a new set</Button>
              )}
            </div>
          )}

          {s.exhausted && s.questions.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-deck px-4 py-3">
              <p className="text-body-sm text-ink-soft">You have worked through every question available here for now.</p>
              <GenerateFreshPractice subtopicId={subTopicId} onGenerated={() => s.refill()} />
            </div>
          )}

          {a.submitted && <AIExplanation question={q} attempt={a} subtopicId={subTopicId} onSimilar={() => void s.next()} />}
        </div>

        {/* Telemetry sidebar */}
        <aside className="hidden space-y-4 lg:block">
          <QuestionPalette attempts={s.attempts} current={s.current} total={s.targetCount} onJump={(i) => s.go(i)} />

          {/*
            The learner's real standing, from the adaptive engine.

            This card used to claim the difficulty was "calibrated based on your current streak of N correct
            answers", which was not something the frontend knew. What it shows now is what the engine reports:
            the L1–L5 level it holds for this sub-topic, and how the last answer moved it. The bar is the level
            drawn on the existing 0–100 track (L1→20% … L5→100%), not a mastery percentage.
          */}
          {s.progress && (
            <Card className="border-mastery/30 bg-mastery/5">
              <CardBody className="py-4">
                <p className="inline-flex items-center gap-1.5 font-mono text-label-sm text-ink">
                  <TrendingUp className="h-3.5 w-3.5 text-mastery" /> Adaptive level
                </p>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="font-mono text-headline-sm text-ink">{levelLabel(s.progress.level)}</span>
                  <span className="font-mono text-label-sm text-ink-muted">of L5</span>
                </div>
                <Progress className="mt-2" value={levelToBar(s.progress.level)} color="#10B981" />
                <p className="mt-1.5 text-body-sm text-ink-soft">
                  {a.outcome
                    ? a.outcome.levelChange === 'promoted' ? 'Your last answer moved you up a level.'
                      : a.outcome.levelChange === 'demoted' ? 'Your last answer moved you down a level.'
                      : 'Your level is unchanged after that answer.'
                    : 'The next question is chosen for this level.'}
                </p>
              </CardBody>
            </Card>
          )}

          {/* More practice from this topic's notes, at the level the engine holds for this learner. */}
          <Card>
            <CardBody className="space-y-2 py-4">
              <p className="font-mono text-label-sm uppercase text-ink">Want more practice?</p>
              <p className="text-body-sm text-ink-soft">New questions written from this topic’s notes at your level. The adaptive engine will serve them as they fit.</p>
              <GenerateFreshPractice subtopicId={subTopicId} onGenerated={() => (s.exhausted ? s.refill() : undefined)} />
            </CardBody>
          </Card>

          {/* This set so far — counts from the server's verdicts. */}
          <Card>
            <CardBody className="py-4">
              <p className="font-mono text-label-sm uppercase text-ink">This set</p>
              <dl className="mt-2 space-y-1.5 font-mono text-label-sm">
                <Row label="Answered" value={`${s.score.answered} of ${s.targetCount}`} />
                <Row label="Correct" value={String(s.score.correct)} />
                <Row label="Accuracy" value={pct(s.score.accuracy)} />
              </dl>
            </CardBody>
          </Card>

          {/* Pace against the question's own calibrated time — a real backend field. */}
          <Card>
            <CardBody className="py-4">
              <div className="flex items-center justify-between font-mono text-label-sm">
                <span className="text-ink">Time on this question</span>
                <span className={a.timeSpentSec > q.expectedTimeSec ? 'text-velocity' : 'text-mastery'}>
                  {formatClock(a.timeSpentSec)}
                </span>
              </div>
              <Progress className="mt-2" value={Math.min(100, (a.timeSpentSec / Math.max(1, q.expectedTimeSec)) * 100)} color="#10B981" />
              <p className="mt-1.5 text-right font-mono text-label-sm text-ink-muted">Typical {q.expectedTimeSec}s</p>
            </CardBody>
          </Card>
        </aside>
      </div>

      <Dialog open={paletteOpen} onClose={() => setPaletteOpen(false)} title="Question navigator" description="Jump to any question you have already seen in this set.">
        <QuestionPalette attempts={s.attempts} current={s.current} total={s.targetCount} onJump={(i) => { s.go(i); setPaletteOpen(false) }} />
      </Dialog>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  )
}

/**
 * Whether an error means this session cannot go on, as opposed to one request having failed.
 *
 * The backend answers 409 when the session's own state blocks the request: `SESSION_PAUSED` after the
 * configured number of rushed answers, and `INVALID_STATE` when the session has already ended or expired.
 * Neither is retryable on the same session, so the learner is offered a new one instead of a dead button.
 */
function blocksTheSession(error: Error): boolean {
  return error instanceof ApiError && error.status === 409 && (error.code === 'SESSION_PAUSED' || error.code === 'INVALID_STATE')
}
