import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2, Eye, EyeOff, LinkIcon } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button, Field, Input } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { PASSWORD_MIN, readResetToken, resetPassword, resetPasswordError } from '@/lib/password-reset'

export type ResetState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'done' } | { kind: 'error'; message: string }

/**
 * Choosing a new password from the emailed link (`/reset-password?token=…`).
 *
 * On success the backend signs the account out everywhere, so this tab's own session — if it had one — is
 * cleared too, and the learner signs in again with the new password.
 */
export default function ResetPassword() {
  const token = readResetToken(useLocation().search)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [state, setState] = useState<ResetState>({ kind: 'idle' })
  const { session, logout } = useAuth()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!token) return
    if (password.length < PASSWORD_MIN) {
      setState({ kind: 'error', message: `Use at least ${PASSWORD_MIN} characters.` })
      return
    }
    if (password !== confirm) {
      setState({ kind: 'error', message: 'The two passwords do not match.' })
      return
    }
    setState({ kind: 'saving' })
    try {
      await resetPassword(token, password)
      if (session) await logout()
      setPassword('')
      setConfirm('')
      setState({ kind: 'done' })
    } catch (err) {
      setState({ kind: 'error', message: resetPasswordError(err) })
    }
  }

  return (
    <ResetPasswordView
      hasToken={token !== null}
      state={state}
      password={password}
      confirm={confirm}
      onPassword={setPassword}
      onConfirm={setConfirm}
      onSubmit={submit}
    />
  )
}

/** The screen for a given state; separate from the page so each state can be rendered and tested on its own. */
export function ResetPasswordView({
  hasToken,
  state,
  password,
  confirm,
  onPassword,
  onConfirm,
  onSubmit,
}: {
  hasToken: boolean
  state: ResetState
  password: string
  confirm: string
  onPassword: (value: string) => void
  onConfirm: (value: string) => void
  onSubmit: (e: React.FormEvent) => void
}) {
  const [visible, setVisible] = useState(false)
  const navigate = useNavigate()

  if (state.kind === 'done') {
    return (
      <AuthLayout title="Password updated" subtitle="Sign in with your new password.">
        <div className="space-y-4">
          <div role="status" className="flex gap-3 rounded-lg border border-mastery/30 bg-mastery/5 p-4 text-body-sm text-ink-soft">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-mastery" aria-hidden />
            <p>Your password has been reset. For your security, every device that was signed in to this account has been signed out.</p>
          </div>
          <Button type="button" size="lg" className="w-full" onClick={() => navigate('/login')}>Back to sign in</Button>
        </div>
      </AuthLayout>
    )
  }

  if (!hasToken) {
    return (
      <AuthLayout title="Reset link not valid" subtitle="This page needs the link from your password reset email.">
        <div className="space-y-4">
          <div role="alert" className="flex gap-3 rounded-lg border border-deficit/30 bg-deficit/5 p-4 text-body-sm text-ink-soft">
            <LinkIcon className="mt-0.5 h-5 w-5 shrink-0 text-deficit" aria-hidden />
            <p>The link is missing its reset code or was copied incompletely. Open the link from the email again, or request a new one.</p>
          </div>
          <Button type="button" size="lg" className="w-full" onClick={() => navigate('/forgot-password')}>Request a new link</Button>
          <p className="text-center text-body-sm text-ink-muted">
            <Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>
          </p>
        </div>
      </AuthLayout>
    )
  }

  const saving = state.kind === 'saving'
  const type = visible ? 'text' : 'password'
  return (
    <AuthLayout title="Choose a new password" subtitle="Your new password replaces the old one on every device.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {state.kind === 'error' && (
          <div role="alert" className="rounded-lg border border-deficit/30 bg-deficit/5 p-3 text-body-sm text-deficit">
            <p>{state.message}</p>
            {/expired|invalid|already been used/i.test(state.message) && (
              <Link to="/forgot-password" className="mt-1 inline-block font-medium text-primary hover:underline">Request a new link</Link>
            )}
          </div>
        )}
        <Field label="New password" hint={`Minimum ${PASSWORD_MIN} characters.`}>
          <div className="relative">
            <Input type={type} value={password} onChange={(e) => onPassword(e.target.value)} autoComplete="new-password" className="pr-10" disabled={saving} />
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? 'Hide password' : 'Show password'}
              aria-pressed={visible}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-muted hover:text-ink"
            >
              {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </Field>
        <Field label="Confirm new password">
          <Input type={type} value={confirm} onChange={(e) => onConfirm(e.target.value)} autoComplete="new-password" disabled={saving} />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={saving}>{saving ? 'Saving…' : 'Reset password'}</Button>
        <p className="text-center text-body-sm text-ink-muted">
          <Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
