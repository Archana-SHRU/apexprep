import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { ApiError, http, setAccessToken, setSessionLostHandler } from '@/lib/http'
import type { Student, TrackId } from '@/types'
import type { AuthResponseDto, UpdateProfileBody, UserDto } from '@/types/api'

/**
 * The signed-in learner, from the backend.
 *
 * What this replaces is worth stating plainly, because the difference is the point of this phase. The previous
 * version accepted any email, never looked at the password, invented a display name from the local part of the
 * address, and wrote the result to `localStorage`. There was no server involved and no way to be wrong.
 *
 * Now:
 *
 * * `login` and `signup` post real credentials to `/v1/auth/login` and `/v1/auth/register`, and a wrong
 *   password fails, because the backend decides.
 * * The **access** token is held in memory (with a `sessionStorage` copy so a reload survives) by
 *   `src/lib/http.ts`. The **refresh** token is an HttpOnly cookie the browser manages and this code cannot
 *   read — which is the reason a reload can restore a session at all: `restore()` asks the server.
 * * `session` is the user the server returned. Nothing about the learner is derived here.
 *
 * `student` carries today's figures alongside identity, because almost every screen wants both and one
 * request each on every mount would be wasteful. It refreshes on demand via `reloadStudent`.
 */

interface AuthCtx {
  /** The signed-in user, or null. `undefined` while the first `/auth/me` is still in flight. */
  session: UserDto | null | undefined
  /** Identity plus today's counts, for the shell and the dashboard. Null until loaded. */
  student: Student | null
  /** True while the session is being restored on a page load, so guards can wait instead of redirecting. */
  restoring: boolean
  /** Signs in and returns the account as the server sees it (role included). */
  login: (email: string, password: string) => Promise<UserDto>
  signup: (name: string, email: string, password: string) => Promise<void>
  completeOnboarding: (trackId: TrackId, goal: string) => Promise<void>
  updateProfile: (patch: UpdateProfileBody) => Promise<void>
  reloadStudent: () => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

/** The context itself, exported for route tests that need to supply a server-shaped session directly. */
export const AuthContext = Ctx
export type { AuthCtx }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<UserDto | null | undefined>(undefined)
  const [student, setStudent] = useState<Student | null>(null)
  const [restoring, setRestoring] = useState(true)
  const mounted = useRef(true)

  // Set in the effect body, not only at initialisation: StrictMode's mount/unmount/remount runs the cleanup
  // once, and without this the flag would stay false and the learner's own details would never arrive.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadStudent = useCallback(async () => {
    try {
      const s = await api.getStudent()
      if (mounted.current) setStudent(s)
    } catch {
      // The shell can render without today's counts; it shows "—" rather than guessing at them.
      if (mounted.current) setStudent(null)
    }
  }, [])

  const adopt = useCallback((auth: AuthResponseDto) => {
    setAccessToken(auth.accessToken)
    setSession(auth.user)
    void loadStudent()
  }, [loadStudent])

  /**
   * Restores a session on a page load.
   *
   * `/v1/auth/me` with the stored access token is tried first; if it is missing or expired the 401 handling in
   * `http.ts` silently exchanges the refresh cookie for a new access token and replays the call. Only if that
   * also fails is there no session — which is the correct answer, not an error to report.
   */
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const user = await http.get<UserDto>('/v1/auth/me')
        if (!alive) return
        setSession(user)
        void loadStudent()
      } catch {
        if (alive) setSession(null)
      } finally {
        if (alive) setRestoring(false)
      }
    })()
    return () => { alive = false }
  }, [loadStudent])

  /** A refresh that fails mid-session means the learner is signed out; clear state so the guard redirects. */
  useEffect(() => {
    setSessionLostHandler(() => {
      if (!mounted.current) return
      setSession(null)
      setStudent(null)
    })
    return () => setSessionLostHandler(null)
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<UserDto> => {
    // No `credentials` default and no demo account: whatever is typed is what is sent.
    const auth = await http.post<AuthResponseDto>('/v1/auth/login', { email, password })
    adopt(auth)
    // The server's account record, so a caller (the admin sign-in) can act on the real role.
    return auth.user
  }, [adopt])

  const signup = useCallback(async (name: string, email: string, password: string) => {
    adopt(await http.post<AuthResponseDto>('/v1/auth/register', { displayName: name, email, password }))
  }, [adopt])

  const updateProfile = useCallback(async (patch: UpdateProfileBody) => {
    const user = await http.patch<UserDto>('/v1/me/profile', patch)
    setSession(user)
    await loadStudent()
  }, [loadStudent])

  /**
   * Onboarding writes the learner's choices to their profile and marks them onboarded — server-side, so the
   * flag survives a different browser. The track also becomes a learner-track enrolment, which is what the
   * adaptive engine and the analytics scope read.
   */
  const completeOnboarding = useCallback(async (trackId: TrackId, goal: string) => {
    try {
      await http.post('/v1/me/tracks', { trackId, makePrimary: true, goalText: goal || undefined })
    } catch (err) {
      // Already enrolled is not a failure of onboarding; anything else is.
      if (!(err instanceof ApiError && (err.status === 409 || err.code === 'ALREADY_ENROLLED'))) throw err
    }
    await updateProfile({ primaryTrackId: trackId, goal: goal || undefined, completeOnboarding: true })
  }, [updateProfile])

  const logout = useCallback(async () => {
    try {
      await http.post('/v1/auth/logout', {})
    } catch {
      // Signing out locally must succeed even if the call does not; the cookie is cleared server-side on
      // expiry regardless, and leaving the learner apparently signed in would be worse.
    }
    setAccessToken(null)
    setSession(null)
    setStudent(null)
  }, [])

  const value = useMemo(
    () => ({ session, student, restoring, login, signup, completeOnboarding, updateProfile, reloadStudent: loadStudent, logout }),
    [session, student, restoring, login, signup, completeOnboarding, updateProfile, loadStudent, logout],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
