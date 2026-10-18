import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tone = 'success' | 'info' | 'error'
interface Toast { id: number; title: string; description?: string; tone: Tone }
const Ctx = createContext<{ toast: (t: Omit<Toast, 'id'>) => void } | null>(null)

const ICONS = { success: CheckCircle2, info: Info, error: TriangleAlert }
const TONE = {
  success: 'border-mastery/40 text-mastery',
  info: 'border-primary/40 text-primary',
  error: 'border-deficit/40 text-deficit',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => setItems((p) => p.filter((t) => t.id !== id)), [])
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    setItems((p) => [...p, { ...t, id }])
    setTimeout(() => dismiss(id), 4000)
  }, [dismiss])
  const value = useMemo(() => ({ toast }), [toast])

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => {
          const Icon = ICONS[t.tone]
          return (
            <div key={t.id} className={cn('pointer-events-auto flex items-start gap-3 rounded border bg-canvas p-3 shadow-pop', TONE[t.tone])}>
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-body-sm font-semibold text-ink">{t.title}</p>
                {t.description && <p className="mt-0.5 text-body-sm text-ink-muted">{t.description}</p>}
              </div>
              <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-ink-muted hover:text-ink"><X className="h-4 w-4" /></button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
