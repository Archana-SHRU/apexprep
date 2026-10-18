import { useState, useMemo } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import {
  Award,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Clock,
  RotateCcw,
  ListOrdered,
  BookOpen,
  Filter,
  Layers,
} from 'lucide-react'
import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, Button, Badge } from '@/components/ui'
import { QUESTION_TYPE_LABELS } from '@/lib/answer'
import { formatClock, cn } from '@/lib/utils'
import type { TestResultDto, QuestionResultAnalysisDto } from '@/types/api'

export default function TestResult() {
  const { testId } = useParams<{ testId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const sessionId = searchParams.get('sessionId')
  const [filter, setFilter] = useState<'all' | 'correct' | 'incorrect' | 'unattempted'>('all')

  const { data: result, loading, error } = useApi(async () => {
    if (sessionId) {
      return api.getMockTestResult(sessionId)
    }
    // If no sessionId in query param, get test detail to find latest attempt
    if (!testId) throw new Error('Test ID is required')
    const detail = await api.getMockTest(testId)
    const latest = detail.pastAttempts[0]
    if (!latest) throw new Error('No completed attempts found for this test paper')
    return api.getMockTestResult(latest.sessionId)
  }, [sessionId, testId])

  const filteredQuestions = useMemo(() => {
    if (!result) return []
    if (filter === 'all') return result.questions
    return result.questions.filter((q) => q.outcome === filter)
  }, [result, filter])

  if (loading) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center space-y-4">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="font-mono text-body-sm text-ink-soft">Computing test results and analysis…</p>
      </div>
    )
  }

  if (error || !result) {
    return (
      <div className="mx-auto max-w-lg pt-12">
        <Card className="border-deficit/30 bg-deficit/5">
          <CardBody className="space-y-4 text-center">
            <XCircle className="mx-auto h-12 w-12 text-deficit" />
            <h3 className="text-headline-sm font-semibold text-deficit">No result available</h3>
            <p className="text-body-sm text-ink-soft">
              {error instanceof Error ? error.message : 'Could not find completed test results.'}
            </p>
            <div className="flex justify-center gap-3 pt-2">
              <Button variant="secondary" onClick={() => navigate('/tests')}>
                Back to Tests
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div>
          <PageHeader
            title="Examination Analysis"
            subtitle={`${result.testTitle} · ${result.kind === 'full_length' ? 'Full Length Paper' : 'Sectional Drill'}`}
          />
          {result.submittedAt && (
            <span className="font-mono text-label-xs text-ink-muted">
              Submitted on {new Date(result.submittedAt).toLocaleDateString()} at{' '}
              {new Date(result.submittedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/tests')} className="gap-1.5">
            <Layers className="h-4 w-4" /> All Tests
          </Button>
          <Button onClick={() => navigate(`/tests/${result.testId}`)} className="gap-1.5">
            <RotateCcw className="h-4 w-4" /> Retake Test
          </Button>
        </div>
      </div>

      {/* Primary Performance Metrics Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-primary/20 bg-primary/5">
          <CardBody className="space-y-1 py-4">
            <span className="flex items-center gap-1.5 font-mono text-label-sm text-ink-soft">
              <Award className="h-4 w-4 text-primary" /> Total Score
            </span>
            <div className="flex items-baseline gap-2 pt-1">
              <span className="text-display-sm font-bold text-ink">{result.totalScore}</span>
              <span className="font-mono text-body-sm text-ink-muted">/ {result.maxScore}</span>
            </div>
            <p className="font-mono text-label-xs text-primary font-medium">{result.percentage}% Marks Scored</p>
            {result.rawScore < 0 && (
              <p className="font-mono text-label-xs text-ink-muted">
                Negative marking took the total to {result.rawScore}; it is shown as 0.
              </p>
            )}
          </CardBody>
        </Card>

        <Card className="border-mastery/20 bg-mastery/5">
          <CardBody className="space-y-1 py-4">
            <span className="flex items-center gap-1.5 font-mono text-label-sm text-ink-soft">
              <CheckCircle2 className="h-4 w-4 text-mastery" /> Overall Accuracy
            </span>
            <div className="flex items-baseline gap-2 pt-1">
              <span className="text-display-sm font-bold text-ink">{result.accuracy}%</span>
            </div>
            <p className="font-mono text-label-xs text-ink-soft">
              {result.correctCount} Correct · {result.incorrectCount} Incorrect
            </p>
          </CardBody>
        </Card>

        <Card className="border-line bg-deck/50">
          <CardBody className="space-y-1 py-4">
            <span className="flex items-center gap-1.5 font-mono text-label-sm text-ink-soft">
              <Clock className="h-4 w-4 text-ink-muted" /> Time Spent
            </span>
            <div className="flex items-baseline gap-2 pt-1">
              <span className="text-display-sm font-bold text-ink">{formatClock(result.timeSpentSec)}</span>
            </div>
            <p className="font-mono text-label-xs text-ink-muted">
              Avg {result.questions.length > 0 ? Math.round(result.timeSpentSec / result.questions.length) : 0}s per
              question
            </p>
          </CardBody>
        </Card>

        <Card className="border-line bg-deck/50">
          <CardBody className="space-y-1 py-4">
            <span className="flex items-center gap-1.5 font-mono text-label-sm text-ink-soft">
              <ListOrdered className="h-4 w-4 text-ink-muted" /> Attempt Rate
            </span>
            <div className="flex items-baseline gap-2 pt-1">
              <span className="text-display-sm font-bold text-ink">
                {result.questions.length - result.unattemptedCount}
              </span>
              <span className="font-mono text-body-sm text-ink-muted">/ {result.questions.length} Qs</span>
            </div>
            <p className="font-mono text-label-xs text-ink-muted">{result.unattemptedCount} unattempted questions</p>
          </CardBody>
        </Card>
      </div>

      {/* Section-by-Section Breakdown Table */}
      <div className="space-y-3">
        <h3 className="font-mono text-label-sm font-bold uppercase tracking-wider text-ink">
          Sectional Performance Breakdown
        </h3>
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-body-sm">
              <thead className="border-b border-line bg-deck/50 text-label-xs text-ink-muted uppercase">
                <tr>
                  <th className="px-4 py-3">Section</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Accuracy</th>
                  <th className="px-4 py-3">Correct</th>
                  <th className="px-4 py-3">Incorrect</th>
                  <th className="px-4 py-3">Skipped</th>
                  <th className="px-4 py-3">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.sections.map((sec) => (
                  <tr key={sec.sectionId} className="hover:bg-deck/30 transition-colors">
                    <td className="px-4 py-3 font-semibold text-ink">{sec.sectionName}</td>
                    <td className="px-4 py-3 text-ink">
                      {sec.score} / {sec.maxScore}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'rounded px-2 py-0.5 font-bold',
                          sec.accuracy >= 75
                            ? 'bg-mastery/10 text-mastery'
                            : sec.accuracy >= 50
                              ? 'bg-primary/10 text-primary'
                              : 'bg-deficit/10 text-deficit',
                        )}
                      >
                        {sec.accuracy}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-mastery">{sec.correctCount}</td>
                    <td className="px-4 py-3 text-deficit">{sec.incorrectCount}</td>
                    <td className="px-4 py-3 text-ink-muted">{sec.unattemptedCount}</td>
                    <td className="px-4 py-3 text-ink-soft">{formatClock(sec.timeSpentSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Question Review Section with Filter Pills */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-ink-muted" />
            <span className="font-mono text-label-sm font-semibold uppercase tracking-wider text-ink">
              Detailed Question Analysis
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5 font-mono text-label-xs">
            <button
              onClick={() => setFilter('all')}
              className={cn(
                'rounded px-3 py-1 font-medium transition-colors',
                filter === 'all' ? 'bg-primary text-white' : 'bg-deck text-ink-muted hover:bg-line/40',
              )}
            >
              All ({result.questions.length})
            </button>
            <button
              onClick={() => setFilter('correct')}
              className={cn(
                'rounded px-3 py-1 font-medium transition-colors',
                filter === 'correct' ? 'bg-mastery text-white' : 'bg-deck text-mastery hover:bg-line/40',
              )}
            >
              Correct ({result.correctCount})
            </button>
            <button
              onClick={() => setFilter('incorrect')}
              className={cn(
                'rounded px-3 py-1 font-medium transition-colors',
                filter === 'incorrect' ? 'bg-deficit text-white' : 'bg-deck text-deficit hover:bg-line/40',
              )}
            >
              Incorrect ({result.incorrectCount})
            </button>
            <button
              onClick={() => setFilter('unattempted')}
              className={cn(
                'rounded px-3 py-1 font-medium transition-colors',
                filter === 'unattempted' ? 'bg-ink-muted text-white' : 'bg-deck text-ink-muted hover:bg-line/40',
              )}
            >
              Skipped ({result.unattemptedCount})
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {filteredQuestions.map((q, idx) => (
            <QuestionReviewCard key={q.testItemId} item={q} index={idx + 1} />
          ))}
        </div>
      </div>
    </div>
  )
}

function QuestionReviewCard({ item, index }: { item: QuestionResultAnalysisDto; index: number }) {
  const [showSolution, setShowSolution] = useState(true)

  const isCorrect = item.outcome === 'correct'
  const isIncorrect = item.outcome === 'incorrect'
  const isUnattempted = item.outcome === 'unattempted'

  const correctKeys = (item.correctAnswer.correctOptionKeys as string[]) || []
  const studentKeys = (item.studentResponse?.optionKeys as string[]) || []

  return (
    <Card
      className={cn(
        'border-line transition-all',
        isCorrect && 'border-l-4 border-l-mastery',
        isIncorrect && 'border-l-4 border-l-deficit',
        isUnattempted && 'border-l-4 border-l-ink-muted',
      )}
    >
      <CardBody className="space-y-4 p-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-body-sm font-bold text-ink">Q.{index}</span>
            <Badge className="font-mono text-label-xs border border-line">
              {item.sectionName}
            </Badge>
            <span className="font-mono text-label-xs text-ink-muted">
              {QUESTION_TYPE_LABELS[item.type as keyof typeof QUESTION_TYPE_LABELS] || item.type}
            </span>
          </div>

          <div className="flex items-center gap-2 font-mono text-label-xs">
            {isCorrect ? (
              <span className="inline-flex items-center gap-1 rounded bg-mastery/10 px-2 py-0.5 font-bold text-mastery">
                <CheckCircle2 className="h-3.5 w-3.5" /> +{item.positiveMarks}.00 Marks
              </span>
            ) : isIncorrect ? (
              <span className="inline-flex items-center gap-1 rounded bg-deficit/10 px-2 py-0.5 font-bold text-deficit">
                <XCircle className="h-3.5 w-3.5" /> −{item.negativeMarks}.00 Marks
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-deck px-2 py-0.5 text-ink-muted">
                <HelpCircle className="h-3.5 w-3.5" /> 0 Marks (Skipped)
              </span>
            )}
            <span className="text-ink-muted">· {item.timeSpentSec}s spent</span>
          </div>
        </div>

        {/* Stem */}
        <div className="text-body-md text-ink leading-relaxed whitespace-pre-wrap">{item.stem}</div>

        {/* Options Comparison for Option Types */}
        {item.options && item.options.length > 0 && (
          <div className="space-y-2 pt-1">
            {item.options.map((opt) => {
              const isOptionCorrect = correctKeys.includes(opt.key)
              const wasSelected = studentKeys.includes(opt.key)

              let borderClass = 'border-line bg-canvas'
              let badge = null

              if (isOptionCorrect && wasSelected) {
                borderClass = 'border-[1.5px] border-mastery bg-mastery/5 text-mastery'
                badge = <span className="font-mono text-label-xs text-mastery font-semibold">Your Correct Choice</span>
              } else if (isOptionCorrect && !wasSelected) {
                borderClass = 'border-[1.5px] border-mastery/60 bg-mastery/5 text-mastery'
                badge = <span className="font-mono text-label-xs text-mastery font-semibold">Correct Answer</span>
              } else if (!isOptionCorrect && wasSelected) {
                borderClass = 'border-[1.5px] border-deficit bg-deficit/5 text-deficit'
                badge = <span className="font-mono text-label-xs text-deficit font-semibold">Your Wrong Choice</span>
              }

              return (
                <div
                  key={opt.key}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded border p-3 font-mono text-body-sm',
                    borderClass,
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-bold">[{opt.key}]</span>
                    <span className="font-sans text-ink">{opt.text}</span>
                  </div>
                  {badge}
                </div>
              )
            })}
          </div>
        )}

        {/* Numeric Answer Comparison */}
        {(item.type === 'integer' || item.type === 'numeric') && (
          <div className="grid grid-cols-2 gap-3 max-w-md pt-1 font-mono text-body-sm">
            <div className="rounded border border-line bg-deck/60 p-3">
              <div className="text-label-xs text-ink-muted">Your Response</div>
              <div className="mt-1 font-bold text-ink">
                {(item.studentResponse?.value as string) || <span className="text-ink-muted">Not Answered</span>}
              </div>
            </div>
            <div className="rounded border border-mastery/30 bg-mastery/5 p-3">
              <div className="text-label-xs text-mastery font-medium">Correct Value</div>
              <div className="mt-1 font-bold text-mastery">
                {(item.correctAnswer.correctNumeric as string) || '—'}
              </div>
            </div>
          </div>
        )}

        {/* Matrix Match Representation */}
        {item.type === 'matrix_match' && (
          <div className="rounded border border-line bg-deck/30 p-3 text-body-sm space-y-2">
            <div className="font-mono text-label-xs font-semibold uppercase text-ink-muted">
              Correct Matching Matrix:
            </div>
            <div className="font-mono text-label-xs space-y-1">
              {Object.entries((item.correctAnswer.matrixAnswer as Record<string, string[]>) || {}).map(([l, r]) => (
                <div key={l} className="flex gap-2 text-ink">
                  <span className="font-bold text-primary">[{l}]</span> → <span>{r.join(', ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Toggleable Official Solution */}
        <div className="pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSolution((prev) => !prev)}
            className="text-primary hover:bg-primary/10 gap-1.5 p-0 font-mono text-label-xs"
          >
            <BookOpen className="h-3.5 w-3.5" />
            {showSolution ? 'Hide Solution' : 'View Official Solution'}
          </Button>

          {showSolution && (
            <div className="mt-2.5 rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
              <div className="font-mono text-label-xs font-bold uppercase tracking-wider text-primary">
                Official Solution & Explanation
              </div>
              {item.solution?.body ? (
                <div className="prose max-w-none text-body-sm text-ink leading-relaxed whitespace-pre-wrap">
                  {item.solution.body}
                </div>
              ) : (
                <p className="text-body-sm text-ink-muted">
                  Official step-by-step solution verified according to exam guidelines.
                </p>
              )}
              {item.solution?.finalAnswerText && (
                <div className="font-mono text-label-sm font-semibold text-primary pt-1">
                  Final Answer: {item.solution.finalAnswerText}
                </div>
              )}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
