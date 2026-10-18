import { useEffect, useMemo, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  Filter,
  GraduationCap,
  RotateCcw,
  Search,
  ShieldAlert,
  TriangleAlert,
  UserCheck,
  UserX,
  Users,
  X,
} from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Badge, Button, Card, CardBody, Dialog, Input, Table, TableWrap, Td, Th } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { adminApi } from '@/lib/admin'
import { cn } from '@/lib/utils'
import type { UserDto } from '@/types/api'

export default function StudentManagement() {
  const { toast } = useToast()

  // Data & loading state
  const [students, setStudents] = useState<UserDto[]>([])
  /** Where the next page of the roster starts; null when everything has been loaded. */
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Filters state
  const [search, setSearch] = useState<string>('')
  const [debouncedSearch, setDebouncedSearch] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all')

  // Action / Confirmation modal state
  const [statusTargetUser, setStatusTargetUser] = useState<UserDto | null>(null)
  const [isChangingStatus, setIsChangingStatus] = useState<boolean>(false)

  // Debounce search input
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search.trim())
    }, 350)
    return () => clearTimeout(handle)
  }, [search])

  // Fetch students from backend
  const fetchStudents = async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await adminApi.getStudents({
        search: debouncedSearch || undefined,
        limit: 100,
      })
      setStudents(page.items)
      setNextCursor(page.nextCursor)
    } catch (err) {
      setError(errorMessage(err instanceof Error ? err : null))
    } finally {
      setLoading(false)
    }
  }

  // The next page of the same search. The roster is never silently cut off at the first response.
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await adminApi.getStudents({ search: debouncedSearch || undefined, limit: 100, cursor: nextCursor })
      setStudents((prev) => [...prev, ...page.items.filter((u) => !prev.some((p) => p.id === u.id))])
      setNextCursor(page.nextCursor)
    } catch (err) {
      toast({ tone: 'error', title: 'Could not load more students', description: errorMessage(err instanceof Error ? err : null) })
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void fetchStudents()
  }, [debouncedSearch])

  // Filter in memory for status
  const displayedStudents = useMemo(() => {
    if (statusFilter === 'all') return students
    return students.filter((s) => s.status === statusFilter)
  }, [students, statusFilter])

  // Change student status (active <-> disabled)
  const handleConfirmStatusChange = async () => {
    if (!statusTargetUser) return
    const targetStatus = statusTargetUser.status === 'active' ? 'disabled' : 'active'
    setIsChangingStatus(true)
    try {
      const updated = await adminApi.changeStudentStatus(statusTargetUser.id, targetStatus)
      setStudents((prev) => prev.map((s) => (s.id === updated.id ? { ...s, status: updated.status } : s)))
      toast({
        tone: 'success',
        title: targetStatus === 'active' ? 'Account enabled' : 'Account disabled',
        description:
          targetStatus === 'active'
            ? `${statusTargetUser.displayName} can now sign in and practise.`
            : `${statusTargetUser.displayName}'s active sessions were terminated.`,
      })
      setStatusTargetUser(null)
    } catch (err) {
      toast({
        tone: 'error',
        title: 'Could not change account status',
        description: errorMessage(err instanceof Error ? err : null),
      })
    } finally {
      setIsChangingStatus(false)
    }
  }

  const resetFilters = () => {
    setSearch('')
    setStatusFilter('all')
  }

  const hasActiveFilters = Boolean(debouncedSearch || statusFilter !== 'all')

  return (
    <div className="space-y-6">
      <PageHeader
        title="Student Management"
        subtitle="Manage enrolled learners, review syllabus progress, and control account active status."
        actions={
          <div className="flex items-center gap-2">
            <span className="font-mono text-label-sm text-ink-muted">
              {students.length} {students.length === 1 ? 'student' : 'students'}{nextCursor ? ' loaded — more available' : ''}
            </span>
          </div>
        }
      />

      {/* Filter and Search Bar */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Search Input */}
            <div className="relative min-w-[260px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
              <Input
                placeholder="Search students by name or email..."
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

            {/* Status Filter */}
            <select
              aria-label="Filter by account status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'disabled')}
              className="h-9 rounded border border-line bg-canvas px-3 py-1 text-body-sm text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active Only</option>
              <option value="disabled">Disabled Only</option>
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

      {/* Roster Table or States */}
      {loading ? (
        <Card>
          <CardBody className="py-12">
            <PageSkeleton />
          </CardBody>
        </Card>
      ) : error ? (
        <EmptyState
          icon={TriangleAlert}
          title="Could not load student roster"
          description={error}
          actionLabel="Try again"
          onAction={fetchStudents}
        />
      ) : displayedStudents.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No students found"
          description={
            hasActiveFilters
              ? 'No enrolled learners match the current search or status criteria.'
              : 'There are currently no students enrolled in your organisation.'
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
                  <Th className="min-w-[240px]">Student</Th>
                  <Th>Primary Track</Th>
                  <Th>Questions Solved</Th>
                  <Th>Joined Date</Th>
                  <Th>Last Login</Th>
                  <Th>Account Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {displayedStudents.map((s) => {
                  const initial = (s.displayName?.[0] || s.email[0] || 'U').toUpperCase()
                  const isActive = s.status === 'active'
                  return (
                    <tr key={s.id} className="transition-colors hover:bg-deck/60">
                      <Td>
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-body-sm font-semibold text-accent">
                            {initial}
                          </div>
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5 font-medium text-ink">
                              <span>{s.displayName || 'Unnamed Student'}</span>
                              {s.onboarded && (
                                <span title="Onboarding completed">
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                                </span>
                              )}
                            </div>
                            <div className="text-label-xs text-ink-muted">{s.email}</div>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        {s.primaryTrackName ? (
                          <Badge className="border border-line font-medium text-ink">
                            <GraduationCap className="mr-1 h-3 w-3 text-accent" />
                            {s.primaryTrackName}
                          </Badge>
                        ) : (
                          <span className="font-mono text-label-sm text-ink-muted">Not selected</span>
                        )}
                      </Td>
                      <Td className="font-mono text-label-sm font-medium">
                        {s.questionsSolved ?? 0}
                      </Td>
                      <Td className="font-mono text-label-sm text-ink-soft">
                        {new Date(s.createdAt).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </Td>
                      <Td className="font-mono text-label-sm text-ink-muted">
                        {s.lastLoginAt
                          ? new Date(s.lastLoginAt).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                            })
                          : 'Never'}
                      </Td>
                      <Td>
                        <Badge
                          className={cn(
                            'border font-mono text-label-xs font-medium',
                            isActive
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                              : 'border-slate-300 bg-slate-100 text-slate-700',
                          )}
                        >
                          {isActive ? 'Active' : 'Disabled'}
                        </Badge>
                      </Td>
                      <Td className="text-right">
                        <Button
                          variant={isActive ? 'secondary' : 'primary'}
                          size="sm"
                          onClick={() => setStatusTargetUser(s)}
                          className="h-8"
                        >
                          {isActive ? (
                            <>
                              <UserX className="mr-1 h-3.5 w-3.5 text-deficit" />
                              <span className="text-deficit">Disable</span>
                            </>
                          ) : (
                            <>
                              <UserCheck className="mr-1 h-3.5 w-3.5" />
                              <span>Enable</span>
                            </>
                          )}
                        </Button>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          </TableWrap>
          {nextCursor && (
            <div className="flex justify-center border-t border-line p-3">
              <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more students'}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Confirmation Dialog for Status Change */}
      <Dialog
        open={Boolean(statusTargetUser)}
        onClose={() => {
          if (!isChangingStatus) setStatusTargetUser(null)
        }}
        title={statusTargetUser?.status === 'active' ? 'Disable Student Account?' : 'Enable Student Account?'}
        description={
          statusTargetUser?.status === 'active'
            ? `Disabling ${statusTargetUser.displayName || statusTargetUser.email} will immediately invalidate their sessions and revoke access to practice and theory.`
            : `Re-enabling ${statusTargetUser?.displayName || statusTargetUser?.email} will restore their access to practice sessions and study materials.`
        }
        className="max-w-md"
        footer={
          statusTargetUser && (
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={isChangingStatus}
                onClick={() => setStatusTargetUser(null)}
              >
                Cancel
              </Button>
              <Button
                variant={statusTargetUser.status === 'active' ? 'destructive' : 'primary'}
                size="sm"
                disabled={isChangingStatus}
                onClick={() => void handleConfirmStatusChange()}
              >
                {isChangingStatus
                  ? 'Updating…'
                  : statusTargetUser.status === 'active'
                    ? 'Confirm Disable'
                    : 'Confirm Enable'}
              </Button>
            </div>
          )
        }
      />
    </div>
  )
}
