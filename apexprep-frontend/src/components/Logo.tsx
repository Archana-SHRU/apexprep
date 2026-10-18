import { cn } from '@/lib/utils'
export function Logo({ className, showWordmark = true }: { className?: string; showWordmark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
        <path d="M12 2 3 21h4.2l4.8-10.4L16.8 21H21L12 2Z" fill="#4361EE" />
        <circle cx="12" cy="7" r="1.6" fill="#10B981" />
      </svg>
      {showWordmark && (
        <span className="text-[1.0625rem] font-bold tracking-tight text-ink">
          Apex<span className="text-primary">Prep</span>
        </span>
      )}
    </span>
  )
}
