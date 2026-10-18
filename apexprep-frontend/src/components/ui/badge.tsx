import type { HTMLAttributes } from 'react'
import { cn, TIER_META } from '@/lib/utils'
import type { Difficulty } from '@/types'

export function Badge({ className, ...p }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-label-sm', className)} {...p} />
}

export function DifficultyChip({ level, className }: { level: Difficulty; className?: string }) {
  const meta = TIER_META[level]
  return (
    <span
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-label-sm', className)}
      style={{ color: meta.hex, borderColor: meta.hex, backgroundColor: `${meta.hex}1A` }}
      title={meta.label}
    >
      {meta.label.replace(/^L\d /, `${meta.short} `)}
    </span>
  )
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    approved: 'text-mastery border-mastery/40 bg-mastery/10',
    review: 'text-primary border-primary/40 bg-primary/10',
    pending: 'text-velocity border-velocity/40 bg-velocity/10',
    processing: 'text-velocity border-velocity/40 bg-velocity/10',
    queued: 'text-ink-muted border-line-strong bg-deck',
    inactive: 'text-ink-muted border-line-strong bg-deck',
    active: 'text-mastery border-mastery/40 bg-mastery/10',
    failed: 'text-deficit border-deficit/40 bg-deficit/10',
    rejected: 'text-deficit border-deficit/40 bg-deficit/10',
    completed: 'text-mastery border-mastery/40 bg-mastery/10',
    available: 'text-primary border-primary/40 bg-primary/10',
  }
  return <Badge className={cn('border uppercase', map[status] ?? 'border-line-strong text-ink-muted')}>{status}</Badge>
}
