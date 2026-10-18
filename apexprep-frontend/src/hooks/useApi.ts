import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, NetworkError } from '@/lib/http'

/**
 * A small data-fetching hook over the real API.
 *
 * The change from the mock version is `error` being something a page can act on rather than something to
 * ignore. A failed request now leaves `data` as null and `error` set, and every screen that uses this renders
 * an error state from it — because the alternative, falling back to sample content, would tell the learner a
 * comfortable lie about their own progress.
 *
 * `refetch` is here so an error state can offer "Try again" without remounting the page.
 */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)
  const alive = useRef(true)

  /**
   * Marks the hook mounted, so a resolved request is allowed to set state.
   *
   * The assignment in the effect **body** is what makes this correct, and leaving it out is a bug that only
   * appears in development. React 18's StrictMode deliberately mounts, unmounts and remounts every component
   * once, to surface effects that are not idempotent. That cleanup runs, setting this to `false`; without the
   * line below nothing ever sets it back, so on the real mount every guarded `setState` is skipped, `loading`
   * stays `true`, and the screen shows its skeleton for ever — even though the request succeeded.
   *
   * A production build does not double-invoke, which is exactly why this has to be got right rather than
   * discovered by whoever runs `npm run dev`.
   */
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    let current = true
    setLoading(true)
    fn()
      .then((d) => { if (current && alive.current) { setData(d); setError(null) } })
      .catch((e) => {
        if (!current || !alive.current) return
        setData(null)
        setError(e instanceof Error ? e : new Error(String(e)))
      })
      .finally(() => { if (current && alive.current) setLoading(false) })
    return () => { current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const refetch = useCallback(() => setTick((n) => n + 1), [])

  return { data, loading, error, refetch }
}

/**
 * The sentence to show a learner for a failed request.
 *
 * Deliberately not the raw message for every case: a 403 means the learner's account cannot see this, which is
 * worth saying plainly, while a 500's internal message is not useful to them. Where the backend wrote a
 * message meant for a person — a 409 conflict, a 422 validation failure — that message is shown as written.
 */
export function errorMessage(error: Error | null): string {
  if (!error) return ''
  if (error instanceof NetworkError) return 'Could not reach the server. Check that the backend is running, then try again.'
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Please sign in again.'
    if (error.status === 403) return 'Your account does not have access to this.'
    if (error.status === 404) return 'This is not available — it may have been unpublished.'
    if (error.status === 429) return 'Too many requests just now. Give it a moment and try again.'
    if (error.status >= 500 && error.status !== 503) return 'The server had a problem with this request. Please try again.'
    return error.message
  }
  return error.message
}
