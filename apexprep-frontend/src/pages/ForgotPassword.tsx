import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MailCheck } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button, Field, Input } from '@/components/ui'
import { forgotPasswordError, requestPasswordReset } from '@/lib/password-reset'

export type ForgotState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string }

/**
 * "Forgot password?" — asks the backend to email a reset link.
 *
 * Whatever the backend finds, the screen says the same thing afterwards: "if an account exists…". It never says
 * an address is unknown, because that would let anyone check who has an account.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<ForgotState>({ kind: 'idle' })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const address = email.trim()
    if (!address.includes('@')) {
      setState({ kind: 'error', message: 'Enter the email address you registered with.' })
      return
    }
    setState({ kind: 'sending' })
    try {
      await requestPasswordReset(address)
      setState({ kind: 'sent', email: address })
    } catch (err) {
      setState({ kind: 'error', message: forgotPasswordError(err) })
    }
  }

  return <ForgotPasswordView state={state} email={email} onEmail={setEmail} onSubmit={submit} onRetry={() => setState({ kind: 'idle' })} />
}

/** The screen for a given state; separate from the page so each state can be rendered and tested on its own. */
export function ForgotPasswordView({
  state,
  email,
  onEmail,
  onSubmit,
  onRetry,
}: {
  state: ForgotState
  email: string
  onEmail: (value: string) => void
  onSubmit: (e: React.FormEvent) => void
  onRetry: () => void
}) {
  if (state.kind === 'sent') {
    return (
      <AuthLayout title="Check your email" subtitle="Follow the link in the email to choose a new password.">
        <div className="space-y-4">
          <div role="status" className="flex gap-3 rounded-lg border border-mastery/30 bg-mastery/5 p-4 text-body-sm text-ink-soft">
            <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-mastery" aria-hidden />
            <p>
              If an account exists for <span className="font-medium text-ink">{state.email}</span>, we have sent a link to reset its password.
              The link expires soon and works once.
            </p>
          </div>
          <p className="text-body-sm text-ink-muted">Nothing arrived after a few minutes? Check your spam folder, or request another link.</p>
          <Button type="button" variant="secondary" size="lg" className="w-full" onClick={onRetry}>Send another link</Button>
          <p className="text-center text-body-sm text-ink-muted">
            <Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>
          </p>
        </div>
      </AuthLayout>
    )
  }

  const sending = state.kind === 'sending'
  return (
    <AuthLayout title="Forgot your password?" subtitle="Enter your email and we will send you a link to reset it.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {state.kind === 'error' && (
          <p role="alert" className="rounded-lg border border-deficit/30 bg-deficit/5 p-3 text-body-sm text-deficit">{state.message}</p>
        )}
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => onEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" disabled={sending} />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={sending}>{sending ? 'Sending…' : 'Send reset link'}</Button>
        <p className="text-center text-body-sm text-ink-muted">
          Remembered it? <Link to="/login" className="font-medium text-primary hover:underline">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
