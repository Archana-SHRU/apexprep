import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Dialog({ open, onClose, title, description, children, footer, className }: {
  open: boolean; onClose: () => void; title: string; description?: string
  children?: ReactNode; footer?: ReactNode; className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className={cn('w-full max-w-lg rounded-t-lg border border-line-strong bg-canvas shadow-pop sm:rounded', className)} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line p-4">
          <div>
            <h2 className="text-headline-sm text-ink">{title}</h2>
            {description && <p className="mt-1 text-body-sm text-ink-muted">{description}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-muted hover:text-ink"><X className="h-4 w-4" /></button>
        </div>
        {children && <div className="p-4">{children}</div>}
        {footer && <div className="flex justify-end gap-2 border-t border-line p-4">{footer}</div>}
      </div>
    </div>
  )
}
