import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Cpu, RotateCcw, TriangleAlert } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { Button, Card, CardBody, Progress, Table, TableWrap, Td, Th } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { adminContent, type JobStatus } from '@/lib/admin-content'
import { HierarchyStatus } from './SuggestedSyllabus'

const DONE: JobStatus[] = ['awaiting_review', 'published', 'failed', 'cancelled']

/**
 * The organisation's ingestion jobs, newest first, from `GET /v1/admin/ingestion/jobs`: the stage each is in,
 * what it produced, and why it failed when it did. Refreshes itself while any job is still running.
 */
export default function ContentProcessing() {
  const { data: jobs, loading, error, refetch } = useApi(() => adminContent.jobs(), [])
  const { toast } = useToast()
  const running = jobs?.some((j) => !DONE.includes(j.status)) ?? false

  useEffect(() => {
    if (!running) return
    const id = setInterval(refetch, 4000)
    return () => clearInterval(id)
  }, [running, refetch])

  async function retry(id: string) {
    try {
      await adminContent.retryJob(id)
      refetch()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not retry the job', description: errorMessage(err instanceof Error ? err : null) })
    }
  }

  if (loading && !jobs) return <PageSkeleton />
  if (error) return <EmptyState icon={TriangleAlert} title="Could not load jobs" description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />

  return (
    <div className="space-y-6">
      <PageHeader title="Processing" subtitle="Every uploaded PDF and the stage it has reached." actions={<Link to="/admin/upload"><Button size="sm">Upload a PDF</Button></Link>} />
      {jobs?.length === 0 ? (
        <EmptyState icon={Cpu} title="Nothing uploaded yet" description="Upload a source PDF and its processing appears here." />
      ) : (
        <Card>
          <CardBody className="p-0">
            <TableWrap>
              <Table>
                <thead>
                  <tr><Th>Uploaded</Th><Th>Stage</Th><Th>Pages</Th><Th>Found</Th><Th>Published / Review</Th><Th /></tr>
                </thead>
                <tbody>
                  {jobs?.map((j) => (
                    <tr key={j.id}>
                      <Td className="font-mono text-label-sm">{new Date(j.createdAt).toLocaleString()}</Td>
                      <Td>
                        <span className={j.status === 'failed' ? 'text-deficit' : j.status === 'published' ? 'text-mastery font-medium' : 'text-ink'}>
                          {j.status === 'published' ? '✓ Published' : j.status.replace(/_/g, ' ')}
                        </span>
                        {!DONE.includes(j.status) && <Progress className="mt-1.5" value={j.progressPct} />}
                        {j.errorMessage && <p className="mt-1 text-label-sm text-deficit">{j.errorCode}: {j.errorMessage}</p>}
                        {j.status === 'awaiting_review' && <HierarchyStatus hierarchy={j.hierarchy} className="mt-1 block" />}
                      </Td>
                      <Td className="font-mono">{j.pagesTotal}{j.pagesOcr > 0 ? ` (${j.pagesOcr} need OCR)` : ''}</Td>
                      <Td className="font-mono text-label-sm">
                        {Object.entries(j.blocks).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(' · ') || '—'}
                      </Td>
                      <Td className="font-mono text-label-sm">
                        <span className="text-mastery font-semibold">{j.hierarchy?.autoPublished ?? (j.status === 'published' ? 'All' : 0)} published</span>
                        <span className="text-ink-muted"> · </span>
                        <span className={j.openReviewTasks > 0 ? 'text-amber-600 font-medium' : 'text-ink-muted'}>
                          {j.openReviewTasks} review
                        </span>
                      </Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-2">
                          {j.status === 'failed' && <Button variant="secondary" size="sm" onClick={() => void retry(j.id)}><RotateCcw className="h-3.5 w-3.5" /> Retry</Button>}
                          {(j.status === 'awaiting_review' || j.status === 'published') && <Link to={`/admin/review?job=${j.id}`}><Button size="sm">Review</Button></Link>}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
