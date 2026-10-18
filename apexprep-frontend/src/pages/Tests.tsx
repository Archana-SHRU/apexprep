import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Clock,
  Award,
  CheckCircle2,
  Play,
  RotateCcw,
  BarChart2,
  FileText,
  AlertCircle,
  HelpCircle,
  Layers,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, Button, Badge } from '@/components/ui'
import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import type { MockTestSummaryDto, TestKind } from '@/types/api'

export default function Tests() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<'all' | TestKind>('all')

  const { data: tests, loading, error, refetch } = useApi(
    () => api.getMockTests(filter === 'all' ? undefined : filter),
    [filter],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mock Tests"
        subtitle="Full-length exam simulations and high-yield sectional drills with authentic grading."
      />

      {/* Filter tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex gap-2">
          {(['all', 'full_length', 'sectional'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`rounded-lg px-3.5 py-1.5 font-mono text-label-sm font-medium transition-colors ${
                filter === tab
                  ? 'bg-primary text-white shadow-sm'
                  : 'bg-deck text-ink-muted hover:bg-line/40 hover:text-ink'
              }`}
            >
              {tab === 'all' ? 'All Tests' : tab === 'full_length' ? 'Full Length Papers' : 'Sectional Tests'}
            </button>
          ))}
        </div>
        {tests && (
          <span className="font-mono text-label-sm text-ink-muted">
            {tests.length} {tests.length === 1 ? 'test available' : 'tests available'}
          </span>
        )}
      </div>

      {loading && (
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardBody className="space-y-4">
                <div className="h-5 w-32 rounded bg-line/60" />
                <div className="h-6 w-3/4 rounded bg-line/60" />
                <div className="h-16 w-full rounded bg-line/30" />
                <div className="h-10 w-full rounded bg-line/40" />
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card className="border-deficit/30 bg-deficit/5">
          <CardBody className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-deficit shrink-0 mt-0.5" />
            <div className="space-y-2">
              <h3 className="text-body-md font-semibold text-deficit">Unable to load mock tests</h3>
              <p className="text-body-sm text-ink-soft">
                {error instanceof Error ? error.message : 'Please check your connection and try again.'}
              </p>
              <Button size="sm" variant="secondary" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {!loading && !error && tests && tests.length === 0 && (
        <Card>
          <CardBody className="py-12 text-center space-y-3">
            <Layers className="mx-auto h-10 w-10 text-ink-muted" />
            <h3 className="text-headline-sm text-ink">No test papers found</h3>
            <p className="text-body-sm text-ink-soft max-w-md mx-auto">
              There are no published tests matching this filter right now. Try switching filters or practice adaptively.
            </p>
            <Button size="sm" variant="secondary" onClick={() => navigate('/practice')}>
              Go to Adaptive Practice
            </Button>
          </CardBody>
        </Card>
      )}

      {!loading && !error && tests && tests.length > 0 && (
        <div className="grid gap-5 md:grid-cols-2">
          {tests.map((test) => (
            <TestCard key={test.id} test={test} onStart={() => navigate(`/tests/${test.id}`)} />
          ))}
        </div>
      )}

      {/* Exam instructions banner */}
      <Card className="border-line/70 bg-gradient-to-r from-deck to-canvas">
        <CardBody className="space-y-2">
          <h4 className="flex items-center gap-2 font-mono text-label-sm font-semibold uppercase tracking-wider text-ink">
            <HelpCircle className="h-4 w-4 text-primary" /> Exam Simulation Features
          </h4>
          <p className="text-body-sm text-ink-soft leading-relaxed">
            ApexPrep mock tests simulate competitive examinations with official negative marking schemes (+4 for correct,
            −1 for incorrect), server-side countdown timers, full Question Palettes, and comprehensive item-by-item analysis
            with verified solutions immediately following submission.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

function TestCard({ test, onStart }: { test: MockTestSummaryDto; onStart: () => void }) {
  const navigate = useNavigate()
  const attempted = !!test.lastAttempt && test.lastAttempt.status === 'completed'
  const inProgress = !!test.lastAttempt && test.lastAttempt.status === 'in_progress'

  return (
    <Card className="flex flex-col justify-between border-line transition-all hover:border-primary/50 hover:shadow-sm">
      <CardBody className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <Badge className={test.kind === 'full_length' ? 'border border-primary text-primary bg-primary/5' : 'border border-line text-ink-muted'}>
            {test.kind === 'full_length' ? 'Full Length Mock' : 'Sectional Drill'}
          </Badge>

          {inProgress ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 font-mono text-label-xs font-medium text-amber-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" /> In Progress
            </span>
          ) : attempted ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-mastery/10 px-2.5 py-0.5 font-mono text-label-xs font-medium text-mastery">
              <CheckCircle2 className="h-3 w-3" /> Attempted
            </span>
          ) : (
            <span className="rounded-full bg-deck px-2.5 py-0.5 font-mono text-label-xs text-ink-muted">
              Not Attempted
            </span>
          )}
        </div>

        <div>
          <h3 className="text-headline-sm font-semibold text-ink group-hover:text-primary">{test.title}</h3>
          {test.description && (
            <p className="mt-1.5 line-clamp-2 text-body-sm text-ink-soft">{test.description}</p>
          )}
        </div>

        {/* Paper details grid */}
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-deck/60 p-2.5 font-mono text-label-xs text-ink-soft">
          <div className="flex flex-col">
            <span className="text-ink-muted flex items-center gap-1">
              <Clock className="h-3 w-3" /> Duration
            </span>
            <span className="mt-0.5 font-semibold text-ink">{test.durationMinutes} mins</span>
          </div>
          <div className="flex flex-col">
            <span className="text-ink-muted flex items-center gap-1">
              <FileText className="h-3 w-3" /> Questions
            </span>
            <span className="mt-0.5 font-semibold text-ink">{test.questionCount} Qs</span>
          </div>
          <div className="flex flex-col">
            <span className="text-ink-muted flex items-center gap-1">
              <Award className="h-3 w-3" /> Marks
            </span>
            <span className="mt-0.5 font-semibold text-ink">{test.totalMarks} pts (+4/−1)</span>
          </div>
        </div>

        {/* Previous score banner */}
        {test.lastAttempt && test.lastAttempt.status === 'completed' && (
          <div className="flex items-center justify-between rounded border border-mastery/20 bg-mastery/5 px-3 py-2 font-mono text-label-sm">
            <span className="text-ink-soft">Last Score:</span>
            <span className="font-semibold text-mastery">
              {test.lastAttempt.totalScore} / {test.lastAttempt.maxScore}{' '}
              <span className="font-normal text-ink-muted">({test.lastAttempt.accuracy}% acc)</span>
            </span>
          </div>
        )}
      </CardBody>

      <div className="border-t border-line bg-deck/20 p-4 pt-3 flex items-center justify-between gap-3">
        {test.lastAttempt?.sessionId && test.lastAttempt.status === 'completed' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/tests/${test.id}/result?sessionId=${test.lastAttempt?.sessionId}`)}
            className="text-primary hover:bg-primary/10 gap-1.5"
          >
            <BarChart2 className="h-4 w-4" /> View Analysis
          </Button>
        ) : (
          <div />
        )}

        <Button
          size="sm"
          variant={inProgress ? 'destructive' : 'primary'}
          onClick={onStart}
          className="gap-1.5 ml-auto"
        >
          {inProgress ? (
            <>
              <Play className="h-4 w-4" /> Resume Test
            </>
          ) : attempted ? (
            <>
              <RotateCcw className="h-4 w-4" /> Retake Test
            </>
          ) : (
            <>
              <Play className="h-4 w-4" /> Start Test
            </>
          )}
        </Button>
      </div>
    </Card>
  )
}
