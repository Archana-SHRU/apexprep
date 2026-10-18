import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CircleCheck, Clock, Flag, Inbox, Play, Target, TrendingUp, TriangleAlert, Users } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { StatStrip } from '@/components/StatStrip'
import { Button, Card, CardBody, Progress, Tabs } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { delta, duration, levelLabel, levelToBar, NO_DATA, pct, sinceDays } from '@/lib/format'
import { TIER_META, compact } from '@/lib/utils'

const RANGES = [
  { id: '7d', label: 'Last 7 Days' },
  { id: '30d', label: 'Last 30 Days' },
  { id: '90d', label: 'Last 90 Days' },
  { id: 'all', label: 'All Time' },
]

/**
 * The learner's own performance, from `GET /v1/me/analytics`.
 *
 * Every figure on this page is a count, a ratio of counts, or a median over the learner's real attempts. That
 * constraint removed several things the mock version displayed, each of which was a claim nothing could support:
 *
 * * **Per-tier "target" benchmarks** and "compared against top-percentile aspirant benchmarks". There is no
 *   cohort data in the backend, so there is no benchmark to compare against. The tiers now show the learner's
 *   accuracy and how many questions they have attempted at each level, which is what the data says.
 * * **"Improving L4 accuracy by 8% is projected to move your rank by roughly 120 positions."** Nothing in the
 *   product models rank.
 * * **A weekly mastery series.** Mastery is a current L1–L5 band per sub-topic; no history of it is stored, so
 *   the trend charts accuracy and volume, which are.
 * * **Per-topic retention percentages.** Retention is not implemented. "Last practised" is real and is shown.
 *
 * "Chapters completed" became **coverage**: the share of published sub-topics with at least ten attempts, which
 * is the metric the requirements actually define.
 */
