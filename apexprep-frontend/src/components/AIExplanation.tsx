import { useEffect, useState } from 'react'
import { CheckCircle2, CircleHelp, Info, Repeat, Sparkles, TriangleAlert, XCircle } from 'lucide-react'
import { TutorPanel } from '@/components/learning/TutorPanel'
import { Button, Card, CardBody } from '@/components/ui'
import { ApiError, NetworkError, http } from '@/lib/http'
import { mapExplanation } from '@/lib/api'
import { revealedAnswerText, studentAnswerText } from '@/lib/answer'
import { cn } from '@/lib/utils'
import type { AttemptState, Explanation, ExplanationUnavailable, Question } from '@/types'
import type { ExplanationDto } from '@/types/api'

/**
 * The panel after an answer is submitted: the server's verdict, the revealed answer, and the explanation the
 * backend produced.
 *
 * Every word of content here comes from the backend. The verdict is `outcome.correct` from the grading
 * response, the correct answer is `outcome.revealedAnswer` — which the server discloses only once the attempt
 * exists — and the explanation body is `GET /v1/questions/:id/explanation`. Nothing is composed in the browser.
 *
 * ## When there is no explanation
 *
 * That endpoint can legitimately decline, and each way it declines is a different thing to tell the learner:
 *
 * | Response | What it means | What the learner sees |
 * | --- | --- | --- |
 * | `503 AI_NOT_CONFIGURED` | no official solution, and no AI provider configured on this server | "AI explanation is currently unavailable" |
 * | `503 AI_PROVIDER_UNAVAILABLE` | a provider is configured but did not answer | the same unavailable state |
 * | `409 EXPLANATION_UNAVAILABLE` | withdrawn after reports, failed validation, or awaiting a teacher | the backend's own sentence |
 * | `403` | the question has not been attempted | "answer it first" — should not happen from here |
 *
 * None of these produce placeholder prose. An unavailable explanation is shown as unavailable, because a
 * plausible-sounding invented solution is worse for a learner than an honest blank — they would study it.
 *
 * The flow does not change when a provider key is added later: the same request then returns 200 with a real
 * explanation, and the success branch below renders it. Nothing needs rewiring.
 */
