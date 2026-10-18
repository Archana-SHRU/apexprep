import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, TriangleAlert } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button, Card, CardBody, Field, Input, Select, Tabs } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { api } from '@/lib/api'
import type { UpdateProfileBody } from '@/types/api'

/**
 * The learner's own account, read from and written to `/v1/me/profile`.
 *
 * Saving used to show "Changes will persist once the profile API is connected." It persists now: the form sends
 * a `PATCH` and the response replaces the session, so a reload shows what was saved.
 *
 * Two fields are deliberately read-only. **Email** cannot be changed through the profile API — it is the
 * account's identity and changing it needs a verification flow the backend does not have. **Track** is changed
 * by enrolling, in the header's track switcher, because a track is an enrolment with its own goal and history,
 * not a profile attribute. Both say so rather than accepting an edit that would be silently dropped.
 *
 * The Preferences tab keeps only the one setting the backend actually stores — the focus-tracking opt-out, which
 * is a real column and a real privacy control. The three toggles that were there before (daily reminder, weekly
 * report, adaptive hints) had nothing behind them: no notification service, no scheduled report, and no hint
 * delivery. Toggling them told the learner something had been enabled when nothing had.
 */
export default function Profile() {
  const [tab, setTab] = useState('profile')
  const { session, student, logout, updateProfile } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const { data: enrolments } = useApi(() => api.getLearnerTracks(), [])
  const [form, setForm] = useState({ displayName: '', goal: '', targetRank: '', dailyGoal: '', targetExamDate: '' })
  const [saving, setSaving] = useState(false)

  // Seeded from the server's copy once it arrives, and re-seeded if the session changes underneath.
  useEffect(() => {
    if (!session) return
    setForm({
      displayName: session.displayName,
      goal: session.goal ?? '',
      targetRank: session.targetRank === null ? '' : String(session.targetRank),
      dailyGoal: session.dailyQuestionGoal === null ? '' : String(session.dailyQuestionGoal),
      // The API stores a date; the input wants `yyyy-mm-dd`.
      targetExamDate: session.targetExamDate ? session.targetExamDate.slice(0, 10) : '',
    })
  }, [session])

  if (session === undefined) return <PageSkeleton />

  if (session === null) {
    return (
      <EmptyState icon={TriangleAlert} title="You are not signed in"
        description="Sign in to see your profile." actionLabel="Go to sign in" onAction={() => navigate('/login')} />
    )
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value })

  async function save() {
    setSaving(true)
    try {
      const patch: UpdateProfileBody = {}
      if (form.displayName.trim() && form.displayName.trim() !== session!.displayName) patch.displayName = form.displayName.trim()
      if (form.goal.trim() !== (session!.goal ?? '')) patch.goal = form.goal.trim()

      const rank = Number.parseInt(form.targetRank, 10)
      if (Number.isFinite(rank) && rank > 0 && rank !== session!.targetRank) patch.targetRank = rank

      const daily = Number.parseInt(form.dailyGoal, 10)
      if (Number.isFinite(daily) && daily > 0 && daily !== session!.dailyQuestionGoal) patch.dailyQuestionGoal = daily

      if (form.targetExamDate && form.targetExamDate !== (session!.targetExamDate ?? '').slice(0, 10)) {
        patch.targetExamDate = form.targetExamDate
      }

      if (Object.keys(patch).length === 0) {
        toast({ tone: 'info', title: 'Nothing to save', description: 'No changes were made.' })
        return
      }

      await updateProfile(patch)
      toast({ tone: 'success', title: 'Profile saved' })
    } catch (err) {
      toast({ tone: 'error', title: 'Could not save', description: errorMessage(err instanceof Error ? err : null) || 'Please try again.' })
    } finally {
      setSaving(false)
    }
  }

  async function setFocusOptOut(optOut: boolean) {
    try {
      await updateProfile({ focusTrackingOptOut: optOut })
      toast({ tone: 'success', title: optOut ? 'Focus tracking turned off' : 'Focus tracking turned on' })
    } catch {
      toast({ tone: 'error', title: 'Could not change that setting', description: 'Please try again.' })
    }
  }

  const primaryTrack = enrolments?.find((e) => e.isPrimary)?.track ?? null

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Profile & Settings" subtitle="Account details, your goal and your privacy preferences." />
      <Tabs items={[{ id: 'profile', label: 'Profile' }, { id: 'prefs', label: 'Preferences' }]} value={tab} onChange={setTab} className="w-fit" />

      {tab === 'profile' ? (
        <Card><CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name"><Input value={form.displayName} onChange={set('displayName')} maxLength={120} /></Field>
            <Field label="Email" hint="Your sign-in address; it cannot be changed here.">
              <Input type="email" value={session.email} readOnly disabled />
            </Field>
            <Field label="Track" hint="Switch tracks from the track menu in the header.">
              <Select value={primaryTrack?.id ?? ''} disabled>
                {primaryTrack
                  ? <option value={primaryTrack.id}>{primaryTrack.name}</option>
                  : <option value="">Not enrolled in a track</option>}
              </Select>
            </Field>
            <Field label="Goal"><Input value={form.goal} onChange={set('goal')} maxLength={200} placeholder="What you are working towards" /></Field>
            <Field label="Target rank" hint="Optional; only relevant for a ranked exam.">
              <Input type="number" min={1} className="font-mono" value={form.targetRank} onChange={set('targetRank')} placeholder="—" />
            </Field>
            <Field label="Daily question target">
              <Input type="number" min={1} className="font-mono" value={form.dailyGoal} onChange={set('dailyGoal')} placeholder="—" />
            </Field>
            <Field label="Target date" hint="Drives the countdown on your dashboard.">
              <Input type="date" className="font-mono" value={form.targetExamDate} onChange={set('targetExamDate')} />
            </Field>
          </div>

          {student && (
            <p className="border-t border-line pt-4 font-mono text-label-sm text-ink-muted">
              {student.questionsSolvedTotal.toLocaleString()} questions answered in total
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => void logout().then(() => navigate('/login'))}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
            <Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </CardBody></Card>
      ) : (
        <Card><CardBody className="divide-y divide-line">
          {/* The one preference the backend stores. */}
          <label className="flex items-center justify-between gap-4 py-4">
            <span>
              <span className="block text-body-md font-medium text-ink">Focus tracking</span>
              <span className="mt-0.5 block text-body-sm text-ink-muted">
                Records when a practice tab loses focus, so long gaps are not counted as thinking time. Turning it
                off makes your pace figures less accurate but records nothing about tab switches.
              </span>
            </span>
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#4361EE]"
              checked={!session.focusTrackingOptOut}
              onChange={(e) => void setFocusOptOut(!e.target.checked)}
            />
          </label>

          <div className="py-4">
            <p className="text-body-md font-medium text-ink">Email notifications</p>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              Not available yet — there is no notification service in the backend, so there is nothing to switch on.
            </p>
          </div>
        </CardBody></Card>
      )}
    </div>
  )
}
