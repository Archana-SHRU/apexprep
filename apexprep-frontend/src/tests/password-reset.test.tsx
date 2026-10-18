import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import App from '@/App'
import { AuthContext, type AuthCtx } from '@/hooks/useAuth'
import { ToastProvider } from '@/hooks/useToast'
import { ApiError, NetworkError } from '@/lib/http'
import { forgotPasswordError, readResetToken, requestPasswordReset, resetPassword, resetPasswordError } from '@/lib/password-reset'
import { ForgotPasswordView, type ForgotState } from '@/pages/ForgotPassword'
import { ResetPasswordView, type ResetState } from '@/pages/ResetPassword'
import { expect, runTests, test } from './harness'

/**
 * Forgot / reset password screens: routes on the real `App` tree, each visible state of both pages, and the
 * requests they send. Rendered on the server, like the other route tests, so what is checked is the real HTML.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const noop = () => undefined

function wrap(path: string, node: React.ReactNode): string {
  const ctx: AuthCtx = {
    session: null,
    student: null,
    restoring: false,
    login: async () => { throw new Error('not used') },
    signup: async () => undefined,
    completeOnboarding: async () => undefined,
    updateProfile: async () => undefined,
    reloadStudent: async () => undefined,
    logout: async () => undefined,
  }
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={ctx}>
        <ToastProvider>{node}</ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>,
  ).replace(/<!-- -->/g, '')
}
const route = (path: string) => wrap(path, <App />)
const forgotView = (state: ForgotState) => wrap('/forgot-password', <ForgotPasswordView state={state} email="asha@example.com" onEmail={noop} onSubmit={noop} onRetry={noop} />)
const resetView = (state: ResetState, hasToken = true) =>
  wrap('/reset-password', <ResetPasswordView hasToken={hasToken} state={state} password="" confirm="" onPassword={noop} onConfirm={noop} onSubmit={noop} />)

test('the student login page links to /forgot-password', () => {
  const html = route('/login')
  expect(html.includes('href="/forgot-password"') && html.includes('Forgot password?'), 'no "Forgot password?" link on the login page')
})

test('the forgot password page renders its form', () => {
  const html = route('/forgot-password')
  expect(html.includes('Forgot your password?'), 'heading missing')
  expect(html.includes('type="email"') && html.includes('Send reset link'), 'email form missing')
})

test('forgot password: the sent state is the same generic message for any address', () => {
  const html = forgotView({ kind: 'sent', email: 'asha@example.com' })
  expect(html.includes('If an account exists for') && html.includes('asha@example.com'), 'generic confirmation missing')
  expect(!/not found|no account|not registered/i.test(html), 'the confirmation reveals whether the account exists')
  expect(html.includes('href="/login"'), 'no way back to sign in')
})

test('forgot password: loading and error states', () => {
  const sending = forgotView({ kind: 'sending' })
  expect(sending.includes('Sending…') && /<button[^>]*disabled/.test(sending), 'sending state does not disable the form')
  const failed = forgotView({ kind: 'error', message: 'Too many requests. Wait a minute before trying again.' })
  expect(failed.includes('role="alert"') && failed.includes('Too many requests'), 'error state not shown')
})

test('the reset page reads the token from the link', () => {
  expect(readResetToken(`?token=${TOKEN}`) === TOKEN, 'a valid token was not read')
  expect(readResetToken('') === null && readResetToken('?token=short') === null && readResetToken(`?token=${TOKEN}x`) === null, 'a malformed token was accepted')
  const withToken = route(`/reset-password?token=${TOKEN}`)
  expect(withToken.includes('Choose a new password') && withToken.includes('autoComplete="new-password"'), 'form missing')
  expect(withToken.includes('aria-label="Show password"'), 'password visibility toggle missing')
  expect(!withToken.includes(TOKEN), 'the token was written into the page')
  for (const path of ['/reset-password', '/reset-password?token=short']) {
    const html = route(path)
    expect(html.includes('Reset link not valid') && html.includes('Request a new link'), `${path} did not explain the bad link`)
  }
})

test('reset password: success, error and loading states', () => {
  const done = resetView({ kind: 'done' })
  expect(done.includes('Password updated') && done.includes('Back to sign in'), 'success state missing the way back to sign in')
  expect(done.includes('signed out'), 'success state does not say other sessions were ended')
  const expired = resetView({ kind: 'error', message: resetPasswordError(new ApiError(422, 'TOKEN_INVALID', 'x')) })
  expect(expired.includes('role="alert"') && expired.includes('has expired') && expired.includes('href="/forgot-password"'), 'expired-link error missing its next step')
  const saving = resetView({ kind: 'saving' })
  expect(saving.includes('Saving…'), 'saving state missing')
})

test('error messages: never reveal accounts, and show password-policy detail', () => {
  expect(forgotPasswordError(new ApiError(429, 'RATE_LIMITED', 'x')).includes('Wait'), '429 not explained')
  expect(forgotPasswordError(new NetworkError(new Error('down'))).includes('reach the server'), 'network error not explained')
  const policy = resetPasswordError(new ApiError(400, 'VALIDATION_FAILED', 'x', [{ field: 'password', message: 'password must not be your email address' }]))
  expect(policy.includes('must not be your email address'), 'password policy detail lost')
  expect(resetPasswordError(new ApiError(400, 'VALIDATION_FAILED', 'x', [{ field: 'token', message: 'token is malformed' }])).includes('invalid'), 'malformed token not explained')
})

test('requests go to the documented endpoints with only the expected fields', async () => {
  const calls: { url: string; body: unknown }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) })
    const reply = String(url).endsWith('/forgot-password') ? { message: 'If an account exists…' } : { passwordReset: true }
    return new Response(JSON.stringify(reply), { status: String(url).endsWith('/forgot-password') ? 202 : 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await requestPasswordReset('asha@example.com')
    await resetPassword(TOKEN, 'a-new-password-1')
  } finally {
    globalThis.fetch = realFetch
  }
  expect(calls[0]!.url.endsWith('/v1/auth/forgot-password') && JSON.stringify(calls[0]!.body) === '{"email":"asha@example.com"}', 'forgot-password request wrong')
  expect(calls[1]!.url.endsWith('/v1/auth/reset-password') && JSON.stringify(calls[1]!.body) === JSON.stringify({ token: TOKEN, password: 'a-new-password-1' }), 'reset-password request wrong')
})

await runTests('password reset')
