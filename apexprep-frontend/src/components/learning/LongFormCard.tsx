import { useMemo } from 'react'
import { FileText, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LongFormCardProps {
  text: string
  submitted: boolean
  onChange: (text: string) => void
}

export function LongFormCard({ text, submitted, onChange }: LongFormCardProps) {
  const stats = useMemo(() => {
    const trimmed = text.trim()
    const charCount = text.length
    const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
    return { charCount, wordCount }
  }, [text])

  return (
    <div className="mt-5 space-y-4">
      <div>
        <div className="flex items-center justify-between">
          <label
            htmlFor="long-form-input"
            className="font-mono text-label-sm font-semibold uppercase tracking-wider text-ink-muted"
          >
            Written Response / Solution Working
          </label>
          <span className="font-mono text-caption text-ink-muted">
            {stats.wordCount} words · {stats.charCount} characters
          </span>
        </div>

        <div className="mt-2">
          <textarea
            id="long-form-input"
            rows={7}
            disabled={submitted}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Type your complete solution, step-by-step mathematical reasoning, derivations, or explanation here..."
            className={cn(
              'w-full rounded border border-line bg-canvas p-3.5 text-body-md text-ink transition-colors',
              'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
              'placeholder:text-ink-muted/50 disabled:cursor-not-allowed disabled:bg-deck/60 disabled:text-ink-soft'
            )}
          />
        </div>
      </div>

      {submitted ? (
        <div className="flex items-start gap-3 rounded border border-line bg-deck p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="space-y-1 text-body-sm">
            <p className="font-semibold text-ink">Response Submitted for Review</p>
            <p className="text-ink-soft">
              Written long-form responses cannot be graded automatically. Your response has been recorded
              with status <span className="font-mono font-medium text-ink">ungraded</span>. Compare your
              steps against the official solution and AI explanation below.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-caption text-ink-muted">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span>
            Be as clear and structured as possible. State equations, assumptions, and concluding values.
          </span>
        </div>
      )}
    </div>
  )
}