export function AIExplanation({ question, attempt, subtopicId, onSimilar }: {
  question: Question
  attempt: AttemptState
  /** The sub-topic the practice set is in; the tutor's conversation is anchored to it. */
  subtopicId: string
  onSimilar: () => void
}) {
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [unavailable, setUnavailable] = useState<ExplanationUnavailable | null>(null)
  const [loading, setLoading] = useState(true)

  const outcome = attempt.outcome
  const correct = outcome?.correct
  const correctAnswer = revealedAnswerText(question, outcome?.revealedAnswer)
  const yourAnswer = studentAnswerText(question, attempt)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setExplanation(null)
    setUnavailable(null)
    ;(async () => {
      try {
        const dto = await http.get<ExplanationDto>(`/v1/questions/${question.id}/explanation`)
        if (alive) setExplanation(mapExplanation(dto))
      } catch (err) {
        if (!alive) return
        setUnavailable(classify(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [question.id])

  return (
    <div className="space-y-4">
      {/* Verdict — the server's, not this component's */}
      <Card className={cn('border-[1.5px]', verdictClass(correct))}>
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className={cn('inline-flex items-center gap-2 text-headline-sm', verdictText(correct))}>
            {correct === true ? <CheckCircle2 className="h-5 w-5" /> : correct === false ? <XCircle className="h-5 w-5" /> : <CircleHelp className="h-5 w-5" />}
            {correct === true ? 'Correct' : correct === false ? 'Incorrect' : 'Recorded for marking'}
          </p>
          <div className="flex gap-6 font-mono text-label-sm">
            <span className="text-ink-muted">Your answer <strong className="ml-1 text-ink">{yourAnswer ?? '—'}</strong></span>
            {correctAnswer !== null && (
              <span className="text-ink-muted">Correct <strong className="ml-1 text-mastery">{correctAnswer}</strong></span>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Explanation, or an honest account of why there isn't one */}
      <Card>
        <CardBody>
          <p className="eyebrow inline-flex items-center gap-1.5 text-primary"><Sparkles className="h-3.5 w-3.5" /> AI Explanation</p>

          {loading && <ExplanationSkeleton />}

          {!loading && unavailable && <Unavailable state={unavailable} />}

          {!loading && explanation && (
            <>
              {/* The backend's provenance notice, shown exactly as written. */}
              {explanation.notice && (
                <p className="mt-3 inline-flex items-start gap-1.5 rounded border-l-2 border-velocity bg-velocity/5 px-3 py-2 text-body-sm text-ink-soft">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-velocity" />
                  {explanation.notice}
                </p>
              )}

              <p className="mt-2 text-body-md text-ink-soft">{explanation.summary}</p>

              {explanation.steps.length > 0 && (
                <>
                  <h4 className="mt-5 text-body-md font-semibold text-ink">Step-by-step solution</h4>
                  <ol className="mt-2 space-y-3">
                    {explanation.steps.map((step, i) => (
                      <li key={`${i}-${step.slice(0, 24)}`} className="flex gap-3">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary/10 font-mono text-label-sm text-primary">{i + 1}</span>
                        {/* The backend's steps are plain sentences, not title/body pairs. */}
                        <p className="text-body-sm text-ink-soft">{step}</p>
                      </li>
                    ))}
                  </ol>
                </>
              )}

              {(explanation.keyConcept || explanation.commonMistake) && (
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {explanation.keyConcept && (
                    <div className="rounded border-l-2 border-primary bg-[rgba(67,97,238,0.04)] px-4 py-3">
                      <p className="eyebrow text-primary">Key concept</p>
                      <p className="mt-1 text-body-sm text-ink-soft">{explanation.keyConcept}</p>
                    </div>
                  )}
                  {explanation.commonMistake && (
                    <div className="rounded border-l-2 border-velocity bg-velocity/5 px-4 py-3">
                      <p className="eyebrow inline-flex items-center gap-1.5 text-velocity"><TriangleAlert className="h-3.5 w-3.5" /> Common mistake</p>
                      <p className="mt-1 text-body-sm text-ink-soft">{explanation.commonMistake}</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
            <Button variant="secondary" size="sm" onClick={onSimilar}><Repeat className="h-3.5 w-3.5" /> Practice similar questions</Button>
          </div>
        </CardBody>
      </Card>

      {/*
        Ask-AI: the tutor, in its approved place. Now that the attempt exists the tutor may discuss the answer —
        "why is my answer wrong", "explain step 2", "another example" — using this question, the learner's own
        submitted answer and the course notes. The conversation is kept on the server, so follow-ups stay in context.
      */}
      <TutorPanel subtopicId={subtopicId} questionId={question.id} answered title="Ask AI about this question" />
    </div>
  )
}

function verdictClass(correct: boolean | null | undefined): string {
  if (correct === true) return 'border-mastery bg-[#ECFDF5]'
  if (correct === false) return 'border-deficit bg-[#FEF2F2]'
  // Ungraded (a long-form answer awaiting marking) is neither, and saying "Incorrect" would be false.
  return 'border-line bg-deck'
}

function verdictText(correct: boolean | null | undefined): string {
  if (correct === true) return 'text-mastery'
  if (correct === false) return 'text-deficit'
  return 'text-ink-soft'
}

function ExplanationSkeleton() {
  return (
    <div className="mt-3 space-y-2" aria-busy="true" aria-label="Loading explanation">
      <div className="h-3 w-full animate-pulse rounded bg-deck" />
      <div className="h-3 w-4/5 animate-pulse rounded bg-deck" />
      <div className="h-3 w-3/5 animate-pulse rounded bg-deck" />
    </div>
  )
}

/**
 * Why no explanation is shown.
 *
 * Kept visually quiet — the same card, the same type scale — because this is an ordinary state of a working
 * system, not an error the learner caused or needs to act on.
 */
function Unavailable({ state }: { state: ExplanationUnavailable }) {
  const { title, detail } = (() => {
    switch (state.reason) {
      case 'ai_not_configured':
        return {
          title: 'AI explanation is currently unavailable',
          detail: 'This question has no written solution yet, and explanation generation is not switched on for this server. Your answer and the correct answer above are recorded as normal.',
        }
      case 'under_review':
        return { title: 'Explanation with a reviewer', detail: state.message }
      case 'attempt_required':
        return { title: 'Answer this question first', detail: 'The explanation unlocks once an attempt has been submitted.' }
      case 'error':
        return { title: 'Explanation could not be loaded', detail: state.message }
    }
  })()

  return (
    <div className="mt-3 rounded border border-line bg-deck px-4 py-3">
      <p className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-ink"><Info className="h-3.5 w-3.5 text-ink-muted" /> {title}</p>
      <p className="mt-1 text-body-sm text-ink-soft">{detail}</p>
    </div>
  )
}

/** Maps a failed request onto the state the panel shows. Every branch corresponds to a real backend response. */
function classify(err: unknown): ExplanationUnavailable {
  if (err instanceof NetworkError) return { reason: 'error', message: 'Could not reach the server.' }
  if (err instanceof ApiError) {
    // 503 covers both "no provider configured" and "the provider did not answer". To a learner these are the
    // same thing, and neither is their problem to distinguish.
    if (err.code === 'AI_NOT_CONFIGURED' || err.code === 'AI_PROVIDER_UNAVAILABLE' || err.status === 503) {
      return { reason: 'ai_not_configured' }
    }
    // The backend writes a specific sentence per reason (withdrawn after reports, failed validation, awaiting
    // a teacher's approval), so its message is shown rather than a summary of it.
    if (err.code === 'EXPLANATION_UNAVAILABLE' || err.status === 409) return { reason: 'under_review', message: err.message }
    if (err.status === 403) return { reason: 'attempt_required' }
    return { reason: 'error', message: err.message }
  }
  return { reason: 'error', message: 'Explanation could not be loaded.' }
}
