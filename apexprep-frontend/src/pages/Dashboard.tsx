import { Link } from 'react-router-dom'
import { ArrowRight, Inbox, ListChecks, PlayCircle, TrendingUp, TriangleAlert } from 'lucide-react'
import { Button, Card, CardBody, Progress } from '@/components/ui'
import { EmptyState } from '@/components/EmptyState'
import { StatStrip } from '@/components/StatStrip'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'
import { levelLabel, levelToBar, NO_DATA, pct, studyTime } from '@/lib/format'
import { greeting } from '@/lib/utils'
import type { Recommendation } from '@/types'

/**
 * The learner's own dashboard.
 *
 * Every figure comes from one of three real endpoints: `/v1/auth/me` and `/v1/me/summary` for identity and
 * today's counts, `/v1/me/recommendations` for what to open next, and `/v1/me/analytics` for the subject panel.
 *
 * Several things this screen used to state have no backing in the product and are gone rather than approximated:
 *
 * * **A peer band** ("Top 5%"). There is no cohort comparison in the backend; nothing computes percentiles.
 * * **"+4% Mastery" for finishing a set.** Mastery is an L1–L5 band moved by the engine after each answer; a
 *   predicted gain is not something anyone can know in advance.
 * * **"~25 Mins" for a set.** No duration estimate exists server-side.
 * * **"On track".** A judgement with nothing behind it.
 *
 * What replaced them is the backend's own reason for each recommendation, the learner's real level per subject,
 * and honest blanks where they have not practised yet.
 */
