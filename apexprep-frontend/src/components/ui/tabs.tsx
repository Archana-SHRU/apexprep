import { cn } from '@/lib/utils'

export interface TabItem { id: string; label: string }

export function Tabs({ items, value, onChange, className }: { items: TabItem[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div className={cn('scroll-x flex items-center gap-1 rounded border border-line bg-deck p-1', className)} role="tablist">
      {items.map((t) => (
        <button
          key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cn(
            'shrink-0 rounded px-3 py-1.5 font-mono text-label-sm transition-colors',
            value === t.id ? 'bg-primary text-white' : 'text-ink-muted hover:text-ink'
          )}
        >{t.label}</button>
      ))}
    </div>
  )
}
