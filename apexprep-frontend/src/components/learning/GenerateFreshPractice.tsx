import { useState } from 'react'
import { Wand2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { useToast } from '@/hooks/useToast'
import { learningAi, type GeneratedQuestionsResult } from '@/lib/learning-ai'
import { aiErrorMessage } from './aiError'

/**
 * "Generate fresh practice": new questions written from the published notes at the level the adaptive engine
 * sets for this learner. They join the practice pool; the engine still decides what is served next. The
 * response carries no answers, and a failure leaves the existing questions exactly as they were.
 */
export function GenerateFreshPractice({ subtopicId, onGenerated, size = 'sm', label = 'Generate fresh practice' }: {
  subtopicId: string
  onGenerated?: (result: GeneratedQuestionsResult) => void | Promise<void>
  size?: 'sm' | 'md' | 'lg'
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  async function run() {
    setBusy(true)
    try {
      const result = await learningAi.generateQuestions(subtopicId, 2)
      toast({ tone: 'success', title: 'Fresh questions ready', description: result.message })
      await onGenerated?.(result)
    } catch (err) {
      toast({ tone: 'error', title: 'No new questions this time', description: aiErrorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="secondary" size={size} onClick={() => void run()} disabled={busy}>
      <Wand2 className="h-3.5 w-3.5" /> {busy ? 'Writing questions at your level…' : label}
    </Button>
  )
}
