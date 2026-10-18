import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button, Field, Input } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { ApiError, NetworkError } from '@/lib/http'

/** The backend's own minimum, so the form does not promise something the server will reject. */
const PASSWORD_MIN = 8

/**
 * Registration against `POST /v1/auth/register`.
 *
 * The account is real: it lands in `users` in the learner's organisation, and the response carries the tokens
 * that sign them straight in. The old version created nothing and simply moved to the next screen.
 */
export default function SignUp() {
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const { signup } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.email.includes('@') || form.password.length < PASSWORD_MIN) {
      toast({
        tone: 'error',
        title: 'Incomplete form',
        description: `Name, a valid email and a password of at least ${PASSWORD_MIN} characters are required.`,
      })
      return
    }
    setBusy(true)
    try {
      await signup(form.name.trim(), form.email.trim(), form.password)
      toast({ tone: 'success', title: 'Account created', description: 'Pick your track to finish setup.' })
      navigate('/onboarding')
    } catch (err) {
      toast({ tone: 'error', title: 'Could not create the account', description: registerError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Two minutes to set up, then straight into adaptive practice.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name"><Input value={form.name} onChange={set('name')} placeholder="Your name" autoComplete="name" /></Field>
        <Field label="Email"><Input type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" autoComplete="email" /></Field>
        <Field label="Password" hint={`Minimum ${PASSWORD_MIN} characters.`}>
          <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</Button>
        <p className="text-center text-body-sm text-ink-muted">
          Already registered? <Link to="/login" className="font-medium text-primary hover:underline">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  )
}

function registerError(err: unknown): string {
  if (err instanceof NetworkError) return 'Could not reach the server. Check that the backend is running.'
  if (err instanceof ApiError) {
    if (err.status === 409) return 'An account already exists for that email. Try signing in instead.'
    // 422 carries field-level detail written for a person; showing it beats a summary of it.
    if (err.status === 422 && err.details.length > 0) return err.details.map((d) => d.message).join(' ')
    return err.message
  }
  return 'Something went wrong. Please try again.'
}
