import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invalidatePerformance, mapQuestion } from '@/lib/api'
import { ApiError, http } from '@/lib/http'
import type { AttemptOutcome, AttemptState, Progress, Question } from '@/types'
import type {
  AttemptResultDto, NextQuestionDto, PracticeSessionDto, RevealedHintDto, SessionEventBody, SessionStartDto, StudentResponseBody,
} from '@/types/api'

/**
 * A practice session, driven by the backend's adaptive engine.
 *
 * ## What changed, and why it had to
 *
 * The previous version received a fixed array of questions — each carrying its own `correctKey` — and graded
 * every answer in the browser with a string comparison. Two things were wrong with that, and neither is a
 * detail:
 *
 * 1. **The answer key was in the page.** Anyone could read it from the network tab. The backend now sends a
 *    question with no key at all (the payload is built from a column allow-list), and the key first appears in
 *    the *response* to a submitted attempt.
 * 2. **The browser decided who was right.** Correctness now comes from `POST /v1/practice/attempts`, which
 *    grades against the stored key, writes an immutable attempt row, and moves the learner's θ and L1–L5 level.
 *    Nothing in this file compares an answer to anything.
 *
 * The questions also arrive one at a time, because that is what "adaptive" means: the engine picks the next
 * question from the learner's updated ability, so it cannot know question three before question two is
 * answered. A batch would defeat the whole mechanism.
 *
 * ## What deliberately did not change
 *
 * The hook's public surface is the same, so the approved UI keeps working: `current`, `attempts`, `elapsed`,
 * `attempt`, `select`, `setValue`, `clear`, `toggleFlag`, `submitCurrent`, `go`, `next`, `score`. The session
 * is created with a `targetQuestionCount`, which is what keeps "Question 4 of 15", the progress bar and
 * "Finish set" meaning what they meant before.
 *
 * `attempts` grows as questions are served rather than being sized up-front. The palette therefore shows the
 * questions seen so far, out of the target — which is the honest picture of an adaptive set.
 */

/** The set length the UI is built around. Sent to the backend so the server agrees what "the set" is. */
export const DEFAULT_SET_SIZE = 15

export interface PracticeSessionState {
  // --- the UI's existing surface
  current: number
  attempts: AttemptState[]
  elapsed: number
  attempt: AttemptState | undefined
  select: (key: string) => void
  setValue: (value: string) => void
  setText: (text: string) => void
  toggleMatrix: (leftKey: string, rightKey: string) => void
  clear: () => void
  toggleFlag: () => void
  submitCurrent: () => Promise<void>
  revealHint: () => Promise<void>
  revealingHint: boolean
  go: (i: number) => void
  next: () => Promise<void>
  score: { correct: number; incorrect: number; unattempted: number; graded: number; answered: number; accuracy: number | null }

  // --- what the backend adds
  /** The questions served so far, in order. */
  questions: Question[]
  question: Question | undefined
  session: PracticeSessionDto | null
  /** The engine's own view of the learner: θ, L1–L5 level and counts. Never computed here. */
  progress: Progress | null
  targetCount: number
  loading: boolean
  submitting: boolean
  error: Error | null
  /** True when the engine has no more eligible questions — a real state, not an error to hide. */
  exhausted: boolean
  /** Set when the pool was thin enough that the engine widened its search. */
  contentGap: NextQuestionDto['contentGap'] | null
  finished: boolean
  finish: () => Promise<void>
  retry: () => void
  /** Continue after fresh questions were generated into the pool; the engine still picks the next one. */
  refill: () => Promise<void>
}

/**
 * A fresh v4 UUID.
 *
 * Used for two things the backend validates differently: the `Idempotency-Key` header on an attempt (8–128
 * characters, so a retry after a dropped response replays instead of grading twice) and `clientEventId` on a
 * focus event, which **must be a UUID** — a bare hex string is rejected with `VALIDATION_FAILED`. One generator
 * satisfying the stricter of the two rules avoids getting that wrong in one place and not the other.
 *
 * `randomUUID` needs a secure context, which `http://localhost` is; the fallback covers a plain-HTTP origin on a
 * LAN address, where it is absent.
 */
