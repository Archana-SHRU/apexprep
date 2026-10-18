import { useEffect, useState } from 'react'
import {
  Activity,
  AlertCircle,
  Archive,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Clock,
  FileCheck2,
  FileText,
  Layers,
  Sparkles,
  TrendingUp,
  TriangleAlert,
  UserCheck,
  Users,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Badge, Card, CardBody, Progress, Table, TableWrap, Td, Th } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/hooks/useApi'
import { adminApi } from '@/lib/admin'
import { pct } from '@/lib/format'
import type { AdminStatsDto } from '@/types/api'

export default function AdminAnalytics() {
  const [stats, setStats] = useState<AdminStatsDto | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStats = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await adminApi.getStats()
      setStats(data)
    } catch (err) {
      setError(errorMessage(err instanceof Error ? err : null))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchStats()
  }, [])

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Platform Analytics"
          subtitle="Cohort practice volume, curriculum distribution, and pipeline operational metrics."
        />
        <PageSkeleton />
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Platform Analytics"
          subtitle="Cohort practice volume, curriculum distribution, and pipeline operational metrics."
        />
        <EmptyState
          icon={TriangleAlert}
          title="Could not load platform analytics"
          description={error ?? 'An unexpected error occurred while fetching aggregate analytics.'}
          actionLabel="Try again"
          onAction={fetchStats}
        />
      </div>
    )
  }

  // Format daily volume chart data
  const dailyPractice = stats.practice.dailyPracticeVolume ?? (stats.practice as unknown as { dailyVolume?: unknown[] }).dailyVolume ?? []
  const trendData = (dailyPractice as any[]).map((item) => {
    const d = new Date(item.date)
    return {
      date: item.date,
      label: isNaN(d.getTime())
        ? item.date
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      attempts: item.attemptsCount ?? item.totalAttempts ?? 0,
      learners: item.uniqueLearners ?? item.activeLearners ?? 0,
    }
  })

  // Learner engagement metrics
  const totalLearners = stats.learners.total || 1
  const onboardingRate = Math.round((stats.learners.onboarded / totalLearners) * 100)
  const activeRate = Math.round((stats.learners.active / totalLearners) * 100)

  // Questions breakdown metrics
  const totalQuestions = stats.questions.total || 1
  const publishedPct = Math.round((stats.questions.published / totalQuestions) * 100)
  const draftPct = Math.round((stats.questions.draft / totalQuestions) * 100)
  const retiredPct = Math.round((stats.questions.retired / totalQuestions) * 100)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform Analytics"
        subtitle="Cohort practice trends, curriculum distribution, and pipeline reliability metrics."
      />

      {/* Cohort Practice Trend Chart */}
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-headline-sm text-ink">Practice Activity Trend (30 Days)</h3>
              <p className="text-body-sm text-ink-muted">
                Daily questions attempted and unique active learners across all cohorts.
              </p>
            </div>
            <div className="flex items-center gap-4 text-label-sm">
              <span className="flex items-center gap-1.5 font-medium text-ink">
                <span className="h-2.5 w-2.5 rounded-full bg-accent" />
                Practice Attempts
              </span>
              <span className="flex items-center gap-1.5 font-medium text-ink">
                <span className="h-2.5 w-2.5 rounded-full bg-mastery" />
                Active Learners
              </span>
            </div>
          </div>

          {trendData.length === 0 ? (
            <div className="flex h-72 items-center justify-center rounded border border-dashed border-line text-ink-muted">
              No learner practice attempts recorded yet.
            </div>
          ) : (
            <div className="h-80 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorAttempts" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4361EE" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#4361EE" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="colorLearners" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10B981" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#10B981" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#E2E8F0" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#64748B' }}
                    tickLine={false}
                    axisLine={{ stroke: '#E2E8F0' }}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#64748B' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null
                      const row = payload[0]!.payload as (typeof trendData)[number]
                      return (
                        <div className="rounded border border-line-strong bg-canvas p-3 shadow-pop">
                          <div className="font-mono text-label-xs text-ink-muted">{row.date}</div>
                          <div className="mt-1 flex items-center justify-between gap-4 font-semibold text-ink">
                            <span>Attempts:</span>
                            <span className="font-mono text-accent">{row.attempts}</span>
                          </div>
                          <div className="flex items-center justify-between gap-4 text-body-sm text-ink-soft">
                            <span>Active Learners:</span>
                            <span className="font-mono text-emerald-700">{row.learners}</span>
                          </div>
                        </div>
                      )
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="attempts"
                    stroke="#4361EE"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorAttempts)"
                  />
                  <Area
                    type="monotone"
                    dataKey="learners"
                    stroke="#10B981"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorLearners)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Two Column Grid: Question Bank Breakdown & Learner Engagement */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Question Bank Status Breakdown */}
        <Card>
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-headline-sm text-ink">Question Lifecycle Distribution</h3>
                <p className="text-body-sm text-ink-muted">
                  Status of all {stats.questions.total.toLocaleString()} questions authored or ingested.
                </p>
              </div>
              <BookOpen className="h-5 w-5 text-accent" />
            </div>

            <div className="space-y-3 pt-2">
              <div>
                <div className="flex items-center justify-between text-body-sm">
                  <span className="flex items-center gap-1.5 font-medium text-emerald-800">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    Published ({stats.questions.published})
                  </span>
                  <span className="font-mono text-label-xs text-ink-muted">{publishedPct}%</span>
                </div>
                <Progress value={publishedPct} color="#10B981" className="mt-1.5" height="h-2" />
              </div>

              <div>
                <div className="flex items-center justify-between text-body-sm">
                  <span className="flex items-center gap-1.5 font-medium text-amber-800">
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                    Draft ({stats.questions.draft})
                  </span>
                  <span className="font-mono text-label-xs text-ink-muted">{draftPct}%</span>
                </div>
                <Progress value={draftPct} color="#F59E0B" className="mt-1.5" height="h-2" />
              </div>

              <div>
                <div className="flex items-center justify-between text-body-sm">
                  <span className="flex items-center gap-1.5 font-medium text-slate-700">
                    <span className="h-2.5 w-2.5 rounded-full bg-slate-400" />
                    Retired ({stats.questions.retired})
                  </span>
                  <span className="font-mono text-label-xs text-ink-muted">{retiredPct}%</span>
                </div>
                <Progress value={retiredPct} color="#94A3B8" className="mt-1.5" height="h-2" />
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Learner Roster & Engagement */}
        <Card>
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-headline-sm text-ink">Learner Cohort Engagement</h3>
                <p className="text-body-sm text-ink-muted">
                  Account status and onboarding progression across {stats.learners.total} registered learners.
                </p>
              </div>
              <Users className="h-5 w-5 text-accent" />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="rounded border border-line bg-canvas p-3">
                <div className="font-mono text-label-xs text-ink-muted uppercase">Active Accounts</div>
                <div className="mt-1 text-headline-md font-semibold text-emerald-700">
                  {stats.learners.active}
                </div>
                <div className="text-label-xs text-ink-muted">{activeRate}% of cohort</div>
              </div>

              <div className="rounded border border-line bg-canvas p-3">
                <div className="font-mono text-label-xs text-ink-muted uppercase">Disabled Accounts</div>
                <div className="mt-1 text-headline-md font-semibold text-deficit">
                  {stats.learners.disabled}
                </div>
                <div className="text-label-xs text-ink-muted">revoked access</div>
              </div>

              <div className="rounded border border-line bg-canvas p-3">
                <div className="font-mono text-label-xs text-ink-muted uppercase">Onboarded</div>
                <div className="mt-1 text-headline-md font-semibold text-ink">
                  {stats.learners.onboarded}
                </div>
                <div className="text-label-xs text-ink-muted">{onboardingRate}% completed profile</div>
              </div>

              <div className="rounded border border-line bg-canvas p-3">
                <div className="font-mono text-label-xs text-ink-muted uppercase">Practice Attempts</div>
                <div className="mt-1 text-headline-md font-semibold text-accent">
                  {stats.practice.totalAttempts.toLocaleString()}
                </div>
                <div className="text-label-xs text-ink-muted">all-time responses</div>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Content Ingestion Pipeline Health */}
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-headline-sm text-ink">Ingestion Pipeline Operational Health</h3>
              <p className="text-body-sm text-ink-muted">
                Success rate, review queue volume, and error status of uploaded PDF assets.
              </p>
            </div>
            <Badge className="border border-emerald-300 bg-emerald-50 font-mono text-body-sm font-semibold text-emerald-800">
              {pct(stats.ingestion.successRatePct ?? (stats.ingestion as unknown as { successRate?: number }).successRate ?? 0, 0)} Success Rate
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-4 pt-1">
            <div className="rounded border border-line p-3">
              <span className="font-mono text-label-xs text-ink-muted uppercase">Total Ingestion Jobs</span>
              <div className="mt-1 text-headline-sm font-semibold text-ink">
                {stats.ingestion.totalJobs}
              </div>
            </div>

            <div className="rounded border border-line p-3">
              <span className="font-mono text-label-xs text-ink-muted uppercase">Published to Syllabus</span>
              <div className="mt-1 text-headline-sm font-semibold text-emerald-700">
                {(stats.ingestion.publishedJobs ?? (stats.ingestion as unknown as { successfulJobs?: number }).successfulJobs ?? 0)}
              </div>
            </div>

            <div className="rounded border border-line p-3">
              <span className="font-mono text-label-xs text-ink-muted uppercase">Awaiting Review</span>
              <div className="mt-1 text-headline-sm font-semibold text-amber-700">
                {stats.ingestion.awaitingReviewJobs ?? 0}
              </div>
            </div>

            <div className="rounded border border-line p-3">
              <span className="font-mono text-label-xs text-ink-muted uppercase">Failed Processing</span>
              <div className="mt-1 text-headline-sm font-semibold text-deficit">
                {stats.ingestion.failedJobs}
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Questions by Subject Table */}
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h3 className="text-headline-sm text-ink">Questions by Curriculum Subject</h3>
            <p className="text-body-sm text-ink-muted">
              Published item counts across all active learning tracks and subjects.
            </p>
          </div>

          {stats.questions.bySubject.length === 0 ? (
            <div className="py-6 text-center text-body-sm text-ink-muted">
              No questions have been published under syllabus tracks yet.
            </div>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Subject</Th>
                    <Th>Track</Th>
                    <Th>Published Questions</Th>
                    <Th>Share of Bank</Th>
                  </tr>
                </thead>
                <tbody>
                  {(stats.questions.bySubject ?? []).map((s) => {
                    const qCount = s.questionCount ?? s.publishedCount ?? s.totalCount ?? 0
                    const share = Math.round((qCount / (stats.questions.published || 1)) * 100)
                    return (
                      <tr key={s.subjectId}>
                        <Td className="font-medium text-ink">{s.subjectName}</Td>
                        <Td className="text-ink-soft">{s.trackName}</Td>
                        <Td className="font-mono text-label-sm">{qCount}</Td>
                        <Td>
                          <div className="flex items-center gap-2">
                            <Progress value={share} color="#4361EE" className="w-24" height="h-1.5" />
                            <span className="font-mono text-label-xs text-ink-muted">{share}%</span>
                          </div>
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
