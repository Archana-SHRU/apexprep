import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Bell, Flame, LayoutDashboard, LogOut, Menu, Search, X, BookOpen, Target, ClipboardList, BarChart3, FileText, User } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/input'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { api } from '@/lib/api'
import { http } from '@/lib/http'
import { NO_DATA } from '@/lib/format'
import { trackContext } from '@/pages/Onboarding'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { to: '/learn', label: 'Learn', icon: BookOpen },
  { to: '/practice', label: 'Practice', icon: Target },
  { to: '/tests', label: 'Tests', icon: ClipboardList },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/reports', label: 'Reports', icon: FileText },
]

/**
 * The signed-in shell.
 *
 * Everything in the header is the signed-in learner's own: their name and initial from `/v1/auth/me`, their
 * streak from `/v1/me/summary`, and the track switcher listing the tracks they are actually enrolled in
 * (`GET /v1/me/tracks`). It previously rendered a hardcoded student — "Arjun Verma", an 18-day streak and a
 * target of AIR < 420 — for every visitor, and offered a fixed list of six exam tracks whether or not the
 * organisation had them.
 *
 * Where the backend has no figure the header shows an em dash rather than a plausible number. A learner with no
 * target rank set simply has no target line.
 */
export function StudentLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const { logout, student, reloadStudent } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const { data: enrolments, refetch: refetchTracks } = useApi(() => api.getLearnerTracks(), [])
  const primary = enrolments?.find((e) => e.isPrimary) ?? enrolments?.[0] ?? null
  const track = primary?.track ?? null

  /**
   * Switching the primary track.
   *
   * `PATCH /v1/me/tracks/:id { isPrimary: true }` moves it server-side and keeps the profile in step, so the
   * choice survives a reload and is the same on every device. The old switcher only changed local state.
   */
  async function switchTrack(nextTrackId: string) {
    if (!nextTrackId || nextTrackId === primary?.trackId) return
    setSwitching(true)
    try {
      await http.patch(`/v1/me/tracks/${nextTrackId}`, { isPrimary: true })
      refetchTracks()
      await reloadStudent()
      const name = enrolments?.find((e) => e.trackId === nextTrackId)?.track.name
      toast({ tone: 'success', title: 'Track switched', description: name ?? 'Your primary track has changed.' })
    } catch {
      toast({ tone: 'error', title: 'Could not switch track', description: 'Please try again.' })
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-deck">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="mx-auto flex h-14 max-w-shell items-center gap-3 px-4 sm:px-6">
          <Link to="/dashboard" aria-label="ApexPrep home"><Logo /></Link>

          {track && (
            <button
              onClick={() => setMenuOpen(true)}
              className="hidden shrink-0 items-center gap-1 rounded border border-line bg-deck px-2 py-1 font-mono text-label-sm text-ink-soft hover:border-line-strong md:inline-flex"
            >
              {track.shortName}
              {/* Only shown when the track has one — a school class has no exam year. */}
              {track.examYear !== null && <span className="text-ink-muted">{track.examYear}</span>}
            </button>
          )}

          <nav className="ml-2 hidden flex-1 items-center gap-1 lg:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => cn('rounded px-3 py-1.5 text-body-sm font-medium transition-colors',
                  isActive ? 'bg-primary text-white' : 'text-ink-soft hover:bg-deck')}>
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" className="hidden sm:inline-flex" onClick={() => setSearchOpen(true)}>
              <Search className="h-3.5 w-3.5" /> Search
            </Button>
            <span className="hidden items-center gap-1 rounded-full border border-mastery/40 bg-mastery/10 px-2.5 py-1 font-mono text-label-sm text-mastery sm:inline-flex">
              <Flame className="h-3 w-3" /> {student ? `${student.streakDays} Days` : NO_DATA}
            </span>
            <button className="relative text-ink-muted hover:text-ink" aria-label="Notifications"
              onClick={() => toast({ tone: 'info', title: 'No new notifications', description: 'You are all caught up for today.' })}>
              <Bell className="h-4 w-4" />
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-deficit" />
            </button>
            <Link to="/profile" className="hidden items-center gap-2 border-l border-line pl-3 md:flex">
              <div className="text-right leading-tight">
                <p className="text-body-sm font-semibold text-ink">{student?.name ?? NO_DATA}</p>
                {/* A target rank is optional, and meaningless on a school or olympiad track, so the line is
                    present only when the learner set one. */}
                {student?.targetRank !== null && student?.targetRank !== undefined && (
                  <p className="font-mono text-label-sm text-ink-muted">Target: AIR &lt; {student.targetRank}</p>
                )}
              </div>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary font-semibold text-white">{student?.avatarInitial ?? '·'}</span>
            </Link>
            <button className="text-ink-soft lg:hidden" aria-label="Open menu" onClick={() => setMenuOpen(true)}><Menu className="h-5 w-5" /></button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-shell flex-1 px-4 py-6 pb-24 sm:px-6 sm:py-8 lg:pb-8">
        <Outlet />
      </main>

      {/* Mobile bottom navigation HUD */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 grid grid-cols-5 border-t border-line bg-canvas lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        {NAV.slice(0, 5).map((n) => (
          <NavLink key={n.to} to={n.to}
            className={({ isActive }) => cn('flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium', isActive ? 'text-primary' : 'text-ink-muted')}>
            <n.icon className="h-4 w-4" />{n.label}
          </NavLink>
        ))}
      </nav>

      <footer className="hidden border-t border-line bg-canvas lg:block">
        <div className="mx-auto flex max-w-shell flex-col gap-2 px-6 py-5 text-body-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <p><span className="font-semibold text-ink">ApexPrep</span> — Adaptive Practice Platform</p>
          <p className="font-mono text-label-sm">© {new Date().getFullYear()} ApexPrep Engine</p>
        </div>
      </footer>

      {/* Mobile / track drawer */}
      <Dialog open={menuOpen} onClose={() => setMenuOpen(false)} title="Navigation & Track" description="Switch track or jump to a section.">
        <div className="space-y-4">
          <label className="block">
            <span className="eyebrow">Track</span>
            {enrolments && enrolments.length > 0 ? (
              <Select className="mt-1.5" value={primary?.trackId ?? ''} disabled={switching}
                onChange={(e) => void switchTrack(e.target.value)}>
                {enrolments.map((e) => (
                  <option key={e.trackId} value={e.trackId}>
                    {e.track.name}{e.track.examYear !== null ? ` ${e.track.examYear}` : ''}
                  </option>
                ))}
              </Select>
            ) : (
              /* Only the learner's own enrolments are listed. Nothing here invents a catalogue of tracks. */
              <p className="mt-1.5 text-body-sm text-ink-muted">
                You are not enrolled in a track yet. <Link to="/onboarding" className="text-primary hover:underline">Choose one</Link>.
              </p>
            )}
            {track && <p className="mt-1.5 font-mono text-label-sm text-ink-muted">{trackContext(track)}</p>}
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[...NAV, { to: '/profile', label: 'Profile', icon: User }].map((n) => (
              <button key={n.to} onClick={() => { setMenuOpen(false); navigate(n.to) }}
                className="flex items-center gap-2 rounded border border-line px-3 py-2 text-body-sm text-ink-soft hover:bg-deck">
                <n.icon className="h-4 w-4 text-ink-muted" />{n.label}
              </button>
            ))}
          </div>
          <Button variant="secondary" className="w-full" onClick={() => void logout().then(() => navigate('/login'))}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </Dialog>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} trackId={primary?.trackId ?? null} />
    </div>
  )
}

