import type { ReactNode } from 'react'
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h1 className="text-[2rem] font-bold leading-10 tracking-[-0.025em] text-ink sm:text-headline-xl">{title}</h1>
        {subtitle && <p className="mt-1 text-body-md text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
