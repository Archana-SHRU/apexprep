import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Horizontally scrollable on small screens so wide tables never break the page. */
export function TableWrap({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('scroll-x -mx-px w-full', className)} {...p} />
}
export function Table({ className, ...p }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full min-w-[640px] border-collapse text-left', className)} {...p} />
}
export function Th({ className, ...p }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('border-b border-line px-4 py-3 font-mono text-label-sm uppercase text-ink-muted', className)} {...p} />
}
export function Td({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-line px-4 py-3 text-body-sm text-ink-soft align-middle', className)} {...p} />
}
