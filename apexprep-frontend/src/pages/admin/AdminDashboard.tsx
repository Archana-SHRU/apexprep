import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock,
  FileCheck2,
  FileText,
  FileUp,
  GraduationCap,
  Layers,
  Sparkles,
  TrendingUp,
  TriangleAlert,
  Users,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Button, Card, CardBody, Progress } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/hooks/useApi'
import { adminApi } from '@/lib/admin'
import { pct } from '@/lib/format'
import type { AdminStatsDto } from '@/types/api'

export default function AdminDashboard() {
  const navigate = useNavigate()
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
          title="Admin Overview"
          subtitle="Platform-wide learner metrics, question bank status, and ingestion pipeline health."
        />
        <PageSkeleton />
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Admin Overview"
          subtitle="Platform-wide learner metrics, question bank status, and ingestion pipeline health."
        />
        <EmptyState
          icon={TriangleAlert}
          title="Could not load platform overview"
          description={error ?? 'An unexpected error occurred while loading administrative statistics.'}
          actionLabel="Try again"
          onAction={fetchStats}
        />
      </div>
    )
  }

  // Format daily practice data for recharts
  const dailyPractice = stats.practice.dailyPracticeVolume ?? (stats.practice as unknown as { dailyVolume?: unknown[] }).dailyVolume ?? []
  const practiceChartData = (dailyPractice as any[]).map((d) => {
    const parsed = new Date(d.date)
    return {
      date: d.date,
      label: isNaN(parsed.getTime())
        ? d.date
        : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      attempts: d.attemptsCount ?? d.totalAttempts ?? 0,
      learners: d.uniqueLearners ?? d.activeLearners ?? 0,
    }
  })

  const totalSubjectQuestions =
    (stats.questions.bySubject ?? []).reduce(
      (acc, s) => acc + (s.questionCount ?? s.publishedCount ?? s.totalCount ?? 0),
      0,
    ) || 1

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Overview"
        subtitle="Platform-wide learner metrics, question bank status, and ingestion pipeline health."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/admin/analytics')}>
              <TrendingUp className="mr-1.5 h-3.5 w-3.5" />
              Detailed Analytics
            </Button>
          </div>
        }
      />

      {/* KPI Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Enrolled Learners */}
        <Card>
          <CardBody className="space-y-1">
            <div className="flex items-center justify-between text-ink-muted">
              <span className="font-mono text-label-xs uppercase">Enrolled Learners</span>
              <Users className="h-4 w-4 text-accent" />
            </div>
            <div className="text-display-sm font-semibold text-ink">
              {stats.learners.total.toLocaleString()}
            </div>
            <p className="text-label-xs text-ink-muted">
              <span className="font-medium text-emerald-700">{stats.learners.active} active</span>
              {' · '}
              <span>{stats.learners.onboarded} onboarded</span>
            </p>
          </CardBody>
        </Card>

        {/* Published Questions */}
        <Card>
          <CardBody className="space-y-1">
            <div className="flex items-center justify-between text-ink-muted">
              <span className="font-mono text-label-xs uppercase">Published Questions</span>
              <BookOpen className="h-4 w-4 text-emerald-600" />
            </div>
            <div className="text-display-sm font-semibold text-ink">
              {stats.questions.published.toLocaleString()}
            </div>
            <p className="text-label-xs text-ink-muted">
              <span>{stats.questions.draft} draft</span>
              {' · '}
              <span>{stats.questions.retired} retired</span>
            </p>
          </CardBody>
        </Card>

        {/* Today's Practice Volume */}
        <Card>
          <CardBody className="space-y-1">
            <div className="flex items-center justify-between text-ink-muted">
              <span className="font-mono text-label-xs uppercase">Today's Practice</span>
              <TrendingUp className="h-4 w-4 text-velocity" />
            </div>
            <div className="text-display-sm font-semibold text-ink">
              {stats.practice.todayAttempts.toLocaleString()}
            </div>
            <p className="text-label-xs text-ink-muted">
              <span>{stats.practice.totalAttempts.toLocaleString()} total practice attempts</span>
            </p>
          </CardBody>
        </Card>

        {/* Ingestion Success Rate */}
        <Card>
          <CardBody className="space-y-1">
            <div className="flex items-center justify-between text-ink-muted">
              <span className="font-mono text-label-xs uppercase">Pipeline Success</span>
              <FileCheck2 className="h-4 w-4 text-accent" />
            </div>
            <div className="text-display-sm font-semibold text-ink">
              {pct(stats.ingestion.successRatePct ?? (stats.ingestion as unknown as { successRate?: number }).successRate ?? 0, 0)}
            </div>
            <p className="text-label-xs text-ink-muted">
              <span>{(stats.ingestion.publishedJobs ?? (stats.ingestion as unknown as { successfulJobs?: number }).successfulJobs ?? 0)} of {stats.ingestion.totalJobs} jobs published</span>
            </p>
          </CardBody>
        </Card>
      </div>

      {/* Main Grid: Practice Volume Chart & Subject Distribution */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Practice Volume Trend (2 columns) */}
        <Card className="lg:col-span-2">
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-headline-sm text-ink">Daily Practice Volume</h3>
                <p className="text-body-sm text-ink-muted">
                  Questions attempted across all learners over the last 30 days.
                </p>
              </div>
              <span className="font-mono text-label-xs text-ink-muted">
                {dailyPractice.length} recorded days
              </span>
            </div>

            {practiceChartData.length === 0 ? (
              <div className="flex h-64 items-center justify-center rounded border border-dashed border-line text-ink-muted">
                No practice attempts recorded yet.
              </div>
            ) : (
              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={practiceChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
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
                        const row = payload[0]!.payload as (typeof practiceChartData)[number]
                        return (
                          <div className="rounded border border-line-strong bg-canvas p-2.5 shadow-pop">
                            <div className="font-mono text-label-xs text-ink-muted">{row.date}</div>
                            <div className="mt-1 font-semibold text-ink">
                              {row.attempts} {row.attempts === 1 ? 'attempt' : 'attempts'}
                            </div>
                            <div className="text-label-xs text-ink-soft">
                              {row.learners} {row.learners === 1 ? 'learner' : 'learners'} active
                            </div>
                          </div>
                        )
                      }}
                    />
                    <Bar dataKey="attempts" fill="#4361EE" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardBody>
        </Card>

        {/* Question Bank by Subject (1 column) */}
        <Card>
          <CardBody className="space-y-4">
            <div>
              <h3 className="text-headline-sm text-ink">Question Pool</h3>
              <p className="text-body-sm text-ink-muted">Published questions by subject.</p>
            </div>

            {stats.questions.bySubject.length === 0 ? (
              <div className="py-8 text-center text-body-sm text-ink-muted">
                No questions filed under syllabus subjects yet.
              </div>
            ) : (
              <div className="space-y-3.5">
                {stats.questions.bySubject.map((s) => {
                  const qCount = s.questionCount ?? s.publishedCount ?? s.totalCount ?? 0
                  const sharePct = Math.round((qCount / totalSubjectQuestions) * 100)
                  return (
                    <div key={s.subjectId} className="space-y-1">
                      <div className="flex items-center justify-between text-body-sm">
                        <span className="font-medium text-ink">{s.subjectName}</span>
                        <span className="font-mono text-label-xs text-ink-muted">
                          {qCount} questions ({sharePct}%)
                        </span>
                      </div>
                      <Progress value={sharePct} color="#4361EE" height="h-1.5" />
                    </div>
                  )
                })}
              </div>
            )}

            <div className="border-t border-line pt-3">
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => navigate('/admin/questions')}
              >
                Open Question Bank
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Quick Access Action Grid */}
      <div className="space-y-3">
        <h3 className="text-headline-sm text-ink">Administrative Navigation</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            to="/admin/questions"
            className="group rounded border border-line bg-canvas p-4 transition hover:border-accent hover:shadow-card"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded bg-accent/10 text-accent group-hover:bg-accent group-hover:text-white transition-colors">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold text-ink group-hover:text-accent">Question Bank</div>
                <div className="text-label-xs text-ink-muted">Browse & filter questions</div>
              </div>
            </div>
          </Link>

          <Link
            to="/admin/students"
            className="group rounded border border-line bg-canvas p-4 transition hover:border-accent hover:shadow-card"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded bg-emerald-50 text-emerald-700 group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                <GraduationCap className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold text-ink group-hover:text-accent">Student Roster</div>
                <div className="text-label-xs text-ink-muted">Manage active learners</div>
              </div>
            </div>
          </Link>

          <Link
            to="/admin/upload"
            className="group rounded border border-line bg-canvas p-4 transition hover:border-accent hover:shadow-card"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded bg-velocity/10 text-velocity group-hover:bg-velocity group-hover:text-white transition-colors">
                <FileUp className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold text-ink group-hover:text-accent">Content Upload</div>
                <div className="text-label-xs text-ink-muted">Ingest syllabus materials</div>
              </div>
            </div>
          </Link>

          <Link
            to="/admin/syllabus"
            className="group rounded border border-line bg-canvas p-4 transition hover:border-accent hover:shadow-card"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded bg-primary/10 text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                <Layers className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold text-ink group-hover:text-accent">Syllabus Editor</div>
                <div className="text-label-xs text-ink-muted">Tracks & chapter nodes</div>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  )
}