/**
 * Header search over the learner's own published syllabus.
 *
 * The entries come from the track tree the backend serves, so every result opens something that exists. The
 * previous version listed five fixed suggestions with mock ids, which navigated to pages that no longer have
 * anything behind them.
 */
function SearchDialog({ open, onClose, trackId }: { open: boolean; onClose: () => void; trackId: string | null }) {
  const [q, setQ] = useState('')
  const navigate = useNavigate()
  const { data: index, loading } = useApi(
    () => (trackId ? api.getSyllabusIndex(trackId) : Promise.resolve([])),
    [trackId, open],
  )

  const needle = q.trim().toLowerCase()
  const results = needle.length === 0
    ? []
    : (index ?? []).filter((r) => r.label.toLowerCase().includes(needle)).slice(0, 12)

  return (
    <Dialog open={open} onClose={onClose} title="Search" description="Subjects, chapters, theory and practice in your syllabus.">
      <Input autoFocus placeholder="Search the syllabus…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {!trackId && <li className="py-3 text-body-sm text-ink-muted">Choose a track first.</li>}
        {trackId && loading && <li className="py-3 text-body-sm text-ink-muted">Loading your syllabus…</li>}
        {trackId && !loading && needle.length === 0 && (
          <li className="py-3 text-body-sm text-ink-muted">Type to search {index?.length ?? 0} places in your syllabus.</li>
        )}
        {results.map((r) => (
          <li key={`${r.to}-${r.context}`}>
            <button onClick={() => { onClose(); setQ(''); navigate(r.to) }} className="w-full px-1 py-2.5 text-left hover:text-primary">
              <span className="block text-body-sm text-ink-soft">{r.label}</span>
              <span className="block font-mono text-label-sm text-ink-muted">{r.context}</span>
            </button>
          </li>
        ))}
        {trackId && !loading && needle.length > 0 && results.length === 0 && (
          <li className="py-3 text-body-sm text-ink-muted">No matches in your syllabus.</li>
        )}
      </ul>
    </Dialog>
  )
}
