import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import App from '@/App'
import { AuthContext, type AuthCtx } from '@/hooks/useAuth'
import { ToastProvider } from '@/hooks/useToast'
import { adminRouteDecision, isAdmin } from '@/lib/roles'
import type { UserDto } from '@/types/api'
import { expect, runTests, test } from './harness'

/**
 * The admin console's route protection, on the real `App` route tree.
 *
 * Each case renders the app at an admin URL with a session shaped exactly like the server's `/v1/auth/me` reply,
 * and checks what HTML comes out: the console (`Admin Console` is in its layout) must appear only for ADMIN and
 * SUPER_ADMIN. The backend refuses non-admins independently (test/e2e/admin-access.e2e-spec.ts); this proves the
 * UI never renders the console for them either — not even momentarily, since the server render is the first frame.
 */

const user = (role: UserDto['role']): UserDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  email: `${role.toLowerCase()}@example.test`,
  displayName: role,
  role,
  status: 'active',
  emailVerified: true,
  onboarded: role === 'STUDENT',
  primaryTrackId: null,
  goal: null,
  targetRank: null,
  dailyQuestionGoal: null,
  targetExamDate: null,
  focusTrackingOptOut: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
} as UserDto)

function render(path: string, session: UserDto | null | undefined, restoring = false): string {
  const noop = async () => undefined
  const ctx: AuthCtx = {
    session,
    student: null,
    restoring,
    login: async () => user('STUDENT'),
    signup: noop,
    completeOnboarding: noop,
    updateProfile: noop,
    reloadStudent: noop,
    logout: noop,
  }
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={ctx}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

const CONSOLE = 'Admin Console'
const ADMIN_URLS = ['/admin', '/admin/syllabus', '/admin/upload', '/admin/processing', '/admin/review', '/admin/questions', '/admin/students', '/admin/analytics']

test('CASE A: a signed-in STUDENT opening any admin URL gets "Not authorised", never the console', () => {
  for (const url of ADMIN_URLS) {
    const html = render(url, user('STUDENT'))
    expect(!html.includes(CONSOLE), `${url} rendered the admin console for a student`)
    expect(html.includes('Not authorised'), `${url} did not tell the student they are not authorised`)
  }
})

test('CASE C: ADMIN opening /admin gets the console', () => {
  const html = render('/admin', user('ADMIN'))
  expect(html.includes(CONSOLE), 'the admin console did not render for an ADMIN')
  expect(!html.includes('Not authorised'), 'an ADMIN was refused')
})

test('SUPER_ADMIN opening /admin gets the console', () => {
  expect(render('/admin/syllabus', user('SUPER_ADMIN')).includes(CONSOLE), 'the admin console did not render for a SUPER_ADMIN')
})

test('CASE F / CASE E: with no session (never signed in, or signed out) the console is not rendered and the route sends to login', () => {
  for (const url of ADMIN_URLS) expect(!render(url, null).includes(CONSOLE), `${url} rendered the console with no session`)
  expect(adminRouteDecision(null, false) === 'login', 'no session must be sent to login')
})

test('while the session is still being restored on a refresh, nothing of the console renders', () => {
  const html = render('/admin', undefined, true)
  expect(!html.includes(CONSOLE), 'the console rendered before the server confirmed the role')
  expect(adminRouteDecision(user('ADMIN'), true) === 'wait', 'the gate must wait for the server while restoring')
})

test('the role decision comes from the server role only', () => {
  expect(adminRouteDecision(user('STUDENT'), false) === 'denied', 'STUDENT must be denied')
  expect(adminRouteDecision(user('ADMIN'), false) === 'allow', 'ADMIN must be allowed')
  expect(adminRouteDecision(user('SUPER_ADMIN'), false) === 'allow', 'SUPER_ADMIN must be allowed')
  expect(!isAdmin({ role: 'admin' as UserDto['role'] }), 'role matching must be exact, not case-insensitive')
})

test('the student login page has no public link to the admin console', () => {
  const html = render('/login', null)
  expect(!html.includes('Open the admin console'), 'the student login page still links to the admin console')
  expect(!html.includes('href="/admin'), 'the student login page links to an admin URL')
})

test('the admin login page shows the sign-in form, not the console, to a signed-in student', () => {
  const html = render('/admin/login', user('STUDENT'))
  expect(html.includes('Sign in to console'), 'the admin sign-in form did not render')
  expect(!html.includes(CONSOLE), 'the admin login page exposed the console to a student')
})

await runTests('admin route protection')
