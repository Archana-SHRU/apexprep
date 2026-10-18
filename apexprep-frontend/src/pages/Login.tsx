import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button, Field, Input } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { ApiError, NetworkError } from '@/lib/http'

/**
 * Signing in against `POST /v1/auth/login`.
 *
 * The fields start empty. They used to arrive pre-filled with a demo address and the password `demo1234`,
 * which was harmless while nothing was checked and is not harmless now: a real credential pair in a real form
 * invites reuse, and a password in the source is a password in the bundle.
 *
 * The backend decides the outcome. A wrong password fails here, which it never did before.
 */
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const { login } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      toast({ tone: 'error', title: 'Missing details', description: 'Enter your email and password.' })
      return
    }
    setBusy(true)
    try {
      await login(email.trim(), password)
      toast({ tone: 'success', title: 'Welcome back' })
      navigate('/dashboard')
    } catch (err) {
      toast({ tone: 'error', title: 'Could not sign in', description: signInError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Sign in to ApexPrep" subtitle="Resume your adaptive practice where you left off.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <p className="-mt-2 text-right text-body-sm">
          <Link to="/forgot-password" className="font-medium text-primary hover:underline">Forgot password?</Link>
        </p>
        <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <p className="text-center text-body-sm text-ink-muted">
          New here? <Link to="/signup" className="font-medium text-primary hover:underline">Create an account</Link>
        </p>
        {/* No public link to the admin console: administrators sign in at /admin/login, which accepts admin accounts only. */}
      </form>
    </AuthLayout>
  )
}

/**
 * What to tell someone whose sign-in failed.
 *
 * Wrong email and wrong password are deliberately not distinguished — the backend answers the same way for
 * both, so that an attacker cannot use the form to discover which addresses have accounts. The message here
 * follows that, rather than guessing at which half was wrong.
 */
export function signInError(err: unknown): string {
  if (err instanceof NetworkError) return 'Could not reach the server. Check that the backend is running.'
  if (err instanceof ApiError) {
    if (err.status === 401) return 'That email and password do not match an account.'
    if (err.status === 403 && err.code === 'ACCOUNT_DISABLED') return 'This account has been disabled. Contact your administrator.'
    if (err.status === 429) return 'Too many attempts. Wait a moment before trying again.'
    return err.message
  }
  return 'Something went wrong. Please try again.'
}
