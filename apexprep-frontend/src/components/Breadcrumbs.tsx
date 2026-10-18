import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'

export interface Crumb { label: string; to?: string }

/** Keeps the Track → Subject → Chapter → Topic → Sub-topic position always visible. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="scroll-x flex items-center gap-1 pb-1">
      {items.map((c, i) => (
        <span key={`${c.label}-${i}`} className="flex shrink-0 items-center gap-1">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-ink-muted" />}
          {c.to && i < items.length - 1 ? (
            <Link to={c.to} className="font-mono text-label-sm uppercase text-ink-muted hover:text-primary">{c.label}</Link>
          ) : (
            <span className="font-mono text-label-sm uppercase text-ink">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
