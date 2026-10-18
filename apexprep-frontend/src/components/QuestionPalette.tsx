import { cn, pad2 } from '@/lib/utils'
import type { AttemptState } from '@/types'

/**
 * 32px matrix navigator. Colours follow the approved palette legend exactly.
 *
 * `attempts` holds the questions served so far, not a whole set known in advance: the adaptive engine chooses
 * each question from the learner's updated level, so it cannot hand over question five before four is answered.
 * `total` is therefore the session's target, and the count reads "4 of 15" rather than claiming fifteen
 * questions already exist.
 */
export function QuestionPalette({ attempts, current, onJump, total, title = 'Question Palette' }: {
  attempts: AttemptState[]; current: number; onJump: (index: number) => void; total?: number; title?: string
}) {
  const cls = (a: AttemptState, i: number) => {
    if (i === current) return 'bg-canvas text-primary border-[1.5px] border-primary'
    if (a.flagged) return 'bg-tier-l5 text-white border border-tier-l5'
    if (a.submitted || a.selectedKeys.length > 0 || a.value) return 'bg-mastery text-white border border-mastery'
    if (a.visited) return 'bg-deck text-ink-muted border border-deficit'
    return 'bg-[#F1F5F9] text-ink-muted border border-transparent'
  }
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-label-sm uppercase text-ink">{title}</h3>
        <span className="font-mono text-label-sm text-ink-muted">
          {total ? `${attempts.length} of ${total}` : `${attempts.length} Questions`}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-label-sm text-ink-muted">
        <Legend color="#10B981" label="Answered" />
        <Legend color="#8B5CF6" label="Flagged" />
        <Legend color="#4361EE" label="Current" />
        <Legend color="#CBD5E1" label="Unvisited" />
      </div>
      <div className="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-6 lg:grid-cols-5">
        {attempts.map((a, i) => (
          <button key={a.questionId} onClick={() => onJump(i)} aria-label={`Go to question ${i + 1}`} aria-current={i === current}
            className={cn('relative flex h-9 items-center justify-center rounded font-mono text-label-sm transition-colors', cls(a, i))}>
            {pad2(i + 1)}
            {a.flagged && <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-white" />}
          </button>
        ))}
      </div>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1 font-mono"><span className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>
}
