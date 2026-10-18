import { useState } from 'react'
import { ChevronDown, ChevronUp, HelpCircle, Lightbulb, Sparkles } from 'lucide-react'
import { Button, Card, CardBody } from '@/components/ui'
import { cn } from '@/lib/utils'

interface HintPanelProps {
  hintCount: number
  revealedHints: string[]
  revealing: boolean
  submitted: boolean
  onReveal: () => Promise<void>
}

export function HintPanel({
  hintCount,
  revealedHints,
  revealing,
  submitted,
  onReveal,
}: HintPanelProps) {
  const [open, setOpen] = useState(false)

  if (hintCount === 0) {
    return null
  }

  const remaining = hintCount - revealedHints.length
  const nextIndex = revealedHints.length + 1

  return (
    <div className="w-full">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen(!open)}
          className={cn(
            'inline-flex items-center gap-2 border-line bg-canvas transition-colors',
            revealedHints.length > 0 && 'border-amber-400 bg-amber-50/50 text-amber-900',
            open && 'ring-1 ring-primary'
          )}
        >
          <Lightbulb
            className={cn(
              'h-4 w-4',
              revealedHints.length > 0 ? 'text-amber-500 fill-amber-500/20' : 'text-ink-muted'
            )}
          />
          <span>
            Hints ({revealedHints.length}/{hintCount})
          </span>
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {open && (
        <Card className="mt-3 border-amber-200 bg-amber-50/30">
          <CardBody className="space-y-4 p-4">
            <div className="flex items-center justify-between border-b border-amber-200/60 pb-2">
              <div className="flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-amber-600" />
                <h4 className="font-mono text-label-sm font-semibold uppercase tracking-wider text-amber-900">
                  Question Hints ({revealedHints.length} of {hintCount})
                </h4>
              </div>
              <span className="font-mono text-caption text-amber-800/80">
                {remaining === 0 ? 'All revealed' : `${remaining} remaining`}
              </span>
            </div>

            {revealedHints.length === 0 ? (
              <div className="rounded border border-dashed border-amber-300 bg-canvas/80 p-3.5 text-body-sm text-ink-soft">
                <p className="flex items-center gap-1.5 font-medium text-ink">
                  <HelpCircle className="h-4 w-4 text-amber-600" /> Need a nudge?
                </p>
                <p className="mt-1 text-ink-soft">
                  Reveal hints one step at a time to help guide your derivation without giving away the answer.
                  Hint usage is recorded with your attempt.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {revealedHints.map((hint, idx) => (
                  <div
                    key={idx}
                    className="rounded border border-line bg-canvas p-3.5 shadow-xs transition-all"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-amber-100 px-2 py-0.5 font-mono text-xs font-semibold text-amber-900">
                        Hint {idx + 1}
                      </span>
                    </div>
                    <p className="mt-2 text-body-md text-ink whitespace-pre-line">{hint}</p>
                  </div>
                ))}
              </div>
            )}

            {!submitted && remaining > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <Button
                  size="sm"
                  onClick={() => void onReveal()}
                  disabled={revealing}
                  className="bg-amber-600 text-white hover:bg-amber-700"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {revealing ? 'Revealing hint…' : `Reveal Hint ${nextIndex} of ${hintCount}`}
                </Button>
                <span className="text-caption text-ink-muted">
                  Recorded on your attempt score
                </span>
              </div>
            )}

            {remaining === 0 && (
              <p className="font-mono text-caption text-amber-800">
                All hints for this question have been revealed.
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  )
}
