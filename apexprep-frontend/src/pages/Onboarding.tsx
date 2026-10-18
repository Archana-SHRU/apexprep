import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronLeft } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button, Field, Input, Progress } from '@/components/ui'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Track } from '@/types'

const STEPS = ['Track', 'Goal', 'Daily target']

/**
 * Choosing a learning track and setting a goal.
 *
 * The tracks are the published tracks of the learner's organisation, from `GET /v1/tracks` — not a fixed list
 * of six exam slugs. A school class, a competitive exam and an olympiad are all tracks, so the copy here talks
 * about what the learner is preparing for rather than assuming an entrance exam, and the subtitle of each
 * option is whatever the track's own `kind`, grade and curriculum say.
 *
 * Finishing writes to the backend: an enrolment in `me/tracks` and the profile fields in `me/profile`, with
 * `completeOnboarding: true`. The flag lives on the server, so signing in from another browser does not send
 * the learner through this again.
 */
export default function Onboarding() {
  const [step, setStep] = useState(0)
  const [trackId, setTrackId] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [targetRank, setTargetRank] = useState('')
  const [dailyGoal, setDailyGoal] = useState('50')
  const [busy, setBusy] = useState(false)
  const { completeOnboarding, updateProfile } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const { data: tracks, loading, error, refetch } = useApi(() => api.getTracks(), [])
  const selected = tracks?.find((t) => t.id === trackId) ?? null
  const groups = useMemo(() => groupByKind(tracks ?? []), [tracks])
  // A rank means something only for a ranked exam; school classes and Olympiads have none.
  const ranked = selected?.kind !== 'school' && selected?.kind !== 'olympiad'

  async function next() {
    if (step < STEPS.length - 1) {
      if (step === 0 && !trackId) {
        toast({ tone: 'error', title: 'Pick a track', description: 'Choose what you are preparing for to continue.' })
        return
      }
      setStep(step + 1)
      return
    }
    if (!trackId) return
    setBusy(true)
    try {
      await completeOnboarding(trackId, goal.trim())
      // Optional numbers, sent only when the learner actually entered one. An unset target stays unset rather
      // than defaulting to a number the learner never chose.
      const patch: { targetRank?: number; dailyQuestionGoal?: number } = {}
      const rank = Number.parseInt(targetRank, 10)
      const daily = Number.parseInt(dailyGoal, 10)
      if (ranked && Number.isFinite(rank) && rank > 0) patch.targetRank = rank
      if (Number.isFinite(daily) && daily > 0) patch.dailyQuestionGoal = daily
      if (Object.keys(patch).length > 0) await updateProfile(patch)

      toast({ tone: 'success', title: 'Setup complete', description: 'Your first adaptive set is ready.' })
      navigate('/dashboard')
    } catch (err) {
      toast({ tone: 'error', title: 'Could not save your setup', description: errorMessage(err instanceof Error ? err : null) || 'Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Set up your preparation" subtitle={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`}>
      <Progress value={((step + 1) / STEPS.length) * 100} className="mb-6" />

      {step === 0 && (
        <div className="grid gap-2">
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}

          {!loading && error && (
            <div className="rounded border border-line bg-deck p-4">
              <p className="text-body-sm text-ink-soft">{errorMessage(error)}</p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={refetch}>Try again</Button>
            </div>
          )}

          {!loading && !error && tracks?.length === 0 && (
            <p className="rounded border border-line bg-deck p-4 text-body-sm text-ink-soft">
              No tracks have been published for your organisation yet. Ask your administrator to publish one.
            </p>
          )}

          {groups.map((g) => (
            <section key={g.label} className="grid gap-2">
              {groups.length > 1 && <p className="eyebrow mt-2 first:mt-0">{g.label}</p>}
              <div className={cn('grid gap-2', g.compact && 'grid-cols-3')}>
                {g.tracks.map((t) => {
                  const chosen = trackId === t.id
                  const subtitle = t.description ?? trackContext(t, { withKind: groups.length === 1 })
                  return (
                    <button key={t.id} onClick={() => setTrackId(t.id)} aria-pressed={chosen}
                      className={cn('flex items-start justify-between gap-3 rounded border text-left transition-colors',
                        g.compact ? 'items-center px-3 py-2.5' : 'p-3',
                        chosen ? 'border-[1.5px] border-primary bg-[rgba(67,97,238,0.04)]' : 'border-line hover:bg-deck')}>
                      <span>
                        <span className="block text-body-md font-semibold text-ink">{t.name}</span>
                        {!g.compact && subtitle && <span className="mt-0.5 block text-body-sm text-ink-muted">{subtitle}</span>}
                      </span>
                      {chosen && <Check className={cn('h-4 w-4 shrink-0 text-primary', !g.compact && 'mt-1')} />}
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <Field label="What are you working towards?" hint="In your own words — an institute, a grade, a competition.">
            <Input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200} placeholder="e.g. IIT Bombay CSE" />
          </Field>
          {/* Optional, and labelled as optional: nothing in the product requires a rank, and a rank is
              meaningless on a school or olympiad track, so it is not asked for there. */}
          {ranked && (
            <Field label="Target rank (optional)" hint="Only relevant if you are preparing for a ranked exam.">
              <Input type="number" min={1} value={targetRank} onChange={(e) => setTargetRank(e.target.value)} className="font-mono" placeholder="—" />
            </Field>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <Field label="Questions per day" hint="Your daily target on the dashboard.">
            <Input type="number" min={1} step={5} value={dailyGoal} onChange={(e) => setDailyGoal(e.target.value)} className="font-mono" />
          </Field>
          <div className="rounded border border-line bg-deck p-4">
            <p className="eyebrow">Summary</p>
            <dl className="mt-2 space-y-1 text-body-sm">
              <Row k="Track" v={selected?.name ?? 'Not set'} />
              <Row k="Goal" v={goal.trim() || 'Not set'} />
              {ranked && <Row k="Target rank" v={targetRank.trim() ? `AIR < ${targetRank.trim()}` : 'Not set'} />}
              <Row k="Daily target" v={dailyGoal.trim() ? `${dailyGoal.trim()} questions` : 'Not set'} />
            </dl>
          </div>
        </div>
      )}

      <div className="mt-6 flex gap-2">
        {step > 0 && <Button variant="secondary" size="lg" onClick={() => setStep(step - 1)}><ChevronLeft className="h-4 w-4" /> Back</Button>}
        <Button size="lg" className="flex-1" onClick={() => void next()} disabled={busy || (step === 0 && !trackId)}>
          {busy ? 'Saving…' : step === STEPS.length - 1 ? 'Finish setup' : 'Continue'}
        </Button>
      </div>
    </AuthLayout>
  )
}

/**
 * A one-line description of a track from its own learning-context fields, for tracks with no description.
 *
 * `withKind: false` is for a list already grouped under a kind heading: the kind is left out, and so is a
 * grade that only repeats the track's name, and what is left may be the empty string.
 */
export function trackContext(t: Track, { withKind = true }: { withKind?: boolean } = {}): string {
  const parts = [
    withKind ? (t.kind === 'school' ? 'School' : t.kind === 'olympiad' ? 'Olympiad' : t.kind === 'competitive_exam' ? 'Competitive exam' : null) : null,
    withKind || t.gradeLabel !== t.name ? t.gradeLabel : null,
    t.curriculum,
    t.examFamily,
    t.examYear ? String(t.examYear) : null,
  ].filter((p): p is string => Boolean(p))
  return parts.length > 0 ? parts.join(' · ') : withKind ? 'Learning track' : ''
}

/**
 * The four categories of `tracks.kind` (migration 0013), in the order onboarding shows them. This names the
 * categories of the schema, not any track: which tracks exist, their names and their order within a group all
 * come from `GET /v1/tracks`, so a new class, exam or Olympiad appears here without a frontend change.
 * School classes are short labels, so they sit in a compact grid.
 */
const KIND_GROUPS: { kinds: Track['kind'][]; label: string; compact: boolean }[] = [
  { kinds: ['school'], label: 'School', compact: true },
  { kinds: ['competitive_exam'], label: 'Competitive exams', compact: false },
  { kinds: ['olympiad'], label: 'Olympiads', compact: false },
  { kinds: ['other', null], label: 'Other', compact: false },
]

/** The tracks under their kind headings, keeping the backend's order inside each; empty groups are dropped. */
function groupByKind(tracks: Track[]) {
  return KIND_GROUPS.map((g) => ({ ...g, tracks: tracks.filter((t) => g.kinds.includes(t.kind)) })).filter((g) => g.tracks.length > 0)
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4"><dt className="text-ink-muted">{k}</dt><dd className="font-medium text-ink">{v}</dd></div>
}
