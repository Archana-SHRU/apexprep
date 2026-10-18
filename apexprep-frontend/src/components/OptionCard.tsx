import { cn } from '@/lib/utils'
import type { Option } from '@/types'

/** Analytical data-row option with monospace key tag; touch-friendly (min 48px) on mobile. */
export function OptionCard({ option, selected, state, disabled, onSelect }: {
  option: Option; selected: boolean; state?: 'correct' | 'incorrect' | null; disabled?: boolean; onSelect: () => void
}) {
  return (
    <button
      type="button" disabled={disabled} onClick={onSelect} aria-pressed={selected}
      className={cn(
        'flex w-full items-start gap-3 rounded border border-line bg-canvas p-4 text-left transition-colors min-h-[56px]',
        !disabled && 'hover:border-line-strong hover:bg-deck',
        selected && !state && 'border-[1.5px] border-primary bg-[rgba(67,97,238,0.04)]',
        state === 'correct' && 'border-[1.5px] border-mastery bg-[#ECFDF5]',
        state === 'incorrect' && 'border-[1.5px] border-deficit bg-[#FEF2F2]'
      )}
    >
      <span className={cn('mt-0.5 font-mono text-body-sm font-medium',
        state === 'correct' ? 'text-mastery' : state === 'incorrect' ? 'text-deficit' : selected ? 'text-primary' : 'text-ink-muted')}>
        [{option.key}]
      </span>
      <span className="flex-1 text-body-md text-ink-soft">{option.text}</span>
    </button>
  )
}
