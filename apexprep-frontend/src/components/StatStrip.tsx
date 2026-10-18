import { cn } from '@/lib/utils'

export interface Stat { label: string; value: string; unit?: string; note?: string; noteTone?: 'mastery' | 'primary' | 'muted' | 'velocity' }

const TONE = { mastery: 'text-mastery', primary: 'text-primary', velocity: 'text-velocity', muted: 'text-ink-muted' }

/** The four-up metric strip from the approved dashboard: hairline dividers, no cards-in-cards. */
export function StatStrip({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 divide-line border border-line bg-canvas sm:grid-cols-2 lg:grid-cols-4 lg:divide-x', className)}>
      {stats.map((s, i) => (
        <div key={s.label} className={cn('px-5 py-4', i < stats.length - 2 && 'border-b border-line lg:border-b-0', i % 2 === 0 && 'border-r border-line lg:border-r-0')}>
          <p className="text-body-sm text-ink-muted">{s.label}</p>
          <p className="mt-1 flex items-baseline gap-1.5">
            <span className="metric">{s.value}</span>
            {s.unit && <span className="text-body-sm font-medium text-ink-soft">{s.unit}</span>}
            {s.note && <span className={cn('font-mono text-label-sm', TONE[s.noteTone ?? 'muted'])}>{s.note}</span>}
          </p>
        </div>
      ))}
    </div>
  )
}
