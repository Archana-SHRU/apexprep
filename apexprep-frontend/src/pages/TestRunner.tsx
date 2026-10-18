import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Flag,
  RotateCcw,
  Send,
  HelpCircle,
  Menu,
} from 'lucide-react'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/http'
import { useToast } from '@/hooks/useToast'
import { Button, Card, CardBody, Badge, Input, Dialog } from '@/components/ui'
import { OptionCard } from '@/components/OptionCard'
import { MatrixMatchCard } from '@/components/learning/MatrixMatchCard'
import { LongFormCard } from '@/components/learning/LongFormCard'
import { QUESTION_TYPE_LABELS } from '@/lib/answer'
import { cn, pad2 } from '@/lib/utils'
import type {
  TestSessionStateDto,
  TestSessionQuestionDto,
  TestItemStatus,
} from '@/types/api'

interface ItemState {
  response: Record<string, unknown> | null
  status: TestItemStatus
  timeSpentSec: number
}

export default function TestRunner() {
  const { testId } = useParams<{ testId: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionState, setSessionState] = useState<TestSessionStateDto | null>(null)

  const [activeSectionIndex, setActiveSectionIndex] = useState(0)
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0)
  const [itemsMap, setItemsMap] = useState<Record<string, ItemState>>({})
  const [remainingSec, setRemainingSec] = useState<number>(0)
  const [submitting, setSubmitting] = useState(false)
  const [confirmModalOpen, setConfirmModalOpen] = useState(false)
  const [paletteDrawerOpen, setPaletteDrawerOpen] = useState(false)

  const lastSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The deadline as a point on this page's own monotonic clock (`performance.now()`), set from the server's
   * `remainingSeconds` and re-set whenever the server tells us the time left again. It is only a display: the
   * server decides when the test is over, so nothing done to this clock — a throttled background tab, a changed
   * system time — changes what is accepted or graded.
   */
  const deadlineRef = useRef<number>(0)
  /** One start per test per page visit. React's development double-mount would otherwise start twice. */
  const startRef = useRef<{ testId: string; promise: Promise<TestSessionStateDto> } | null>(null)
  /** Set once the test is over, so a late timer tick or a failed save cannot submit twice. */
  const finishedRef = useRef(false)

  const syncClock = useCallback((remainingSeconds: number) => {
    deadlineRef.current = performance.now() + remainingSeconds * 1000
    setRemainingSec(Math.max(0, remainingSeconds))
  }, [])

  const goToResult = useCallback(
    (sessionId: string) => {
      if (finishedRef.current) return
      finishedRef.current = true
      navigate(`/tests/${testId}/result?sessionId=${sessionId}`, { replace: true })
    },
    [navigate, testId],
  )

  /** True when a failed call means the test is already over, in which case the learner is taken to the result. */
  const handleClosed = useCallback(
    (err: unknown, sessionId: string): boolean => {
      if (err instanceof ApiError && (err.code === 'TIME_EXPIRED' || err.code === 'SESSION_CLOSED')) {
        toast({ title: 'Test finished', description: 'Time is up or the test was already submitted. Showing your result.', tone: 'info' })
        goToResult(sessionId)
        return true
      }
      return false
    },
    [goToResult, toast],
  )

  // Load or resume the test session
  useEffect(() => {
    if (!testId) return
    let isMounted = true
    finishedRef.current = false

    async function initTest() {
      setLoading(true)
      setError(null)
      try {
        const existing = startRef.current
        const pending = existing && existing.testId === testId ? existing : { testId: testId!, promise: api.startMockTest(testId!) }
        startRef.current = pending
        const session = await pending.promise
        if (!isMounted) return

        setSessionState(session)
        syncClock(session.remainingSeconds)

        // Initialize state for each test item
        const initialMap: Record<string, ItemState> = {}
        session.sections.forEach((sec) => {
          sec.questions.forEach((q) => {
            initialMap[q.testItemId] = {
              response: q.currentResponse,
              status: q.status,
              timeSpentSec: q.timeSpentSec,
            }
          })
        })
        setItemsMap(initialMap)

        // Resume on the question the student last had open; otherwise begin at the first.
        let startSection = 0
        let startQuestion = 0
        if (session.activeTestItemId) {
          session.sections.forEach((sec, si) =>
            sec.questions.forEach((q, qi) => {
              if (q.testItemId === session.activeTestItemId) {
                startSection = si
                startQuestion = qi
              }
            }),
          )
        }
        setActiveSectionIndex(startSection)
        setActiveQuestionIndex(startQuestion)
        const first = session.sections[startSection]?.questions[startQuestion]
        if (first) {
          void api
            .focusMockTestItem(session.sessionId, first.testItemId)
            .then((clock) => isMounted && syncClock(clock.remainingSeconds))
            .catch((err: unknown) => handleClosed(err, session.sessionId))
        }
      } catch (err) {
        if (!isMounted) return
        // The time ran out while the student was away: the server closed and graded the paper, so show that.
        if (err instanceof ApiError && err.code === 'SESSION_EXPIRED') {
          const sessionId = err.details.find((d) => d.field === 'sessionId')?.message
          if (sessionId) {
            toast({ title: 'Time was up', description: 'This test ended while you were away. Showing your result.', tone: 'info' })
            goToResult(sessionId)
            return
          }
        }
        // A failed start must be retryable by remounting, not remembered.
        startRef.current = null
        setError(err instanceof Error ? err.message : 'Failed to launch test session')
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    void initTest()
    return () => {
      isMounted = false
    }
  }, [testId, syncClock, goToResult, handleClosed, toast])

  // Countdown display. Read from the monotonic clock rather than counting ticks, so a throttled tab catches up.
  useEffect(() => {
    if (!sessionState || finishedRef.current) return

    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - performance.now()) / 1000))
      setRemainingSec(left)
      if (left <= 0) {
        clearInterval(timer)
        // The display, kept in step with the server's own `remainingSeconds`, reached zero: submit. The server
        // closes the paper at its deadline whether or not this runs, and refuses answers after it.
        void handleSubmitTest(true)
      }
    }, 500)

    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState])

  const currentSection = sessionState?.sections[activeSectionIndex]
  const currentQuestionItem = currentSection?.questions[activeQuestionIndex]
  const currentItemState = currentQuestionItem ? itemsMap[currentQuestionItem.testItemId] : undefined

  // Save current question response to server
  const saveAnswer = useCallback(
    async (testItemId: string, response: Record<string, unknown> | null, status: TestItemStatus) => {
      if (!sessionState) return
      try {
        const clock = await api.saveMockTestAnswer(sessionState.sessionId, { testItemId, response, status })
        syncClock(clock.remainingSeconds)
      } catch (err) {
        // A background save that fails is retried by the next change. The one failure that matters is "the test
        // is over", which must not be swallowed: the answer was not stored and the learner has to know.
        handleClosed(err, sessionState.sessionId)
      }
    },
    [sessionState, syncClock, handleClosed],
  )

  // Navigation handlers
  const navigateToQuestion = (secIdx: number, qIdx: number) => {
    setActiveSectionIndex(secIdx)
    setActiveQuestionIndex(qIdx)
    setPaletteDrawerOpen(false)

    const targetSec = sessionState?.sections[secIdx]
    const targetQ = targetSec?.questions[qIdx]
    if (targetQ && sessionState) {
      // The server adds up how long the previous question was open and marks this one visited. The browser
      // reports no duration, and nothing is lost if this particular call fails: the next one still measures
      // from the last successful pointer.
      void api
        .focusMockTestItem(sessionState.sessionId, targetQ.testItemId)
        .then((clock) => syncClock(clock.remainingSeconds))
        .catch((err: unknown) => handleClosed(err, sessionState.sessionId))

      const state = itemsMap[targetQ.testItemId]
      if (state && state.status === 'not_visited') {
        const newStatus: TestItemStatus = state.response ? 'answered' : 'not_answered'
        setItemsMap((prev) => ({
          ...prev,
          [targetQ.testItemId]: { ...state, status: newStatus },
        }))
      }
    }
  }

  // Answer selection handlers
  const handleOptionSelect = (optionKey: string) => {
    if (!currentQuestionItem) return
    const id = currentQuestionItem.testItemId
    const qType = currentQuestionItem.question.type

    let newResponse: Record<string, unknown> | null = null

    if (qType === 'multi_correct') {
      const prevKeys = ((itemsMap[id]?.response?.optionKeys as string[]) || []).slice()
      const idx = prevKeys.indexOf(optionKey)
      if (idx > -1) {
        prevKeys.splice(idx, 1)
      } else {
        prevKeys.push(optionKey)
      }
      newResponse = prevKeys.length > 0 ? { optionKeys: prevKeys } : null
    } else {
      newResponse = { optionKeys: [optionKey] }
    }

    const prevStatus = itemsMap[id]?.status || 'not_visited'
    const newStatus: TestItemStatus = newResponse
      ? prevStatus === 'marked_for_review' || prevStatus === 'answered_and_marked'
        ? 'answered_and_marked'
        : 'answered'
      : prevStatus === 'answered_and_marked'
        ? 'marked_for_review'
        : 'not_answered'

    setItemsMap((prev) => ({
      ...prev,
      [id]: {
        response: newResponse,
        status: newStatus,
        timeSpentSec: prev[id]?.timeSpentSec ?? 0,
      },
    }))

    // Debounced autosave
    if (lastSaveTimerRef.current) clearTimeout(lastSaveTimerRef.current)
    lastSaveTimerRef.current = setTimeout(() => {
      void saveAnswer(id, newResponse, newStatus)
    }, 400)
  }

  const handleNumericChange = (val: string) => {
    if (!currentQuestionItem) return
    const id = currentQuestionItem.testItemId
    const trimmed = val.trim()
    const newResponse = trimmed !== '' ? { value: trimmed } : null

    const prevStatus = itemsMap[id]?.status || 'not_visited'
    const newStatus: TestItemStatus = newResponse
      ? prevStatus === 'marked_for_review' || prevStatus === 'answered_and_marked'
        ? 'answered_and_marked'
        : 'answered'
      : prevStatus === 'answered_and_marked'
        ? 'marked_for_review'
        : 'not_answered'

    setItemsMap((prev) => ({
      ...prev,
      [id]: {
        response: newResponse,
        status: newStatus,
        timeSpentSec: prev[id]?.timeSpentSec ?? 0,
      },
    }))

    if (lastSaveTimerRef.current) clearTimeout(lastSaveTimerRef.current)
    lastSaveTimerRef.current = setTimeout(() => {
      void saveAnswer(id, newResponse, newStatus)
    }, 400)
  }

  const handleMatrixToggle = (leftKey: string, rightKey: string) => {
    if (!currentQuestionItem) return
    const id = currentQuestionItem.testItemId
    const prevMatrix = ((itemsMap[id]?.response?.matrix as Record<string, string[]>) || {})
    const copy: Record<string, string[]> = { ...prevMatrix }

    const rights = (copy[leftKey] || []).slice()
    const idx = rights.indexOf(rightKey)
    if (idx > -1) {
      rights.splice(idx, 1)
      if (rights.length === 0) delete copy[leftKey]
      else copy[leftKey] = rights
    } else {
      rights.push(rightKey)
      copy[leftKey] = rights
    }

    const hasAny = Object.keys(copy).length > 0
    const newResponse = hasAny ? { matrix: copy } : null

    const prevStatus = itemsMap[id]?.status || 'not_visited'
    const newStatus: TestItemStatus = newResponse
      ? prevStatus === 'marked_for_review' || prevStatus === 'answered_and_marked'
        ? 'answered_and_marked'
        : 'answered'
      : prevStatus === 'answered_and_marked'
        ? 'marked_for_review'
        : 'not_answered'

    setItemsMap((prev) => ({
      ...prev,
      [id]: {
        response: newResponse,
        status: newStatus,
        timeSpentSec: prev[id]?.timeSpentSec ?? 0,
      },
    }))

    if (lastSaveTimerRef.current) clearTimeout(lastSaveTimerRef.current)
    lastSaveTimerRef.current = setTimeout(() => {
      void saveAnswer(id, newResponse, newStatus)
    }, 400)
  }

  const handleLongFormChange = (textVal: string) => {
    if (!currentQuestionItem) return
    const id = currentQuestionItem.testItemId
    const trimmed = textVal.trim()
    const newResponse = trimmed !== '' ? { text: textVal } : null

    const prevStatus = itemsMap[id]?.status || 'not_visited'
    const newStatus: TestItemStatus = newResponse
      ? prevStatus === 'marked_for_review' || prevStatus === 'answered_and_marked'
        ? 'answered_and_marked'
        : 'answered'
      : prevStatus === 'answered_and_marked'
        ? 'marked_for_review'
        : 'not_answered'

    setItemsMap((prev) => ({
      ...prev,
      [id]: {
        response: newResponse,
        status: newStatus,
        timeSpentSec: prev[id]?.timeSpentSec ?? 0,
      },
    }))

    if (lastSaveTimerRef.current) clearTimeout(lastSaveTimerRef.current)
    lastSaveTimerRef.current = setTimeout(() => {
      void saveAnswer(id, newResponse, newStatus)
    }, 400)
  }

  // Clear answer
  const handleClearResponse = () => {
    if (!currentQuestionItem) return
    const id = currentQuestionItem.testItemId
    const newStatus: TestItemStatus = 'not_answered'

    setItemsMap((prev) => ({
      ...prev,
      [id]: {
        response: null,
        status: newStatus,
        timeSpentSec: prev[id]?.timeSpentSec ?? 0,
      },
    }))
    void saveAnswer(id, null, newStatus)
  }

  // Mark for review & next
  const handleMarkForReviewAndNext = () => {
    if (!currentQuestionItem) return
    const id = currentQuestionItem.testItemId
    const currentResp = itemsMap[id]?.response || null
    const newStatus: TestItemStatus = currentResp ? 'answered_and_marked' : 'marked_for_review'

    setItemsMap((prev) => ({
      ...prev,
      [id]: {
        response: currentResp,
        status: newStatus,
        timeSpentSec: prev[id]?.timeSpentSec ?? 0,
      },
    }))
    void saveAnswer(id, currentResp, newStatus)
    handleNext()
  }

  // Next / Previous navigation
  const handleNext = () => {
    if (!currentSection) return
    if (activeQuestionIndex < currentSection.questions.length - 1) {
      navigateToQuestion(activeSectionIndex, activeQuestionIndex + 1)
    } else if (activeSectionIndex < (sessionState?.sections.length || 0) - 1) {
      // Advance to next section
      navigateToQuestion(activeSectionIndex + 1, 0)
    }
  }

  const handlePrevious = () => {
    if (activeQuestionIndex > 0) {
      navigateToQuestion(activeSectionIndex, activeQuestionIndex - 1)
    } else if (activeSectionIndex > 0) {
      const prevSec = sessionState?.sections[activeSectionIndex - 1]
      if (prevSec) {
        navigateToQuestion(activeSectionIndex - 1, prevSec.questions.length - 1)
      }
    }
  }

  // Submit test
  const handleSubmitTest = async (auto = false) => {
    if (!sessionState || submitting || finishedRef.current) return
    setSubmitting(true)

    try {
      if (auto) {
        toast({ title: 'Time Expired', description: 'Your exam time has ended. Auto-submitting responses.', tone: 'info' })
      }
      // The server adds up the time on the question that is open at this moment as part of closing the paper.
      await api.submitMockTest(sessionState.sessionId)
      goToResult(sessionState.sessionId)
    } catch (err) {
      toast({
        title: 'Submission Failed',
        description: err instanceof Error ? err.message : 'Could not submit test',
        tone: 'error',
      })
      setSubmitting(false)
      setConfirmModalOpen(false)
    }
  }

  // Overall question statistics for Palette & Dialog
  const stats = useMemo(() => {
    let answered = 0
    let notAnswered = 0
    let marked = 0
    let answeredMarked = 0
    let notVisited = 0
    let total = 0

    if (sessionState) {
      sessionState.sections.forEach((sec) => {
        sec.questions.forEach((q) => {
          total++
          const st = itemsMap[q.testItemId]?.status || 'not_visited'
          if (st === 'answered') answered++
          else if (st === 'not_answered') notAnswered++
          else if (st === 'marked_for_review') marked++
          else if (st === 'answered_and_marked') answeredMarked++
          else notVisited++
        })
      })
    }

    return { total, answered, notAnswered, marked, answeredMarked, notVisited }
  }, [sessionState, itemsMap])

  // Timer format (HH:MM:SS)
  const formattedTimer = useMemo(() => {
    const hours = Math.floor(remainingSec / 3600)
    const minutes = Math.floor((remainingSec % 3600) / 60)
    const seconds = remainingSec % 60

    if (hours > 0) {
      return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    }
    return `${pad2(minutes)}:${pad2(seconds)}`
  }, [remainingSec])

  const timerWarning = remainingSec < 300 // less than 5 minutes

  if (loading) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center space-y-4">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="font-mono text-body-sm text-ink-soft">Loading test session…</p>
      </div>
    )
  }

  if (error || !sessionState) {
    return (
      <div className="mx-auto max-w-lg pt-12">
        <Card className="border-deficit/30 bg-deficit/5">
          <CardBody className="space-y-4 text-center">
            <AlertTriangle className="mx-auto h-12 w-12 text-deficit" />
            <h3 className="text-headline-sm font-semibold text-deficit">Could not start test</h3>
            <p className="text-body-sm text-ink-soft">{error || 'Test session not found'}</p>
            <div className="flex justify-center gap-3 pt-2">
              <Button variant="secondary" onClick={() => navigate('/tests')}>
                Back to Mock Tests
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    )
  }

  if (!currentQuestionItem) {
    return null
  }

  const q = currentQuestionItem.question
  const selectedKeys = (currentItemState?.response?.optionKeys as string[]) || []
  const textValue = (currentItemState?.response?.value as string) || ''
  const matrixValue = (currentItemState?.response?.matrix as Record<string, string[]>) || {}
  const longFormValue = (currentItemState?.response?.text as string) || ''

  return (
    <div className="flex flex-col space-y-4">
      {/* Top Header Exam Bar */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-canvas/95 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPaletteDrawerOpen(true)}
            className="lg:hidden p-1.5"
            aria-label="Toggle Question Palette"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-body-lg font-bold text-ink leading-tight">{sessionState.testTitle}</h1>
            <span className="font-mono text-label-xs text-ink-muted">
              {sessionState.kind === 'full_length' ? 'Full Length Simulation' : 'Sectional Drill'} ·{' '}
              {sessionState.totalMarks} Marks
            </span>
          </div>
        </div>

        {/* Section tabs */}
        <div className="hidden md:flex items-center gap-1.5 rounded-lg border border-line bg-deck p-1">
          {sessionState.sections.map((sec, idx) => (
            <button
              key={sec.id}
              onClick={() => navigateToQuestion(idx, 0)}
              className={cn(
                'rounded px-3 py-1 font-mono text-label-xs font-medium transition-colors',
                activeSectionIndex === idx
                  ? 'bg-canvas text-primary shadow-xs border border-line/60 font-semibold'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {sec.name} ({sec.questions.length})
            </button>
          ))}
        </div>

        {/* Timer & Submit Action */}
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-body-sm font-semibold transition-colors',
              timerWarning
                ? 'border-deficit bg-deficit/10 text-deficit animate-pulse'
                : 'border-line bg-deck text-ink',
            )}
          >
            <Clock className={cn('h-4 w-4', timerWarning ? 'text-deficit' : 'text-primary')} />
            <span>{formattedTimer}</span>
          </div>

          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmModalOpen(true)}
            className="gap-1.5"
          >
            <Send className="h-3.5 w-3.5" /> Submit Test
          </Button>
        </div>
      </div>

      {/* Mobile Section Tabs */}
      <div className="flex md:hidden overflow-x-auto gap-1 border-b border-line pb-2">
        {sessionState.sections.map((sec, idx) => (
          <button
            key={sec.id}
            onClick={() => navigateToQuestion(idx, 0)}
            className={cn(
              'shrink-0 rounded px-2.5 py-1 font-mono text-label-xs',
              activeSectionIndex === idx ? 'bg-primary text-white font-medium' : 'bg-deck text-ink-muted',
            )}
          >
            {sec.name}
          </button>
        ))}
      </div>

      {/* Main Runner Layout */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Left Column: Question Screen */}
        <div className="space-y-4">
          {/* Question Metadata Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-body-md font-bold text-primary">
                Q.{activeQuestionIndex + 1}
              </span>
              <span className="text-label-sm font-mono text-ink-muted">
                of {currentSection?.questions.length}
              </span>
              <Badge className="font-mono text-label-xs border border-line">
                {QUESTION_TYPE_LABELS[q.type]}
              </Badge>
            </div>

            <div className="flex items-center gap-2 font-mono text-label-xs">
              <span className="rounded bg-mastery/10 px-2 py-0.5 font-medium text-mastery">
                +{currentQuestionItem.positiveMarks}.00
              </span>
              <span className="rounded bg-deficit/10 px-2 py-0.5 font-medium text-deficit">
                −{currentQuestionItem.negativeMarks}.00
              </span>
            </div>
          </div>

          {/* Question Card */}
          <Card className="border-line shadow-xs">
            <CardBody className="space-y-6">
              <div className="prose max-w-none text-body-lg text-ink font-normal leading-relaxed whitespace-pre-wrap">
                {q.stem}
              </div>

              {/* Input rendering based on type */}
              {q.options && q.options.length > 0 ? (
                <div className="space-y-2.5 pt-2">
                  {q.options.map((opt) => (
                    <OptionCard
                      key={opt.key}
                      option={opt}
                      selected={selectedKeys.includes(opt.key)}
                      onSelect={() => handleOptionSelect(opt.key)}
                    />
                  ))}
                  {q.type === 'multi_correct' && (
                    <p className="font-mono text-label-xs text-ink-muted">
                      One or more options may be correct. Select all that apply.
                    </p>
                  )}
                </div>
              ) : q.type === 'integer' || q.type === 'numeric' ? (
                <div className="max-w-xs space-y-1.5 pt-2">
                  <label htmlFor="numeric-input" className="font-mono text-label-xs uppercase text-ink-muted">
                    Your {q.type === 'integer' ? 'Integer' : 'Numeric'} Answer:
                  </label>
                  <Input
                    id="numeric-input"
                    className="font-mono text-right text-body-md font-semibold"
                    placeholder={q.type === 'integer' ? '0' : '0.00'}
                    value={textValue}
                    onChange={(e) => handleNumericChange(e.target.value)}
                  />
                </div>
              ) : q.type === 'matrix_match' ? (
                <div className="pt-2">
                  <MatrixMatchCard
                    question={q as any}
                    selected={matrixValue}
                    submitted={false}
                    onToggle={(l, r) => handleMatrixToggle(l, r)}
                  />
                </div>
              ) : q.type === 'long_form' ? (
                <div className="pt-2">
                  <LongFormCard
                    text={longFormValue}
                    submitted={false}
                    onChange={(val) => handleLongFormChange(val)}
                  />
                </div>
              ) : null}
            </CardBody>
          </Card>

          {/* Action Bar */}
          <div className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-2 border border-line bg-canvas p-3 shadow-md sm:rounded-lg">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleMarkForReviewAndNext}
                className="gap-1.5"
              >
                <Flag className="h-3.5 w-3.5 text-tier-l5" /> Mark for Review & Next
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearResponse}
                disabled={!currentItemState?.response}
                className="text-ink-muted hover:text-deficit gap-1"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Clear Response
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePrevious}
                disabled={activeSectionIndex === 0 && activeQuestionIndex === 0}
                className="gap-1"
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
              <Button size="sm" onClick={handleNext} className="gap-1">
                Save & Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Right Column: Question Palette Sidebar */}
        <aside className="hidden lg:block space-y-4">
          <QuestionPalettePanel
            section={currentSection!}
            activeQuestionIndex={activeQuestionIndex}
            itemsMap={itemsMap}
            onSelectQuestion={(idx) => navigateToQuestion(activeSectionIndex, idx)}
            stats={stats}
          />
        </aside>
      </div>

      {/* Mobile Question Palette Drawer */}
      {paletteDrawerOpen && (
        <div className="fixed inset-0 z-50 flex bg-ink/50 lg:hidden">
          <div className="ml-auto h-full w-80 overflow-y-auto bg-canvas p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between border-b border-line pb-2">
              <h3 className="font-mono text-body-md font-bold uppercase text-ink">Question Palette</h3>
              <Button size="sm" variant="ghost" onClick={() => setPaletteDrawerOpen(false)}>
                Close
              </Button>
            </div>
            <QuestionPalettePanel
              section={currentSection!}
              activeQuestionIndex={activeQuestionIndex}
              itemsMap={itemsMap}
              onSelectQuestion={(idx) => navigateToQuestion(activeSectionIndex, idx)}
              stats={stats}
            />
          </div>
        </div>
      )}

      {/* Confirmation Dialog on Submit */}
      <Dialog
        open={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title="Submit Examination Paper?"
        description="Are you sure you want to finish and submit your exam? Once submitted, your answers will be graded immediately."
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirmModalOpen(false)} disabled={submitting}>
              Keep Practicing
            </Button>
            <Button variant="destructive" onClick={() => void handleSubmitTest(false)} disabled={submitting}>
              {submitting ? 'Grading Answers…' : 'Yes, Confirm & Submit'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-2 text-center font-mono text-label-xs">
            <div className="rounded bg-mastery/10 p-3 text-mastery">
              <div className="text-headline-sm font-bold">{stats.answered + stats.answeredMarked}</div>
              <div className="mt-0.5">Answered</div>
            </div>
            <div className="rounded bg-deficit/10 p-3 text-deficit">
              <div className="text-headline-sm font-bold">{stats.notAnswered + stats.notVisited}</div>
              <div className="mt-0.5">Unanswered</div>
            </div>
            <div className="rounded bg-tier-l5/10 p-3 text-tier-l5">
              <div className="text-headline-sm font-bold">{stats.marked + stats.answeredMarked}</div>
              <div className="mt-0.5">Marked for Review</div>
            </div>
            <div className="rounded bg-deck p-3 text-ink">
              <div className="text-headline-sm font-bold">{stats.total}</div>
              <div className="mt-0.5">Total Questions</div>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function QuestionPalettePanel({
  section,
  activeQuestionIndex,
  itemsMap,
  onSelectQuestion,
  stats,
}: {
  section: TestSessionStateDto['sections'][number]
  activeQuestionIndex: number
  itemsMap: Record<string, ItemState>
  onSelectQuestion: (idx: number) => void
  stats: { answered: number; notAnswered: number; marked: number; answeredMarked: number; notVisited: number }
}) {
  return (
    <Card className="border-line">
      <CardBody className="space-y-4 p-4">
        <div className="border-b border-line pb-2">
          <h3 className="font-mono text-label-sm font-bold uppercase tracking-wider text-ink">
            {section.name} Palette
          </h3>
          <span className="font-mono text-label-xs text-ink-muted">
            {section.questions.length} questions in this section
          </span>
        </div>

        {/* Legend */}
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 font-mono text-label-xs text-ink-muted">
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#10B981]" /> Answered ({stats.answered})
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#EF4444]" /> Not Answered ({stats.notAnswered})
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#8B5CF6]" /> Marked ({stats.marked})
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#CBD5E1]" /> Not Visited ({stats.notVisited})
          </div>
        </div>

        {/* Question Numbers Grid */}
        <div className="max-h-72 overflow-y-auto pt-2">
          <div className="grid grid-cols-5 gap-2">
            {section.questions.map((q, idx) => {
              const item = itemsMap[q.testItemId]
              const st = item?.status || 'not_visited'
              const isCurrent = idx === activeQuestionIndex

              let bgClass = 'bg-[#E2E8F0] text-ink-muted' // not_visited
              if (st === 'answered') {
                bgClass = 'bg-[#10B981] text-white font-medium'
              } else if (st === 'not_answered') {
                bgClass = 'bg-[#EF4444] text-white font-medium'
              } else if (st === 'marked_for_review') {
                bgClass = 'bg-[#8B5CF6] text-white font-medium'
              } else if (st === 'answered_and_marked') {
                bgClass = 'bg-[#8B5CF6] text-white font-medium relative'
              }

              return (
                <button
                  key={q.testItemId}
                  onClick={() => onSelectQuestion(idx)}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded font-mono text-label-sm transition-all',
                    bgClass,
                    isCurrent && 'ring-2 ring-primary ring-offset-2 scale-105 font-bold',
                  )}
                  title={`Question ${idx + 1}: ${st.replace(/_/g, ' ')}`}
                >
                  {pad2(idx + 1)}
                  {st === 'answered_and_marked' && (
                    <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-[#10B981]" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
