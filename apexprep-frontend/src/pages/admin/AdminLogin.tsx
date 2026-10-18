import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { isAdmin } from '@/lib/roles'
import { ShieldCheck } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button, Field, Input } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { signInError } from '@/pages/Login'

/**
 * Administrator sign-in.
 *
 * The same real `POST /v1/auth/login` as the student form — there is one account system, and the role comes from
 * the account, not from which page was used. The old version pre-filled `admin@apexprep.io` / `admin1234`, passed
 * `'admin'` as a *parameter* to a login that ignored passwords entirely, and let anyone into the console.
 *
 * Only an administrator account gets through. The role is the one the server returned for the credentials; an
 * account without it is refused here and signed straight back out (its refresh token revoked), so a student can
 * never leave this page holding a console session. The backend independently answers 403 to every
 * `/v1/admin/*` request from a non-admin role, so this is a courtesy, not the protection.
 */
export default function AdminLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const { login, logout, session } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  // An administrator who is already signed in goes straight to the console.
  if (isAdmin(session)) return <Navigate to="/admin" replace />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      toast({ tone: 'error', title: 'Missing details', description: 'Enter your email and password.' })
      return
    }
    setBusy(true)
    try {
      const user = await login(email.trim(), password)
      if (!isAdmin(user)) {
        await logout()
        toast({ tone: 'error', title: 'Not an administrator account', description: 'This console is for administrators only. Students sign in on the student page.' })
        return
      }
      navigate('/admin')
    } catch (err) {
      toast({ tone: 'error', title: 'Could not sign in', description: signInError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Admin console" subtitle="Content ingestion, review and platform operations."
      aside={<div className="max-w-md">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <h2 className="mt-3 text-headline-lg text-ink">Restricted access</h2>
        <p className="mt-2 text-body-md text-ink-muted">This console manages the question bank and student records. Every action is recorded in the audit log.</p>
      </div>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Admin email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to console'}</Button>
        <p className="text-center text-body-sm text-ink-muted">Student? <Link to="/login" className="font-medium text-primary hover:underline">Go to student login</Link></p>
      </form>
    </AuthLayout>
  )
}
