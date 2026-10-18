import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Question } from '@/types'

interface MatrixMatchCardProps {
  question: Question
  selected: Record<string, string[]>
  revealed?: Record<string, string[]> | null
  submitted: boolean
  onToggle: (leftKey: string, rightKey: string) => void
}

export function MatrixMatchCard({
  question,
  selected,
  revealed,
  submitted,
  onToggle,
}: MatrixMatchCardProps) {
  const leftItems = question.matrix?.left ?? []
  const rightItems = question.matrix?.right ?? []

  if (leftItems.length === 0 || rightItems.length === 0) {
    return (
      <div className="rounded border border-line bg-deck p-4 text-body-sm text-ink-soft">
        No matrix match columns provided for this question.
      </div>
    )
  }

  return (
    <div className="mt-5 space-y-6">
      {/* Side-by-side or stacked column lists */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Column I */}
        <div className="rounded border border-line bg-canvas p-4">
          <h4 className="font-mono text-label-sm font-semibold uppercase tracking-wider text-ink-muted">
            Column I
          </h4>
          <div className="mt-3 space-y-2.5">
            {leftItems.map((item) => (
              <div key={item.key} className="flex items-start gap-2.5 text-body-sm">
                <span className="font-mono font-bold text-primary">[{item.key}]</span>
                <span className="text-ink">{item.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Column II */}
        <div className="rounded border border-line bg-canvas p-4">
          <h4 className="font-mono text-label-sm font-semibold uppercase tracking-wider text-ink-muted">
            Column II
          </h4>
          <div className="mt-3 space-y-2.5">
            {rightItems.map((item) => (
              <div key={item.key} className="flex items-start gap-2.5 text-body-sm">
                <span className="font-mono font-bold text-ink-muted">({item.key})</span>
                <span className="text-ink">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Interactive Match Grid */}
      <div className="rounded border border-line bg-canvas p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <h4 className="font-mono text-label-sm font-semibold uppercase tracking-wider text-ink-muted">
            Matching Grid
          </h4>
          <span className="text-caption text-ink-soft">
            {submitted
              ? 'Results: Review correct matches below'
              : 'Select one or more matches for each item in Column I'}
          </span>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-center">
            <thead>
              <tr>
                <th className="border-b border-r border-line p-2 text-left font-mono text-label-sm text-ink-muted">
                  I \ II
                </th>
                {rightItems.map((right) => (
                  <th
                    key={right.key}
                    className="border-b border-line p-2 font-mono text-body-sm font-bold text-ink"
                  >
                    ({right.key})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leftItems.map((left) => {
                const userSelectedRights = selected[left.key] ?? []
                const correctRights = revealed ? revealed[left.key] ?? [] : []

                return (
                  <tr key={left.key} className="border-b border-line last:border-b-0">
                    <td className="border-r border-line p-2.5 text-left font-mono text-body-sm font-bold text-primary">
                      [{left.key}]
                    </td>
                    {rightItems.map((right) => {
                      const isChosen = userSelectedRights.includes(right.key)
                      const isCorrect = correctRights.includes(right.key)

                      // Determine cell appearance after submission
                      let cellClass = 'border-line hover:border-line-strong hover:bg-deck'
                      let icon = null

                      if (submitted) {
                        if (isChosen && isCorrect) {
                          cellClass = 'border-mastery bg-[#ECFDF5] text-mastery'
                          icon = <Check className="h-4 w-4" />
                        } else if (isChosen && !isCorrect) {
                          cellClass = 'border-deficit bg-[#FEF2F2] text-deficit'
                          icon = <X className="h-4 w-4" />
                        } else if (!isChosen && isCorrect) {
                          cellClass = 'border-dashed border-mastery bg-emerald-50/50 text-mastery'
                          icon = <span className="font-mono text-xs font-bold">MISS</span>
                        } else {
                          cellClass = 'border-line/40 text-ink-muted/30 opacity-40'
                        }
                      } else if (isChosen) {
                        cellClass = 'border-primary bg-[rgba(67,97,238,0.12)] text-primary font-bold ring-1 ring-primary'
                        icon = <Check className="h-4 w-4 stroke-[2.5]" />
                      }

                      return (
                        <td key={right.key} className="p-1.5">
                          <button
                            type="button"
                            disabled={submitted}
                            onClick={() => onToggle(left.key, right.key)}
                            aria-label={`Match Column I ${left.key} with Column II ${right.key}`}
                            className={cn(
                              'mx-auto flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded border transition-all',
                              cellClass,
                              submitted && 'cursor-default'
                            )}
                          >
                            {icon || (
                              <span className="font-mono text-caption text-ink-muted">
                                {isChosen ? '●' : '○'}
                              </span>
                            )}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        {submitted && (
          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-line pt-3 text-caption text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded border border-mastery bg-[#ECFDF5] text-mastery">
                <Check className="h-3 w-3" />
              </span>
              Correct selection
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded border border-deficit bg-[#FEF2F2] text-deficit">
                <X className="h-3 w-3" />
              </span>
              Incorrect selection
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="flex h-4 px-1 items-center justify-center rounded border border-dashed border-mastery text-mastery text-[10px] font-bold">
                MISS
              </span>
              Missed match
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
