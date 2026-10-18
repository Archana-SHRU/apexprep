import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BookOpen, Lightbulb, MessageCircle, Send, Sparkles } from 'lucide-react'
import { Button, Card, CardBody, Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { learningAi, type TutorConversation, type TutorIntent, type TutorMessage } from '@/lib/learning-ai'
import { aiErrorMessage } from './aiError'

const BEFORE_ANSWER: { intent: TutorIntent; label: string; message: string }[] = [
  { intent: 'hint', label: 'Give me a hint', message: 'Can I have a hint?' },
  { intent: 'concept', label: 'Explain the concept', message: 'Can you explain the concept behind this?' },
  { intent: 'simplify', label: 'In simple words', message: 'Can you explain this in simple words?' },
]
const AFTER_ANSWER: { intent: TutorIntent; label: string; message: string }[] = [
  { intent: 'why_wrong', label: 'Why is my answer wrong?', message: 'Why is my answer wrong?' },
  { intent: 'explain_step', label: 'Explain step by step', message: 'Can you explain the solution step by step?' },
  { intent: 'another_example', label: 'Another example', message: 'Can you give me another example?' },
  { intent: 'simplify', label: 'In simple words', message: 'I still don’t understand. Can you explain it more simply?' },
]
const TOPIC_ONLY: { intent: TutorIntent; label: string; message: string }[] = [
  { intent: 'concept', label: 'Explain the key idea', message: 'Can you explain the key idea of this topic?' },
  { intent: 'another_example', label: 'Give an example', message: 'Can you give me an example?' },
  { intent: 'simplify', label: 'In simple words', message: 'Can you explain this topic in simple words?' },
]

/**
 * The AI tutor, anchored to what the learner is looking at: a sub-topic, and a question when there is one.
 *
 * The conversation lives on the server, so a follow-up ("explain step 2") is answered in context. Before the
 * learner has answered, the tutor gives hints and not answers — the server enforces that against the answer
 * key, and this panel says so, so the learner knows why.
 */
export function TutorPanel({ subtopicId, questionId, answered, title = 'Ask the AI tutor' }: {
  subtopicId: string
  questionId?: string
  answered?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [conversation, setConversation] = useState<TutorConversation | null>(null)
  const [messages, setMessages] = useState<TutorMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // A different question or topic is a different conversation.
  useEffect(() => {
    setConversation(null)
    setMessages([])
    setError(null)
    setOpen(false)
  }, [subtopicId, questionId])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [messages.length])

  async function ensureConversation(): Promise<TutorConversation | null> {
    if (conversation) return conversation
    try {
      const c = await learningAi.startTutor(subtopicId, questionId)
      setConversation(c)
      setMessages(c.messages)
      return c
    } catch (err) {
      setError(aiErrorMessage(err))
      return null
    }
  }

  async function openPanel() {
    setOpen(true)
    await ensureConversation()
  }

  async function send(message: string, intent: TutorIntent) {
    const trimmed = message.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const c = await ensureConversation()
      if (!c) return
      const reply = await learningAi.askTutor(c.id, trimmed, intent)
      setMessages((m) => [...m, reply.student, reply.tutor])
      setText('')
    } catch (err) {
      setError(aiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void send(text, 'free')
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => void openPanel()}>
        <MessageCircle className="h-3.5 w-3.5" /> {questionId ? 'Ask AI tutor' : 'Ask a doubt'}
      </Button>
    )
  }

  const hasAnswered = answered ?? conversation?.answered ?? false
  const actions = !questionId ? TOPIC_ONLY : hasAnswered ? AFTER_ANSWER : BEFORE_ANSWER

  return (
    <Card className="w-full">
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <p className="eyebrow inline-flex items-center gap-1.5 text-primary"><Sparkles className="h-3.5 w-3.5" /> {title}</p>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
        </div>
        {questionId && !hasAnswered && (
          <p className="mt-2 inline-flex items-start gap-1.5 text-body-sm text-ink-muted">
            <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Hint mode: the tutor helps you think it through but won’t give the answer until you’ve submitted yours.
          </p>
        )}

        <div className="mt-3 max-h-96 space-y-3 overflow-y-auto" aria-live="polite">
          {messages.length === 0 && !busy && (
            <p className="text-body-sm text-ink-muted">Ask anything about this {questionId ? 'question' : 'topic'}, or pick one of the prompts below.</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cn('rounded px-3 py-2 text-body-sm', m.role === 'student' ? 'ml-8 bg-primary/10 text-ink' : 'mr-8 border border-line bg-deck text-ink-soft')}>
              <p className="whitespace-pre-wrap">{m.body}</p>
              {m.steps.length > 0 && (
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  {m.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
              {m.role === 'tutor' && m.grounded && (
                <p className="mt-1.5 inline-flex items-center gap-1 font-mono text-label-sm text-ink-muted"><BookOpen className="h-3 w-3" /> From your course notes</p>
              )}
            </div>
          ))}
          {busy && <div className="mr-8 h-10 animate-pulse rounded bg-deck" aria-label="The tutor is replying" />}
          <div ref={endRef} />
        </div>

        {error && <p className="mt-3 rounded border border-line bg-deck px-3 py-2 text-body-sm text-ink-soft">{error}</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button key={a.intent + a.label} variant="subtle" size="sm" disabled={busy} onClick={() => void send(a.message, a.intent)}>{a.label}</Button>
          ))}
        </div>
        <form className="mt-3 flex gap-2" onSubmit={onSubmit}>
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Type your doubt…" aria-label="Ask the tutor" disabled={busy} />
          <Button type="submit" disabled={busy || text.trim().length === 0}><Send className="h-4 w-4" /> Ask</Button>
        </form>
      </CardBody>
    </Card>
  )
}
