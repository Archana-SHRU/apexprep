import type { LucideIcon } from 'lucide-react'
import { Button } from './ui/button'

export function EmptyState({ icon: Icon, title, description, actionLabel, onAction }: {
  icon: LucideIcon; title: string; description: string; actionLabel?: string; onAction?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 border border-dashed border-line-strong bg-canvas px-6 py-14 text-center">
      <Icon className="h-6 w-6 text-ink-muted" />
      <p className="text-headline-sm text-ink">{title}</p>
      <p className="max-w-sm text-body-sm text-ink-muted">{description}</p>
      {actionLabel && onAction && <Button className="mt-1" onClick={onAction}>{actionLabel}</Button>}
    </div>
  )
}