export default function Analytics() {
  const navigate = useNavigate()
  const [range, setRange] = useState('30d')
  const [subject, setSubject] = useState('all')
  const { data, loading, error, refetch } = useApi(
    () => api.getAnalytics(range, subject === 'all' ? undefined : subject),
    [range, subject],
  )
  const { data: recs } = useApi(() => api.getRecommendations(), [])
  // A peer benchmark belongs to one sub-topic, so the learner chooses which of their own to compare; the first
  // attempted one is shown until they do.
  const [benchChoice, setBenchChoice] = useState('')
  const benchSubtopicId = benchChoice || data?.subtopicPerformance[0]?.subTopicId || ''
  const { data: benchmark } = useApi(() => (benchSubtopicId ? api.getBenchmark(benchSubtopicId) : Promise.resolve(null)), [benchSubtopicId])

  if (loading) return <PageSkeleton />

  if (error || !data) {
    return (
      <EmptyState icon={TriangleAlert} title="Could not load your analytics"
        description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />
    )
  }

  const subjectTabs = [{ id: 'all', label: 'All' }, ...data.subjectSummary.map((s) => ({ id: s.id, label: s.name }))]
  const nothingYet = data.questionsSolved === 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <PageHeader title="Performance & Analytics" subtitle="Your accuracy, pace and levels, from your own attempts." />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Tabs items={RANGES} value={range} onChange={setRange} />
          <Tabs items={subjectTabs} value={subject} onChange={setSubject} />
        </div>
      </div>

      <StatStrip stats={[
        {
          label: 'Overall Accuracy',
          value: pct(data.overallAccuracy),
          // The change against the preceding window of the same length. Null on "all time", which has no
          // preceding window, and on a first window, which has nothing to change from.
          note: data.accuracyDelta === null ? undefined : `${delta(data.accuracyDelta)} vs previous ${range === 'all' ? 'period' : range}`,
          noteTone: (data.accuracyDelta ?? 0) >= 0 ? 'mastery' : 'velocity',
        },
        { label: 'Questions Solved', value: compact(data.questionsSolved) },
        { label: 'Median Pace', value: duration(data.paceSeconds), note: 'per question', noteTone: 'muted' },
        {
          label: 'Syllabus Coverage',
          value: pct(data.coveragePct),
          note: 'sub-topics with 10+ attempts',
          noteTone: 'muted',
        },
      ]} />

      {nothingYet && (
        <EmptyState
          icon={Inbox}
          title="No attempts in this period"
          description="Once you have answered some questions, your accuracy, pace and levels appear here. Nothing is estimated in the meantime."
          actionLabel="Start practising"
          onAction={() => navigate('/practice')}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        {/* Accuracy by difficulty level */}
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-headline-sm text-ink">Accuracy by Difficulty Level</h3>
                <p className="mt-1 text-body-sm text-ink-muted">Your accuracy at each level, over the questions you have attempted there.</p>
              </div>
            </div>
            <div className="mt-5 space-y-4">
              {/* Always five rows, so the list does not reflow as a learner reaches a new level. */}
              {data.tierAccuracy.map((t) => (
                <div key={t.tier}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-body-sm text-ink-soft">L{t.tier} · {t.label}</span>
                    <span className="font-mono text-label-sm">
                      <strong style={{ color: t.accuracy === null ? '#94A3B8' : TIER_META[t.tier].hex }}>{pct(t.accuracy)}</strong>
                      <span className="ml-2 text-ink-muted">
                        {t.attempted === 0 ? 'not attempted' : `over ${t.attempted} ${t.attempted === 1 ? 'question' : 'questions'}`}
                      </span>
                    </span>
                  </div>
                  <Progress className="mt-1.5" value={t.accuracy ?? 0} color={t.accuracy === null ? '#E2E8F0' : TIER_META[t.tier].hex} height="h-2" />
                </div>
              ))}
            </div>

            {/* Peer Cohort Benchmark (FR-10.2) — per sub-topic, withheld until enough peers qualify */}
            {data.subtopicPerformance.length > 0 && (
              <div className="mt-6 border-t border-line pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-body-sm font-medium text-ink">
                    <Users className="h-4 w-4 text-primary" /> Peer Benchmark
                  </span>
                  <select
                    aria-label="Sub-topic to compare"
                    value={benchSubtopicId}
                    onChange={(e) => setBenchChoice(e.target.value)}
                    className="h-8 max-w-[14rem] rounded border border-line bg-canvas px-2 text-body-sm text-ink"
                  >
                    {data.subtopicPerformance.map((t) => (
                      <option key={t.subTopicId} value={t.subTopicId}>{t.name}</option>
                    ))}
                  </select>
                </div>
                {benchmark && benchmark.isPublished && (
                  <div className="mt-2 grid grid-cols-2 gap-3 rounded bg-deck p-2.5 font-mono text-label-sm">
                    <div>
                      <span className="text-ink-muted">Top {benchmark.topK} accuracy: </span>
                      <strong className="text-primary">{pct(benchmark.topAccuracy === null ? null : benchmark.topAccuracy * 100)}</strong>
                    </div>
                    <div>
                      <span className="text-ink-muted">Their pace: </span>
                      <strong className="text-ink">{duration(benchmark.topMedianTimeSeconds)}/Q</strong>
                    </div>
                    <div className="col-span-2 text-ink-muted">
                      {benchmark.qualifyingStudents} qualifying peers{benchmark.snapshotDate ? ` · as of ${benchmark.snapshotDate}` : ''}
                    </div>
                  </div>
                )}
                {benchmark && !benchmark.isPublished && (
                  <p className="mt-2 text-body-xs text-ink-muted">
                    {benchmark.message ?? `Withheld until at least ${benchmark.minQualifyingStudents} learners qualify.`}
                  </p>
                )}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Subject levels */}
        <div className="space-y-4">
          {data.subjectSummary.map((s) => (
            <Card key={s.id}>
              <CardBody className="py-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-body-md font-medium text-ink">
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}
                  </span>
                  {/* The mean L1–L5 band across this subject's sub-topics, as the backend computes it. */}
                  <span className="font-mono text-label-sm" style={{ color: s.color }}>Level {levelLabel(s.level)}</span>
                </div>
                <Progress className="mt-2.5" value={levelToBar(s.level)} color={s.color} />
                <div className="mt-2 flex flex-wrap justify-between gap-2 text-body-sm text-ink-muted">
                  <span>Strongest: <span className="text-mastery">{s.strongest ?? NO_DATA}</span></span>
                  <span>Needs review: <span className="text-deficit">{s.needsReview ?? NO_DATA}</span></span>
                </div>
                <p className="mt-2 font-mono text-label-sm text-ink-muted">
                  {s.questionsSolved.toLocaleString()} solved · {pct(s.accuracy)} accuracy
                </p>
              </CardBody>
            </Card>
          ))}
          {data.subjectSummary.length === 0 && (
            <p className="border border-line bg-deck px-4 py-3 text-body-sm text-ink-soft">
              No subjects yet — enrol in a track to see per-subject levels.
            </p>
          )}
        </div>
      </div>

      {/* Weekly trend */}
      <Card>
        <CardBody>
          <h3 className="text-headline-sm text-ink">Weekly Trend</h3>
          <p className="mt-1 text-body-sm text-ink-muted">
            Accuracy and volume per week. A week with no attempts is shown as a gap, not as zero accuracy.
          </p>
          <div className="mt-4 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gAcc" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4361EE" stopOpacity={0.18} /><stop offset="100%" stopColor="#4361EE" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#E2E8F0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={{ stroke: '#E2E8F0' }} />
                {/* Fixed 0–100 for a percentage: a zoomed axis makes small movements look dramatic. */}
                <YAxis yAxisId="acc" domain={[0, 100]} tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="qs" orientation="right" allowDecimals={false} tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ border: '1px solid #CBD5E1', borderRadius: 4, fontSize: 13 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area yAxisId="acc" type="monotone" dataKey="accuracy" name="Accuracy %" stroke="#4361EE" strokeWidth={2} fill="url(#gAcc)" connectNulls={false} />
                <Line yAxisId="qs" type="monotone" dataKey="questions" name="Questions" stroke="#10B981" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      {/* Weak sub-topics */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="inline-flex items-center gap-2 text-headline-sm text-ink"><Flag className="h-4 w-4 text-deficit" /> Sub-topics Needing Attention</h3>
              <p className="mt-1 text-body-sm text-ink-muted">Your lowest accuracy, among sub-topics with at least five attempts.</p>
            </div>
            <Link to="/reports" className="font-mono text-label-sm text-primary hover:underline">View full report →</Link>
          </div>
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {data.weakTopics.map((t) => (
              <li key={t.subTopicId} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#FEF2F2]"><TriangleAlert className="h-4 w-4 text-deficit" /></span>
                  <div className="min-w-0">
                    <p className="text-body-md font-medium text-ink">{t.name}
                      <span className="ml-2 rounded bg-deck px-1.5 py-0.5 font-mono text-label-sm text-ink-muted">{t.subject}</span></p>
                    <p className="mt-1 flex flex-wrap gap-x-4 font-mono text-label-sm text-ink-muted">
                      <span>Accuracy <span className="text-deficit">{pct(t.accuracy)}</span> over {t.questions}</span>
                      <span>Level {levelLabel(t.level)}</span>
                      <span>Practised {sinceDays(t.lastPracticedDays)}</span>
                      <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{duration(t.paceSeconds)}/Q</span>
                    </p>
                  </div>
                </div>
                <Link to={`/practice/${t.subTopicId}`} className="shrink-0">
                  <Button size="sm"><Play className="h-3.5 w-3.5" /> Practise this</Button>
                </Link>
              </li>
            ))}
            {data.weakTopics.length === 0 && (
              <li className="py-4 text-body-sm text-ink-muted">
                Nothing to flag yet — a sub-topic appears here once you have attempted at least five questions in it.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>

      {/* Strong sub-topics + what to do next */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <h3 className="inline-flex items-center gap-2 text-headline-sm text-ink"><CircleCheck className="h-4 w-4 text-mastery" /> Strong Sub-topics</h3>
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {data.strongTopics.map((t) => (
                <li key={t.subTopicId} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-body-sm font-medium text-ink">{t.name}</p>
                    <p className="font-mono text-label-sm text-ink-muted">{t.subject} • {t.questions} questions • Level {levelLabel(t.level)}</p>
                  </div>
                  <span className="font-mono text-label-sm text-mastery">{pct(t.accuracy)}</span>
                </li>
              ))}
              {data.strongTopics.length === 0 && (
                <li className="py-3 text-body-sm text-ink-muted">Nothing here yet — five attempts in a sub-topic is the threshold.</li>
              )}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <h3 className="inline-flex items-center gap-2 text-headline-sm text-ink"><TrendingUp className="h-4 w-4 text-primary" /> Recommended Actions</h3>
            <ul className="mt-3 space-y-3">
              {(recs ?? []).map((a) => (
                <li key={a.id} className="flex flex-col gap-2 rounded border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-body-sm font-semibold text-ink">{a.title}</p>
                    {/* The backend's stated reason, not a projection. */}
                    <p className="mt-0.5 text-body-sm text-ink-muted">{a.detail}</p>
                  </div>
                  <Link to={a.href} className="shrink-0">
                    <Button variant="subtle" size="sm"><Target className="h-3.5 w-3.5" />{a.eyebrow}</Button>
                  </Link>
                </li>
              ))}
              {recs?.length === 0 && (
                <li className="text-body-sm text-ink-muted">
                  Recommendations come from your own attempts. Finish a set and they appear here.
                </li>
              )}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