function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  // Set the version (4) and variant bits, so the result is a well-formed v4 UUID and passes @IsUUID().
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Builds the response body the backend expects for this question's type. */
function responseBody(q: Question, a: AttemptState): StudentResponseBody {
  switch (q.type) {
    case 'single_correct':
    case 'assertion_reason':
    case 'multi_correct':
      return { optionKeys: a.selectedKeys }
    case 'integer':
    case 'numeric':
      return { value: (a.value ?? '').trim() }
    case 'long_form':
      return { text: (a.text ?? '').trim() }
    case 'matrix_match': {
      const raw = a.matrix ?? {}
      const cleaned: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (Array.isArray(v) && v.length > 0) {
          cleaned[k] = [...v].sort()
        }
      }
      return { matrix: cleaned }
    }
  }
}

function hasAnswer(q: Question, a: AttemptState | undefined): boolean {
  if (!a) return false
  if (q.type === 'integer' || q.type === 'numeric') return (a.value ?? '').trim().length > 0
  if (q.type === 'long_form') return (a.text ?? '').trim().length > 0
  if (q.type === 'matrix_match') {
    if (!a.matrix) return false
    return Object.values(a.matrix).some((rights) => Array.isArray(rights) && rights.length > 0)
  }
  return a.selectedKeys.length > 0
}

function toOutcome(r: AttemptResultDto): AttemptOutcome {
  return {
    attemptId: r.attemptId,
    correct: r.correct,
    outcome: r.outcome,
    revealedAnswer: r.revealedAnswer,
    explanationAvailable: r.explanationAvailable,
    probableGuess: r.probableGuess,
    levelChange: r.level.change,
  }
}

