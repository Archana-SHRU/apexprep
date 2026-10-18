import { useEffect, useState } from 'react'
import { Eye, ImageOff, Info, X } from 'lucide-react'
import { Button, Card, CardBody } from '@/components/ui'
import { learningAi, type VisualExplanation } from '@/lib/learning-ai'
import { aiErrorMessage } from './aiError'
import { SceneRenderer } from './SceneRenderer'

const FORMAT_LABEL: Record<string, string> = {
  diagram: 'Diagram',
  graph: 'Graph',
  step_by_step: 'Step by step',
  animation: 'Animation',
  illustration: 'Illustration',
  image: 'Image',
}

/**
 * "Explain visually" — only when the learner asks for it.
 *
 * The server analyses the question and chooses the format (or decides a picture would not help, and says
 * why); this panel renders exactly what came back. If anything fails the learner is told plainly and the
 * question underneath is untouched: a visual is an extra, never a gate on practising.
 */
export function VisualExplanationPanel({ questionId }: { questionId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [visual, setVisual] = useState<VisualExplanation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [imageSrc, setImageSrc] = useState<string | null>(null)

  // A new question starts closed, with nothing carried over from the previous one.
  useEffect(() => {
    setOpen(false)
    setVisual(null)
    setError(null)
    setImageSrc(null)
  }, [questionId])

  // The image is behind the access token, so it is fetched and shown from an object URL.
  useEffect(() => {
    if (!visual?.imageUrl) return
    let url: string | null = null
    let alive = true
    learningAi
      .visualImage(visual.imageUrl)
      .then((blob) => {
        if (!alive) return
        url = URL.createObjectURL(blob)
        setImageSrc(url)
      })
      .catch(() => { if (alive) setImageSrc(null) })
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [visual?.imageUrl])

  async function explain() {
    setOpen(true)
    if (visual || loading) return
    setLoading(true)
    setError(null)
    try {
      setVisual(await learningAi.explainVisually(questionId))
    } catch (err) {
      setError(aiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => void explain()}>
        <Eye className="h-3.5 w-3.5" /> Explain visually
      </Button>
    )
  }

  return (
    <Card className="w-full">
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <p className="eyebrow inline-flex items-center gap-1.5 text-primary"><Eye className="h-3.5 w-3.5" /> Explain visually</p>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="Close the visual and return to the question">
            <X className="h-3.5 w-3.5" /> Back to question
          </Button>
        </div>

        {loading && (
          <div className="mt-3 space-y-2" aria-busy="true" aria-label="Preparing a visual">
            <p className="text-body-sm text-ink-muted">Looking at the question and choosing the clearest way to show it…</p>
            <div className="h-40 w-full animate-pulse rounded bg-deck" />
          </div>
        )}

        {!loading && error && (
          <div className="mt-3 rounded border border-line bg-deck px-4 py-3">
            <p className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-ink"><ImageOff className="h-3.5 w-3.5 text-ink-muted" /> No visual this time</p>
            <p className="mt-1 text-body-sm text-ink-soft">{error}</p>
          </div>
        )}

        {!loading && visual && visual.visualType === 'none' && (
          <div className="mt-3 rounded border border-line bg-deck px-4 py-3">
            <p className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-ink"><Info className="h-3.5 w-3.5 text-ink-muted" /> A picture would not add much here</p>
            <p className="mt-1 text-body-sm text-ink-soft">{visual.reason}</p>
          </div>
        )}

        {!loading && visual && visual.visualType !== 'none' && (
          <div className="mt-3 space-y-3">
            <div>
              <h4 className="text-body-md font-semibold text-ink">{visual.title}</h4>
              <p className="mt-0.5 font-mono text-label-sm text-ink-muted">
                {FORMAT_LABEL[visual.visualType] ?? 'Visual'} · {visual.concept}
              </p>
            </div>
            {visual.imageUrl && imageSrc ? (
              <img src={imageSrc} alt={`${visual.title}. ${visual.caption}`} className="w-full rounded border border-line" />
            ) : visual.scene ? (
              <SceneRenderer scene={visual.scene} animate={visual.visualType === 'animation'} title={visual.title} />
            ) : null}
            {visual.caption && <p className="text-body-sm text-ink-soft">{visual.caption}</p>}
            <p className="rounded border-l-2 border-primary bg-[rgba(67,97,238,0.04)] px-3 py-2 text-body-sm text-ink-soft">{visual.reason}</p>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
