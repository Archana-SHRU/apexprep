import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Filter,
  Layers,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Badge, Button, Card, CardBody, Dialog, Input, Table, TableWrap, Td, Th } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { adminApi, type ListQuestionsParams } from '@/lib/admin'
import { adminContent, type AdminTrack, type TrackTree } from '@/lib/admin-content'
import { cn } from '@/lib/utils'
import type {
  AdminQuestionDto,
  AdminQuestionSummaryDto,
  QuestionType,
} from '@/types/api'

const QUESTION_TYPE_LABELS: Record<string, string> = {
  single_correct: 'Single Choice',
  multi_correct: 'Multiple Choice',
  integer: 'Integer',
  numeric: 'Numeric',
  assertion_reason: 'Assertion-Reason',
  matrix_match: 'Matrix Match',
  long_form: 'Long Form',
}

const DIFFICULTY_LABELS: Record<number, { label: string; bg: string; text: string }> = {
  1: { label: 'L1 · Very Easy', bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  2: { label: 'L2 · Easy', bg: 'bg-teal-50 border-teal-200', text: 'text-teal-700' },
  3: { label: 'L3 · Moderate', bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  4: { label: 'L4 · Hard', bg: 'bg-orange-50 border-orange-200', text: 'text-orange-700' },
  5: { label: 'L5 · Very Hard', bg: 'bg-rose-50 border-rose-200', text: 'text-rose-700' },
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'border-amber-300 bg-amber-50 text-amber-800' },
  published: { label: 'Published', className: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  retired: { label: 'Retired', className: 'border-slate-300 bg-slate-100 text-slate-700' },
}

const SELECT_CLASS =
  'h-9 rounded border border-line bg-canvas px-2.5 py-1 text-body-sm text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent'

export default function QuestionBank() {
  const { toast } = useToast()

  // Syllabus filters data
  const [tracks, setTracks] = useState<AdminTrack[]>([])
  const [tree, setTree] = useState<TrackTree | null>(null)

  // Filter state
  const [trackId, setTrackId] = useState<string>('')
  const [subjectId, setSubjectId] = useState<string>('')
  const [difficulty, setDifficulty] = useState<string>('')
  const [type, setType] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [debouncedSearch, setDebouncedSearch] = useState<string>('')

  // Pagination state
  const [page, setPage] = useState<number>(1)
  const pageSize = 15

  // List data state
  const [questions, setQuestions] = useState<AdminQuestionSummaryDto[]>([])
  const [total, setTotal] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Detail modal state
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AdminQuestionDto | null>(null)
  const [detailLoading, setDetailLoading] = useState<boolean>(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  // Load tracks once
  useEffect(() => {
    adminContent
      .tracks()
      .then((t) => setTracks(t))
      .catch(() => {
        /* Ignore tracks load error */
      })
  }, [])

  // Load tree when track changes
  useEffect(() => {
    if (trackId) {
      adminContent
        .tree(trackId)
        .then((t) => setTree(t))
        .catch(() => setTree(null))
    } else {
      setTree(null)
      setSubjectId('')
    }
  }, [trackId])

  // Debounce search input
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(handle)
  }, [search])

  // Fetch questions. Only the newest request may write the table: typing in the search box fires several.
  const latestRequest = useRef(0)
  const fetchQuestions = async () => {
    const request = ++latestRequest.current
    setLoading(true)
    setError(null)
    try {
      const params: ListQuestionsParams = {
        page,
        pageSize,
        ...(trackId ? { trackId } : {}),
        ...(subjectId ? { subjectId } : {}),
        ...(difficulty ? { difficultyLabel: Number(difficulty) } : {}),
        ...(type ? { type: type as QuestionType } : {}),
        ...(status ? { status } : {}),
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      }
      const data = await adminApi.getQuestions(params)
      if (request !== latestRequest.current) return
      setQuestions(data.items)
      // The numbered-page response carries the total; without one, say what is known rather than showing NaN.
      setTotal(data.total ?? (page - 1) * pageSize + data.items.length)
    } catch (err) {
      if (request !== latestRequest.current) return
      setError(errorMessage(err instanceof Error ? err : null))
    } finally {
      if (request === latestRequest.current) setLoading(false)
    }
  }

  useEffect(() => {
    void fetchQuestions()
  }, [page, trackId, subjectId, difficulty, type, status, debouncedSearch])

  // Fetch question detail
  const loadDetail = async (id: string) => {
    setSelectedQuestionId(id)
    setDetail(null)
    setDetailLoading(true)
    setDetailError(null)
    try {
      const q = await adminApi.getQuestion(id)
      setDetail(q)
    } catch (err) {
      setDetailError(errorMessage(err instanceof Error ? err : null))
    } finally {
      setDetailLoading(false)
    }
  }

  // Handle Question Actions (Publish / Retire / Delete)
  const handlePublish = async (id: string) => {
    setActionInProgress('publish')
    try {
      const updated = await adminApi.publishQuestion(id)
      setDetail(updated)
      toast({ tone: 'success', title: 'Question published', description: 'This question can now be served in practice sessions.' })
      void fetchQuestions()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not publish question', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setActionInProgress(null)
    }
  }

  const handleRetire = async (id: string) => {
    setActionInProgress('retire')
    try {
      const updated = await adminApi.retireQuestion(id)
      setDetail(updated)
      toast({ tone: 'success', title: 'Question retired', description: 'Question retired; historical attempts remain preserved.' })
      void fetchQuestions()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not retire question', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setActionInProgress(null)
    }
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to permanently delete this question?')) return
    setActionInProgress('delete')
    try {
      await adminApi.deleteQuestion(id)
      toast({ tone: 'success', title: 'Question deleted' })
      setSelectedQuestionId(null)
      void fetchQuestions()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not delete question', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setActionInProgress(null)
    }
  }

  const resetFilters = () => {
    setTrackId('')
    setSubjectId('')
    setDifficulty('')
    setType('')
    setStatus('')
    setSearch('')
    setPage(1)
  }

  const hasActiveFilters = Boolean(trackId || subjectId || difficulty || type || status || debouncedSearch)
  const totalPages = Math.ceil(total / pageSize) || 1
  const subjectsList = tree?.subjects ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Question Bank"
        subtitle="Manage authored questions, taxonomy bindings, answer keys, and publication lifecycle."
        actions={
          <div className="flex items-center gap-2">
            <span className="font-mono text-label-sm text-ink-muted">
              {total} {total === 1 ? 'question' : 'questions'} total
            </span>
          </div>
        }
      />

      {/* Filter Bar */}
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Search Input */}
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
              <Input
                placeholder="Search question stem or ID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-8"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Track Filter */}
            <select
              aria-label="Filter by track"
              value={trackId}
              onChange={(e) => {
                setTrackId(e.target.value)
                setSubjectId('')
                setPage(1)
              }}
              className={SELECT_CLASS}
            >
              <option value="">All Tracks</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            {/* Subject Filter (active when track selected) */}
            <select
              aria-label="Filter by subject"
              value={subjectId}
              disabled={!trackId || subjectsList.length === 0}
              onChange={(e) => {
                setSubjectId(e.target.value)
                setPage(1)
              }}
              className={cn(SELECT_CLASS, !trackId && 'cursor-not-allowed opacity-60')}
            >
              <option value="">All Subjects</option>
              {subjectsList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            {/* Difficulty Filter */}
            <select
              aria-label="Filter by difficulty"
              value={difficulty}
              onChange={(e) => {
                setDifficulty(e.target.value)
                setPage(1)
              }}
              className={SELECT_CLASS}
            >
              <option value="">All Difficulties</option>
              <option value="1">L1 · Very Easy</option>
              <option value="2">L2 · Easy</option>
              <option value="3">L3 · Moderate</option>
              <option value="4">L4 · Hard</option>
              <option value="5">L5 · Very Hard</option>
            </select>

            {/* Question Type Filter */}
            <select
              aria-label="Filter by question type"
              value={type}
              onChange={(e) => {
                setType(e.target.value)
                setPage(1)
              }}
              className={SELECT_CLASS}
            >
              <option value="">All Question Types</option>
              <option value="single_correct">Single Choice</option>
              <option value="multi_correct">Multiple Choice</option>
              <option value="integer">Integer</option>
              <option value="numeric">Numeric</option>
              <option value="assertion_reason">Assertion-Reason</option>
              <option value="matrix_match">Matrix Match</option>
              <option value="long_form">Long Form</option>
            </select>

            {/* Status Filter */}
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
              className={SELECT_CLASS}
            >
              <option value="">All Statuses</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="retired">Retired</option>
            </select>

            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={resetFilters} className="text-ink-muted hover:text-ink">
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Reset
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Main Content Area */}
      {loading ? (
        <Card>
          <CardBody className="py-12">
            <PageSkeleton />
          </CardBody>
        </Card>
      ) : error ? (
        <EmptyState
          icon={TriangleAlert}
          title="Could not load question bank"
          description={error}
          actionLabel="Try again"
          onAction={fetchQuestions}
        />
      ) : questions.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No questions found"
          description={
            hasActiveFilters
              ? 'No questions match the selected filters. Try clearing or relaxing some criteria.'
              : 'The question bank is currently empty. Upload content or publish extracted questions from the review queue.'
          }
          actionLabel={hasActiveFilters ? 'Clear filters' : undefined}
          onAction={hasActiveFilters ? resetFilters : undefined}
        />
      ) : (
        <Card>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-1/2 min-w-[280px]">Question Stem</Th>
                  <Th>Track & Subject</Th>
                  <Th>Type</Th>
                  <Th>Difficulty</Th>
                  <Th>Status</Th>
                  <Th>Expected Time</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => {
                  const statusConf = STATUS_CONFIG[q.status] ?? STATUS_CONFIG.draft
                  const diffMeta = DIFFICULTY_LABELS[q.difficultyLabel] ?? DIFFICULTY_LABELS[3]
                  return (
                    <tr key={q.id} className="transition-colors hover:bg-deck/60">
                      <Td>
                        <div className="space-y-1">
                          <p className="line-clamp-2 font-medium text-ink">
                            {q.stemPreview}
                          </p>
                          <div className="flex items-center gap-2 font-mono text-label-xs text-ink-muted">
                            <span>ID: {q.id.slice(0, 8)}…</span>
                            <span>·</span>
                            <span>v{q.version}</span>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <div className="space-y-0.5">
                          <div className="font-medium text-ink">{q.subjectName ?? '—'}</div>
                          <div className="text-label-xs text-ink-muted">{q.trackName ?? 'Unassigned'}</div>
                        </div>
                      </Td>
                      <Td>
                        <Badge className="border border-line font-mono text-label-xs font-normal">
                          {QUESTION_TYPE_LABELS[q.type] ?? q.type}
                        </Badge>
                      </Td>
                      <Td>
                        <span
                          className={cn(
                            'inline-flex items-center rounded border px-2 py-0.5 font-mono text-label-xs font-medium',
                            diffMeta.bg,
                            diffMeta.text,
                          )}
                        >
                          {diffMeta.label}
                        </span>
                      </Td>
                      <Td>
                        <Badge className={cn('border font-mono text-label-xs', statusConf.className)}>
                          {statusConf.label}
                        </Badge>
                      </Td>
                      <Td className="font-mono text-label-sm">
                        {q.expectedTimeSeconds ? `${q.expectedTimeSeconds}s` : '—'}
                      </Td>
                      <Td className="text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void loadDetail(q.id)}
                          className="h-8"
                        >
                          View Detail
                        </Button>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          </TableWrap>

          {/* Pagination Footer */}
          <div className="flex items-center justify-between border-t border-line px-4 py-3">
            <span className="font-mono text-label-sm text-ink-muted">
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                Previous
              </Button>
              <span className="font-mono text-label-sm text-ink px-2">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Question Detail Dialog */}
      <Dialog
        open={Boolean(selectedQuestionId)}
        onClose={() => setSelectedQuestionId(null)}
        title="Question Details"
        description="Inspect full LaTeX stem, options, verified answer keys, and taxonomy configuration."
        className="max-w-3xl"
        footer={
          detail && (
            <div className="flex w-full items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {detail.status !== 'published' && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={Boolean(actionInProgress)}
                    onClick={() => void handleDelete(detail.id)}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {actionInProgress === 'delete' ? 'Deleting…' : 'Delete Question'}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {detail.status === 'draft' && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={Boolean(actionInProgress)}
                    onClick={() => void handlePublish(detail.id)}
                  >
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    {actionInProgress === 'publish' ? 'Publishing…' : 'Publish to Bank'}
                  </Button>
                )}
                {detail.status === 'published' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={Boolean(actionInProgress)}
                    onClick={() => void handleRetire(detail.id)}
                  >
                    <Archive className="mr-1.5 h-3.5 w-3.5" />
                    {actionInProgress === 'retire' ? 'Retiring…' : 'Retire Question'}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setSelectedQuestionId(null)}>
                  Close
                </Button>
              </div>
            </div>
          )
        }
      >
        {detailLoading ? (
          <div className="py-8">
            <PageSkeleton />
          </div>
        ) : detailError ? (
          <div className="rounded border border-deficit/40 bg-deficit/10 p-4 text-body-sm text-deficit">
            {detailError}
          </div>
        ) : detail ? (
          <div className="space-y-5">
            {/* Top metadata tags */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn('border', STATUS_CONFIG[detail.status]?.className)}>
                  {STATUS_CONFIG[detail.status]?.label ?? detail.status}
                </Badge>
                <Badge className="border border-line font-mono text-label-xs">
                  {QUESTION_TYPE_LABELS[detail.type] ?? detail.type}
                </Badge>
                <span className="font-mono text-label-xs text-ink-muted">
                  v{detail.version}
                </span>
                <span className="font-mono text-label-xs text-ink-muted">
                  ID: {detail.id}
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-label-xs text-ink-muted">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {detail.expectedTimeSeconds}s
                </span>
                <span>Difficulty: L{detail.difficultyLabel} (θ {detail.difficultyB.toFixed(2)})</span>
              </div>
            </div>

            {/* Taxonomy Path */}
            {detail.taxonomy ? (
              <div className="rounded border border-line bg-deck/50 p-3 text-body-sm">
                <div className="font-mono text-label-xs text-ink-muted">TAXONOMY HIERARCHY</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-body-sm text-ink">
                  <span className="font-semibold text-accent">{detail.taxonomy.trackName}</span>
                  <span className="text-ink-muted">›</span>
                  <span className="font-medium">{detail.taxonomy.subjectName}</span>
                  <span className="text-ink-muted">›</span>
                  <span>{detail.taxonomy.chapterName}</span>
                  <span className="text-ink-muted">›</span>
                  <span className="text-ink-soft">{detail.taxonomy.topicName}</span>
                  <span className="text-ink-muted">›</span>
                  <span className="font-medium text-ink">{detail.taxonomy.subtopicName}</span>
                </div>
              </div>
            ) : (
              <div className="text-label-sm text-ink-muted">
                Subtopic ID: <code className="font-mono">{detail.subtopicId}</code>
              </div>
            )}

            {/* Stem */}
            <div className="space-y-1.5">
              <div className="font-mono text-label-xs font-semibold text-ink-muted">QUESTION STEM</div>
              <div className="rounded border border-line bg-canvas p-4 text-body-md text-ink whitespace-pre-wrap leading-relaxed shadow-sm font-sans">
                {detail.stem}
              </div>
            </div>

            {/* Options */}
            {detail.options && detail.options.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono text-label-xs font-semibold text-ink-muted">OPTIONS & ANSWER KEY</div>
                <div className="space-y-2">
                  {detail.options.map((opt) => (
                    <div
                      key={opt.key}
                      className={cn(
                        'flex items-start gap-3 rounded border p-3 transition-colors',
                        opt.isCorrect
                          ? 'border-emerald-300 bg-emerald-50/70 text-emerald-950'
                          : 'border-line bg-canvas text-ink',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded font-mono text-label-sm font-semibold',
                          opt.isCorrect
                            ? 'bg-emerald-600 text-white'
                            : 'bg-deck text-ink-soft',
                        )}
                      >
                        {opt.key}
                      </span>
                      <div className="flex-1 text-body-sm leading-relaxed whitespace-pre-wrap">
                        {opt.text}
                      </div>
                      {opt.isCorrect && (
                        <div className="flex items-center gap-1 rounded bg-emerald-600/10 px-2 py-0.5 text-label-xs font-medium text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Correct
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Numeric answer */}
            {detail.numericAnswer && (
              <div className="space-y-1.5 rounded border border-emerald-300 bg-emerald-50/70 p-3 text-emerald-950">
                <div className="font-mono text-label-xs font-semibold text-emerald-800">CORRECT ANSWER</div>
                <div className="font-mono text-body-md">
                  {detail.numericAnswer.value}
                  <span className="ml-2 text-label-sm text-emerald-800">
                    ± {detail.numericAnswer.tolerance} ({detail.numericAnswer.mode})
                  </span>
                </div>
              </div>
            )}

            {/* Matrix-match answer key */}
            {detail.matrixAnswer && Object.keys(detail.matrixAnswer).length > 0 && (
              <div className="space-y-1.5 rounded border border-emerald-300 bg-emerald-50/70 p-3 text-emerald-950">
                <div className="font-mono text-label-xs font-semibold text-emerald-800">CORRECT MATCHES</div>
                <ul className="font-mono text-body-sm">
                  {Object.entries(detail.matrixAnswer).map(([left, rights]) => (
                    <li key={left}>
                      {left} → {rights.join(', ') || '—'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Official Solution */}
            {detail.officialSolution && (
              <div className="space-y-1.5 rounded border border-line bg-deck/30 p-4">
                <div className="font-mono text-label-xs font-semibold text-ink-muted">
                  OFFICIAL SOLUTION{detail.officialSolution.status !== 'approved' ? ` (${detail.officialSolution.status})` : ''}
                </div>
                <div className="text-body-sm text-ink whitespace-pre-wrap leading-relaxed">{detail.officialSolution.body}</div>
                {detail.officialSolution.finalAnswerText && (
                  <p className="font-mono text-label-sm text-ink-soft">Final answer: {detail.officialSolution.finalAnswerText}</p>
                )}
              </div>
            )}

            {/* Hints */}
            {detail.hints && detail.hints.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-mono text-label-xs font-semibold text-ink-muted">HINTS ({detail.hints.length})</div>
                <div className="space-y-1.5">
                  {detail.hints.map((text, i) => (
                    <div key={i} className="rounded border border-line bg-canvas p-2.5 text-body-sm text-ink-soft">
                      <span className="font-mono text-label-xs font-semibold text-ink-muted">Hint {i + 1}: </span>
                      {text}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
