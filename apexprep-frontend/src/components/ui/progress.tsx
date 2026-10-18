import { cn } from '@/lib/utils'

export function Progress({ value, color = '#4361EE', className, height = 'h-1.5' }: { value: number; color?: string; className?: string; height?: string }) {
  return (
    <div className={cn('w-full overflow-hidden rounded-full bg-[#E2E8F0]', height, className)} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }} />
    </div>
  )
}