export function usePracticeSession(subTopicId: string | undefined, opts: { targetCount?: number } = {}) {
  const targetCount = opts.targetCount ?? DEFAULT_SET_SIZE

  const [session, setSession] = useState<PracticeSessionDto | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  /** Parallel to `questions`: the served-item id each attempt must be submitted against. */
  const [itemIds, setItemIds] = useState<string[]>([])
  const [attempts, setAttempts] = useState<AttemptState[]>([])
  const [current, setCurrent] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [revealingHint, setRevealingHint] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const [contentGap, setContentGap] = useState<NextQuestionDto['contentGap'] | null>(null)
  const [finished, setFinished] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const alive = useRef(true)
  // Set in the effect body, not only at initialisation: StrictMode's mount/unmount/remount runs the cleanup
  // once, and without this the flag would stay false and every served question would be dropped on arrival.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /** The current session id, for the unmount cleanup, which cannot read state. */
  const sessionRef = useRef<string | null>(null)
  useEffect(() => { sessionRef.current = session?.id ?? null }, [session])

  // ---------------------------------------------------------------- serving questions

  const absorb = useCallback((dto: NextQuestionDto) => {
    setSession(dto.session)
    setProgress(dto.progress)
    setContentGap(dto.contentGap ?? null)
    setQuestions((prev) => {
      // The engine returns the same outstanding question if asked again; don't append a duplicate.
      const existing = prev.findIndex((q) => q.id === dto.question.id)
      if (existing !== -1) {
        setCurrent(existing)
        return prev
      }
      const q = mapQuestion(dto.question, prev.length)
      // These two appends are idempotent on purpose. React may invoke a state updater more than once for the
      // same update — StrictMode does it deliberately in development to surface updaters that are not pure —
      // and this one has to reach the sibling arrays, which are index-aligned with `questions`. Without the
      // identity checks a single served question would be appended twice, and the palette would show "2 of 15"
      // after one question, with two children under the same React key. The same guard also covers a doubled
      // "Next question" click in production.
      setItemIds((ids) => (ids.includes(dto.item.id) ? ids : [...ids, dto.item.id]))
      setAttempts((as) =>
        as.some((a) => a.questionId === q.id)
          ? as
          : [...as, { questionId: q.id, selectedKeys: [], flagged: false, visited: true, timeSpentSec: 0, submitted: false }],
      )
      setCurrent(prev.length)
      return [...prev, q]
    })
  }, [])

  const serveNext = useCallback(async (sessionId: string, o: { skip?: boolean } = {}) => {
    try {
      const dto = await http.get<NextQuestionDto>(`/v1/practice/sessions/${sessionId}/next`, o.skip ? { skip: true } : undefined)
      if (alive.current) absorb(dto)
    } catch (err) {
      if (!alive.current) return
      // The engine having nothing left to serve is a state the page shows, not a failure.
      if (err instanceof ApiError && err.code === 'NO_ELIGIBLE_QUESTIONS') setExhausted(true)
      else setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [absorb])

  // ---------------------------------------------------------------- starting

  /**
   * Which set this hook has already asked the backend to start.
   *
   * Creating a practice session is not a safe thing to do twice: each `POST` writes a real session row, and the
   * backend refuses the second one for the same sub-topic with `409`. React 18's StrictMode runs every effect
   * twice on mount in development, so without this guard opening a set fires two requests, one of them fails,
   * and whichever run happens to survive decides whether the learner sees a question or an error.
   *
   * A ref rather than state, because it must be read and written synchronously within one effect run, and it
   * must survive StrictMode's remount — which it does, being the same hook instance. A genuine remount (leaving
   * the page and coming back) creates a fresh hook, and therefore a fresh ref, so a new session is started as
   * it should be.
   */
  const startedKey = useRef<string | null>(null)

  useEffect(() => {
    if (!subTopicId) return
    const key = `${subTopicId}|${targetCount}|${attempt}`
    // The StrictMode double-invoke: the first run's request is already in flight and will set the state.
    if (startedKey.current === key) return
    startedKey.current = key

    setLoading(true)
    setError(null)
    setExhausted(false)
    setFinished(false)
    setQuestions([])
    setItemIds([])
    setAttempts([])
    setCurrent(0)
    setElapsed(0)
    ;(async () => {
      try {
        const start = await http.post<SessionStartDto>('/v1/practice/sessions', { subtopicId: subTopicId, targetQuestionCount: targetCount })
        // Superseded rather than cancelled: the guard is the key, so a response for a sub-topic the learner has
        // already navigated away from is dropped, while StrictMode's remount still receives this one.
        if (!alive.current || startedKey.current !== key) return
        setSession(start.session)
        setProgress(start.progress)
        await serveNext(start.session.id)
      } catch (err) {
        if (alive.current && startedKey.current === key) setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (alive.current && startedKey.current === key) setLoading(false)
      }
    })()
  }, [subTopicId, targetCount, serveNext, attempt])

  // ---------------------------------------------------------------- the clock

  useEffect(() => {
    if (finished || loading) return
    const id = setInterval(() => {
      setElapsed((e) => e + 1)
      setAttempts((prev) => prev.map((a, i) => (i === current && !a.submitted ? { ...a, timeSpentSec: a.timeSpentSec + 1 } : a)))
    }, 1000)
    return () => clearInterval(id)
  }, [current, finished, loading])

  // ---------------------------------------------------------------- focus events
  //
  // The backend records these to decide whether a long gap was thinking or a walk away, which is what keeps
  // `totalTimeMs` — and therefore the pace figures — honest. It refuses the whole feature (409) when the
  // organisation has focus tracking off or the learner has opted out, so a rejection is expected and ignored.

  useEffect(() => {
    const id = session?.id
    if (!id || !session?.focusTrackingEnabled) return
    const send = (eventType: SessionEventBody['eventType']) => {
      void http
        .post(`/v1/practice/sessions/${id}/events`, {
          events: [{ clientEventId: newUuid(), eventType, occurredAt: new Date().toISOString() }],
        })
        .catch(() => { /* disabled or opted out: nothing to do, and nothing to tell the learner */ })
    }
    const onVisibility = () => send(document.hidden ? 'visibility_hidden' : 'visibility_visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [session?.id, session?.focusTrackingEnabled])

  // ---------------------------------------------------------------- answering

  const patch = useCallback((i: number, p: Partial<AttemptState>) => {
    setAttempts((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...p } : a)))
  }, [])

  const select = useCallback((key: string) => {
    setAttempts((prev) =>
      prev.map((a, idx) => {
        if (idx !== current || a.submitted) return a
        const q = questions[idx]
        if (q?.type === 'multi_correct') {
          const has = a.selectedKeys.includes(key)
          return { ...a, selectedKeys: has ? a.selectedKeys.filter((k) => k !== key) : [...a.selectedKeys, key] }
        }
        return { ...a, selectedKeys: [key] }
      }),
    )
  }, [current, questions])

  const setValue = useCallback((value: string) => patch(current, { value }), [current, patch])
  const setText = useCallback((text: string) => patch(current, { text }), [current, patch])
  const toggleMatrix = useCallback((leftKey: string, rightKey: string) => {
    setAttempts((prev) =>
      prev.map((a, idx) => {
        if (idx !== current || a.submitted) return a
        const currentMatrix = a.matrix ?? {}
        const currentRights = currentMatrix[leftKey] ?? []
        const has = currentRights.includes(rightKey)
        const nextRights = has ? currentRights.filter((k) => k !== rightKey) : [...currentRights, rightKey]
        return {
          ...a,
          matrix: {
            ...currentMatrix,
            [leftKey]: nextRights,
          },
        }
      }),
    )
  }, [current])
  const clear = useCallback(
    () => patch(current, { selectedKeys: [], value: undefined, text: undefined, matrix: undefined }),
    [current, patch],
  )
  const toggleFlag = useCallback(() => setAttempts((p) => p.map((a, i) => (i === current ? { ...a, flagged: !a.flagged } : a))), [current])

  /**
   * Sends the answer and stores what the server said.
   *
   * The server's response is the only source of correctness, and also the first moment the answer key exists in
   * this browser — it arrives as `revealedAnswer` so the page can mark the options after the fact.
   */
  const submitCurrent = useCallback(async () => {
    const q = questions[current]
    const a = attempts[current]
    const itemId = itemIds[current]
    if (!q || !a || !itemId || a.submitted || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      const result = await http.post<AttemptResultDto>(
        '/v1/practice/attempts',
        {
          sessionItemId: itemId,
          response: responseBody(q, a),
          totalTimeMs: Math.max(1, a.timeSpentSec * 1000),
          clientSubmittedAt: new Date().toISOString(),
          hintCount: a.revealedHints?.length ?? 0,
        },
        { 'Idempotency-Key': newUuid() },
      )
      if (!alive.current) return
      patch(current, { submitted: true, outcome: toOutcome(result) })
      setProgress(result.progress)
      setSession(result.session)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (alive.current) setSubmitting(false)
    }
  }, [attempts, current, itemIds, patch, questions, submitting])

  const revealHint = useCallback(async () => {
    const q = questions[current]
    const a = attempts[current]
    const itemId = itemIds[current]
    if (!session || !q || !a || !itemId || a.submitted || revealingHint) return
    const currentHints = a.revealedHints ?? []
    const nextIndex = currentHints.length + 1
    if (nextIndex > q.hintCount) return

    setRevealingHint(true)
    setError(null)
    try {
      const result = await http.post<RevealedHintDto>(
        `/v1/practice/sessions/${session.id}/hints/reveal`,
        { sessionItemId: itemId, hintIndex: nextIndex },
      )
      if (!alive.current) return
      patch(current, { revealedHints: [...currentHints, result.hintText] })
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (alive.current) setRevealingHint(false)
    }
  }, [attempts, current, itemIds, patch, questions, revealingHint, session])

  // ---------------------------------------------------------------- navigation

  /** Moving among the questions already served. Forward past the last one is `next`'s job. */
  const go = useCallback((i: number) => {
    setCurrent((prev) => (i >= 0 && i < questions.length ? i : prev))
  }, [questions.length])

  const next = useCallback(async () => {
    if (current < questions.length - 1) {
      setCurrent(current + 1)
      return
    }
    if (!session || exhausted) return
    if (questions.length >= (session.targetQuestionCount ?? targetCount)) return
    // The engine will re-serve the outstanding question if it has not been answered, so an unanswered
    // question is skipped explicitly rather than silently returned again.
    const unanswered = attempts[current] && !attempts[current].submitted
    setSubmitting(true)
    try {
      await serveNext(session.id, { skip: unanswered })
    } finally {
      if (alive.current) setSubmitting(false)
    }
  }, [attempts, current, exhausted, questions.length, serveNext, session, targetCount])

  const finish = useCallback(async () => {
    const id = session?.id
    setFinished(true)
    if (!id) return
    try {
      const ended = await http.post<PracticeSessionDto>(`/v1/practice/sessions/${id}/end`, {})
      if (alive.current) setSession(ended)
    } catch {
      // Already ended, or expired: the learner is done either way.
    }
    // The learner's levels and accuracy have moved, so the cached analytics overlay is stale.
    invalidatePerformance()
  }, [session?.id])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  /**
   * Asks the engine for the next question again after new questions joined the pool (a fresh-practice request).
   * The engine still chooses; this only clears the "nothing left" state so the set can continue.
   */
  const refill = useCallback(async () => {
    if (!session) {
      setAttempt((n) => n + 1)
      return
    }
    setExhausted(false)
    setError(null)
    setSubmitting(true)
    try {
      await serveNext(session.id, { skip: Boolean(attempts[current] && !attempts[current].submitted) })
    } finally {
      if (alive.current) setSubmitting(false)
    }
  }, [attempts, current, serveNext, session])

  /**
   * The set's running figures, derived from what the **server** decided about each attempt.
   *
   * `accuracy` is null until something has been graded, which is the same rule the backend's analytics use: a
   * set with one ungraded long-form answer in it has no accuracy yet, and 0% would be a false statement.
   * There are no marks here: positive and negative marking is a test-mode concept the backend does not
   * implement, and inventing the numbers is exactly what this phase forbids.
   */
  const score = useMemo(() => {
    let correct = 0
    let incorrect = 0
    let graded = 0
    let answered = 0
    for (const a of attempts) {
      if (!a.submitted) continue
      answered += 1
      if (a.outcome?.correct === true) { correct += 1; graded += 1 }
      else if (a.outcome?.correct === false) { incorrect += 1; graded += 1 }
    }
    return {
      correct,
      incorrect,
      graded,
      answered,
      unattempted: Math.max(0, targetCount - answered),
      accuracy: graded === 0 ? null : Math.round((correct / graded) * 1000) / 10,
    }
  }, [attempts, targetCount])

  const state: PracticeSessionState = {
    current,
    attempts,
    elapsed,
    attempt: attempts[current],
    select,
    setValue,
    setText,
    toggleMatrix,
    clear,
    toggleFlag,
    submitCurrent,
    revealHint,
    revealingHint,
    go,
    next,
    score,
    questions,
    question: questions[current],
    session,
    progress,
    targetCount: session?.targetQuestionCount ?? targetCount,
    loading,
    submitting,
    error,
    exhausted,
    contentGap,
    finished,
    finish,
    retry,
    refill,
  }
  return state
}
