import { useMemo, useState } from 'react'
import { Download, FileText, TriangleAlert } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button, Card, CardBody, Table, TableWrap, Tabs, Td, Th } from '@/components/ui'
import { PageSkeleton } from '@/components/ui/skeleton'
import { errorMessage, useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { api } from '@/lib/api'
import { http } from '@/lib/http'
import { duration, levelLabel, pct, sinceDays } from '@/lib/format'
import type { TopicPerformance } from '@/types'

const RANGES = [
  { id: '30d', label: 'Last 30 Days' },
  { id: '90d', label: 'Last 90 Days' },
  { id: 'all', label: 'All Time' },
]

/**
 * A per-sub-topic record of the learner's own performance.
 *
 * The table lists **every** sub-topic the learner has attempted, from `subtopicPerformance` — not the five
 * weakest and five strongest, which is what the ranked lists on the Analytics page are for. Its "Retention"
 * column is gone: retention is not implemented anywhere in the backend, and the numbers it showed were mock.
 * "Last practised" takes its place, which is a real column.
 *
 * Export is a button that does nothing yet, so it says so rather than claiming a queued export. Listed in
 * docs/INTEGRATION-MAP.md §4 as a missing backend capability.
 */
export default function Reports() {
  const [range, setRange] = useState('all')
  const [sort, setSort] = useState<'accuracy' | 'questions' | 'stale'>('accuracy')
  const [exporting, setExporting] = useState(false)
  const { data, loading, error, refetch } = useApi(() => api.getAnalytics(range), [range])
  const { toast } = useToast()

  async function handleExportPdf() {
    setExporting(true)
    try {
      const blob = await http.getBlob(`/v1/me/reports/export.pdf?range=${range}`)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `apexprep-performance-report-${range}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({
        tone: 'success',
        title: 'Report exported',
        description: 'Your diagnostic performance report PDF has been downloaded.',
      })
    } catch (err) {
      toast({
        tone: 'error',
        title: 'Export failed',
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setExporting(false)
    }
  }

  const rows = useMemo(() => {
    const all = [...(data?.subtopicPerformance ?? [])]
    if (sort === 'questions') return all.sort((a, b) => b.questions - a.questions)
    if (sort === 'stale') return all.sort((a, b) => (b.lastPracticedDays ?? -1) - (a.lastPracticedDays ?? -1))
    // Lowest accuracy first, with unranked (no graded attempts) at the end rather than pretending to be 0%.
    return all.sort((a, b) => (a.accuracy ?? 101) - (b.accuracy ?? 101))
  }, [data?.subtopicPerformance, sort])

  if (loading) return <PageSkeleton />

  if (error || !data) {
    return (
      <EmptyState icon={TriangleAlert} title="Could not load your report"
        description={errorMessage(error)} actionLabel="Try again" onAction={refetch} />
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Your performance sub-topic by sub-topic, from your own attempts."
        actions={
          <Button
            variant="secondary"
            disabled={exporting}
            onClick={() => void handleExportPdf()}
          >
            <Download className="h-4 w-4" /> {exporting ? 'Generating PDF…' : 'Export PDF'}
          </Button>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row">
        <Tabs items={RANGES} value={range} onChange={setRange} className="w-fit" />
        <Tabs
          items={[{ id: 'accuracy', label: 'Weakest first' }, { id: 'questions', label: 'Most practised' }, { id: 'stale', label: 'Longest untouched' }]}
          value={sort}
          onChange={(id) => setSort(id as typeof sort)}
          className="w-fit"
        />
      </div>

      <Card>
        <CardBody>
          <h3 className="inline-flex items-center gap-2 text-headline-sm text-ink">
            <FileText className="h-4 w-4 text-ink-muted" /> Sub-topic performance
          </h3>
          <p className="mt-1 text-body-sm text-ink-muted">
            {rows.length === 0
              ? 'Nothing to report yet — this table fills in as you practise.'
              : `${rows.length} ${rows.length === 1 ? 'sub-topic' : 'sub-topics'} attempted in this period.`}
          </p>

          {rows.length > 0 && (
            <TableWrap className="mt-4">
              <Table>
                <thead>
                  <tr>
                    <Th>Sub-topic</Th><Th>Topic</Th><Th>Subject</Th><Th>Level</Th>
                    <Th>Accuracy</Th><Th>Questions</Th><Th>Median time</Th><Th>Last practised</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.subTopicId}>
                      <Td className="font-medium text-ink">{t.name}</Td>
                      <Td>{t.topic}</Td>
                      <Td>{t.subject}</Td>
                      <Td className="font-mono">{levelLabel(t.level)}</Td>
                      <Td className="font-mono" style={{ color: accuracyColour(t) }}>{pct(t.accuracy)}</Td>
                      <Td className="font-mono">{t.questions}</Td>
                      <Td className="font-mono">{duration(t.paceSeconds)}</Td>
                      <Td className="font-mono">{sinceDays(t.lastPracticedDays)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="text-headline-sm text-ink">Questions solved per week</h3>
          <div className="mt-4 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="#E2E8F0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={{ stroke: '#E2E8F0' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(67,97,238,0.05)' }} contentStyle={{ border: '1px solid #CBD5E1', borderRadius: 4, fontSize: 13 }} />
                <Bar dataKey="questions" name="Questions" fill="#4361EE" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

/** Grey where there is no accuracy to colour, rather than the red that a 0 would attract. */
function accuracyColour(t: TopicPerformance): string {
  if (t.accuracy === null) return '#94A3B8'
  if (t.accuracy >= 85) return '#10B981'
  if (t.accuracy >= 70) return '#F59E0B'
  return '#EF4444'
}