export default function Dashboard() {
  const { data: student, loading: studentLoading, error: studentError, refetch } = useApi(() => api.getStudent(), [])
  const { data: recs } = useApi(() => api.getRecommendations(), [])
  const { data: analytics } = useApi(() => api.getAnalytics('30d'), [])

  if (studentLoading) return <PageSkeleton />

  if (studentError || !student) {
    return (
      <EmptyState icon={TriangleAlert} title="Could not load your dashboard"
        description={errorMessage(studentError)} actionLabel="Try again" onAction={refetch} />
    )
  }

  const cont = recs?.find((r) => r.kind === 'continue') ?? null
  const practice = recs?.find((r) => r.kind === 'practice') ?? null
  const focus = recs?.find((r) => r.kind === 'focus') ?? null
  const firstName = student.name.split(' ')[0] || student.name

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-[2rem] font-bold leading-10 tracking-[-0.025em] text-ink sm:text-headline-xl">
            {greeting()}, {firstName} 👋
          </h1>
          <p className="mt-1 text-body-md text-ink-muted">{examLine(student.daysToExam)}</p>
        </div>
        {/* Only shown when the learner set a goal. It used to assert a rank pace regardless. */}
        {student.goal && (
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-[#E3E7FF] px-3.5 py-1.5 text-body-sm font-medium text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-mastery" />
            Target: {student.goal}{student.targetRank !== null && ` (AIR < ${student.targetRank})`}
          </span>
        )}
      </div>

      {/* Continue learning — the sub-topic of the learner's most recent session. */}
      {cont ? (
        <Card>
          <CardBody className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-[#E3E7FF] px-2 py-0.5 font-mono text-label-sm uppercase text-primary">{cont.eyebrow}</span>
                <span className="text-body-sm text-ink-muted">• {cont.subjectLabel}</span>
              </p>
              <h2 className="mt-2.5 text-headline-sm text-ink">Continue: {cont.title}</h2>
              {/* The backend's own sentence for why this is the suggestion. */}
              <p className="mt-1.5 max-w-2xl text-body-sm text-ink-muted">{cont.detail}</p>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              <Link to={cont.href}><Button size="lg" className="w-full sm:w-auto"><PlayCircle className="h-4 w-4" /> Continue Practice</Button></Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody>
            <h2 className="text-headline-sm text-ink">Start your first set</h2>
            <p className="mt-1.5 max-w-2xl text-body-sm text-ink-muted">
              Once you have practised something, this is where you pick up where you left off. Recommendations come
              from your own attempts, so there are none yet.
            </p>
            <Link to="/practice" className="mt-4 inline-block">
              <Button size="lg"><PlayCircle className="h-4 w-4" /> Browse practice sets</Button>
            </Link>
          </CardBody>
        </Card>
      )}

      {/* Today — real counts, with "—" where there is genuinely nothing yet. */}
      <StatStrip stats={[
        { label: 'Study Streak', value: String(student.streakDays), unit: student.streakDays === 1 ? 'Day' : 'Days', note: student.streakDays > 0 ? '🔥' : undefined },
        {
          label: 'Solved Today',
          value: String(student.solvedToday),
          unit: student.dailyGoal === null ? 'Qs' : `/ ${student.dailyGoal} Qs`,
        },
        { label: "Today's Accuracy", value: pct(student.todayAccuracy) },
        { label: 'Study Time', value: studyTime(student.studyMinutesToday) },
      ]} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="space-y-6">
          {/* Recommended practice — the lowest-accuracy sub-topic with enough attempts to mean something. */}
          {practice && <RecommendedPractice rec={practice} />}

          {/* Focus area — the sub-topic left longest. */}
          {focus && (
            <Card>
              <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#FEF2F2]"><TriangleAlert className="h-4 w-4 text-deficit" /></span>
                  <div>
                    <p className="eyebrow text-deficit">{focus.eyebrow} <span className="text-ink-muted">• {focus.subjectLabel}</span></p>
                    <h3 className="mt-1 text-headline-sm text-ink">{focus.title}</h3>
                    <p className="mt-1 max-w-md text-body-sm text-ink-muted">{focus.detail}</p>
                  </div>
                </div>
                <Link to={focus.href} className="shrink-0">
                  <Button variant="subtle">
                    Review &amp; Practice{focus.questionCount > 0 && ` (${focus.questionCount} Qs)`} <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
              </CardBody>
            </Card>
          )}

          {recs?.length === 0 && (
            <EmptyState
              icon={Inbox}
              title="No recommendations yet"
              description="Recommendations are built from your own attempts. Finish a practice set and they will appear here."
            />
          )}
        </div>

        {/* Subject progress */}
        <Card className="h-fit">
          <CardBody>
            <div className="flex items-center justify-between">
              <h3 className="text-headline-sm text-ink">Subject Progress</h3>
              <Link to="/analytics" className="font-mono text-label-sm text-primary hover:underline">View Details →</Link>
            </div>

            <div className="mt-5 space-y-5">
              {(analytics?.subjectSummary ?? []).map((s) => (
                <div key={s.id}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2 text-body-md font-medium text-ink">
                      <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}
                    </span>
                    <span className="flex items-center gap-3">
                      {/*
                        The subject's mean L1–L5 band across its sub-topics, to one decimal, as the backend
                        reports it. Labelled "Level" below, and never presented as a percentage.
                      */}
                      <span className="font-mono text-label-sm" style={{ color: s.color }}>{levelLabel(s.level)}</span>
                      <Link to={`/learn/${s.id}`} className="font-mono text-label-sm text-primary hover:underline">Continue</Link>
                    </span>
                  </div>
                  <Progress className="mt-2" value={levelToBar(s.level)} color={s.color} />
                  <div className="mt-1.5 flex justify-between text-body-sm text-ink-muted">
                    <span>Strongest: {s.strongest ?? NO_DATA}</span>
                    <span>Needs review: {s.needsReview ?? NO_DATA}</span>
                  </div>
                </div>
              ))}

              {analytics && analytics.subjectSummary.length === 0 && (
                <p className="text-body-sm text-ink-muted">
                  No subjects to show yet — enrol in a track and its subjects appear here.
                </p>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between border-t border-line pt-4 text-body-sm">
              {/* Accuracy over the last 30 days: a real ratio of real counts. There is no "overall mastery %". */}
              <span className="text-ink-muted">
                Accuracy (30 days): <strong className="text-ink">{pct(analytics?.overallAccuracy)}</strong>
              </span>
              <span className="font-mono text-label-sm text-ink-muted">
                {analytics ? `${analytics.questionsSolved.toLocaleString()} questions` : NO_DATA}
              </span>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

/** The greeting's second line. A learner with no target date simply is not told about one. */
function examLine(daysToExam: number | null): string {
  if (daysToExam === null) return 'Here is your personalised focus for today.'
  if (daysToExam < 0) return 'Your target date has passed — update it in your profile. Here is your focus for today.'
  if (daysToExam === 0) return 'Your target date is today. Here is your focus.'
  return `${daysToExam} ${daysToExam === 1 ? 'day' : 'days'} until your target date. Here is your personalised focus for today.`
}

function RecommendedPractice({ rec }: { rec: Recommendation }) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <p className="eyebrow text-primary">{rec.eyebrow}</p>
          <span className="font-mono text-label-sm text-ink-muted">Level {levelLabel(rec.level)}</span>
        </div>
        <h3 className="mt-2 text-headline-sm text-ink">{rec.title}</h3>
        <p className="mt-1.5 text-body-sm text-ink-muted">{rec.detail}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded bg-[#F3F3FF] px-4 py-2.5 text-body-sm text-ink-soft">
          <span className="inline-flex items-center gap-1.5">
            <ListChecks className="h-4 w-4 text-ink-muted" /> {rec.questionCount} Questions available
          </span>
          {/* Accuracy so far here, which is the evidence behind the recommendation. */}
          <span className="inline-flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4 text-ink-muted" /> {pct(rec.accuracy)} so far
          </span>
        </div>
        <div className="mt-5 flex items-center justify-between gap-3">
          <p className="text-body-sm text-ink-muted">{rec.subjectLabel}</p>
          <Link to={rec.href}><Button>Start Practice <ArrowRight className="h-4 w-4" /></Button></Link>
        </div>
      </CardBody>
    </Card>
  )
}
