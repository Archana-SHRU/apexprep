import type { ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui'
import { adminRouteDecision, isAdmin } from '@/lib/roles'
import { StudentLayout } from '@/layouts/StudentLayout'
import { AdminLayout } from '@/layouts/AdminLayout'
import { PageSkeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/hooks/useAuth'

import Login from '@/pages/Login'
import SignUp from '@/pages/SignUp'
import ForgotPassword from '@/pages/ForgotPassword'
import ResetPassword from '@/pages/ResetPassword'
import Onboarding from '@/pages/Onboarding'
import Dashboard from '@/pages/Dashboard'
import Learn from '@/pages/Learn'
import SubjectView from '@/pages/SubjectView'
import ChapterView from '@/pages/ChapterView'
import Theory from '@/pages/Theory'
import PracticeHub from '@/pages/PracticeHub'
import Practice from '@/pages/Practice'
import Tests from '@/pages/Tests'
import TestRunner from '@/pages/TestRunner'
import TestResult from '@/pages/TestResult'
import Analytics from '@/pages/Analytics'
import Reports from '@/pages/Reports'
import Profile from '@/pages/Profile'

import AdminLogin from '@/pages/admin/AdminLogin'
import AdminDashboard from '@/pages/admin/AdminDashboard'
import ContentUpload from '@/pages/admin/ContentUpload'
import AdminSyllabus from '@/pages/admin/Syllabus'
import ContentProcessing from '@/pages/admin/ContentProcessing'
import ContentReview from '@/pages/admin/ContentReview'
import QuestionBank from '@/pages/admin/QuestionBank'
import StudentManagement from '@/pages/admin/StudentManagement'
import AdminAnalytics from '@/pages/admin/AdminAnalytics'

/**
 * Routes, with real sign-in guards.
 *
 * There were no guards before, because there was no real session: any URL rendered, signed in or not. Now the
 * app asks the server who the visitor is on load, so `RequireAuth` waits for that answer before deciding —
 * redirecting while the session is still being restored would bounce a signed-in learner to the login page on
 * every refresh.
 *
 * A learner who has not finished onboarding is sent to it, and one who has is kept out of it, so the flow cannot
 * be skipped or repeated by typing a URL.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<RedirectIfSignedIn><Login /></RedirectIfSignedIn>} />
      <Route path="/signup" element={<RedirectIfSignedIn><SignUp /></RedirectIfSignedIn>} />
      <Route path="/forgot-password" element={<RedirectIfSignedIn><ForgotPassword /></RedirectIfSignedIn>} />
      {/* Not behind RedirectIfSignedIn: a reset link must work even in a tab that is still signed in. */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/onboarding" element={<RequireAuth requireOnboarded={false}><Onboarding /></RequireAuth>} />

      <Route element={<RequireAuth><StudentLayout /></RequireAuth>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/learn" element={<Learn />} />
        <Route path="/learn/:subjectId" element={<SubjectView />} />
        <Route path="/learn/:subjectId/:chapterId" element={<ChapterView />} />
        <Route path="/theory/:theoryId" element={<Theory />} />
        <Route path="/practice" element={<PracticeHub />} />
        <Route path="/practice/:subTopicId" element={<Practice />} />
        <Route path="/tests" element={<Tests />} />
        <Route path="/tests/:testId" element={<TestRunner />} />
        <Route path="/tests/:testId/result" element={<TestResult />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/profile" element={<Profile />} />
      </Route>

      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
        <Route index element={<AdminDashboard />} />
        <Route path="syllabus" element={<AdminSyllabus />} />
        <Route path="upload" element={<ContentUpload />} />
        <Route path="processing" element={<ContentProcessing />} />
        <Route path="review" element={<ContentReview />} />
        <Route path="questions" element={<QuestionBank />} />
        <Route path="students" element={<StudentManagement />} />
        <Route path="analytics" element={<AdminAnalytics />} />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}

/**
 * Gate for anything that needs a signed-in learner.
 *
 * `session === undefined` means the restore request is still in flight; the skeleton holds the place rather than
 * the router making a decision it would have to undo a moment later.
 */
function RequireAuth({ children, requireOnboarded = true }: { children: ReactNode; requireOnboarded?: boolean }) {
  const { session, restoring } = useAuth()
  const location = useLocation()

  if (restoring || session === undefined) return <PageSkeleton />
  // `state.from` lets the login page send them back where they were headed.
  if (session === null) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (requireOnboarded && !session.onboarded) return <Navigate to="/onboarding" replace />
  return <>{children}</>
}

/**
 * Gate for the admin console: an ADMIN or SUPER_ADMIN account, as the server reports it.
 *
 * Nothing of the console renders until this has decided — no layout, no navigation, no page that would start
 * fetching — and the decision is taken from `session`, which is the server's `/v1/auth/me` answer restored on
 * every page load, never from browser storage. A refresh therefore re-checks the role against the server.
 *
 * This is the UI half only. The backend refuses every `/v1/admin/*` request from a non-admin with 403 on its
 * own, so even a client that skipped this gate would get no admin data.
 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, restoring } = useAuth()
  const location = useLocation()

  switch (adminRouteDecision(session, restoring)) {
    case 'wait':
      return <PageSkeleton />
    case 'login':
      return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />
    case 'denied':
      return <NotAuthorised />
    case 'allow':
      return <>{children}</>
  }
}

/** What a signed-in learner sees at an admin URL: a plain refusal, with the console itself never rendered. */
function NotAuthorised() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-deck p-6">
      <div className="max-w-md space-y-4 text-center">
        <ShieldAlert className="mx-auto h-8 w-8 text-deficit" />
        <h1 className="text-headline-lg text-ink">Not authorised</h1>
        <p className="text-body-md text-ink-muted">The admin console is only available to administrator accounts. Your account does not have access to it.</p>
        <Link to="/dashboard"><Button>Back to your dashboard</Button></Link>
      </div>
    </div>
  )
}

/** Keeps a signed-in user out of the sign-in and sign-up pages, sending each to their own home. */
function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { session, restoring } = useAuth()
  if (restoring || session === undefined) return <PageSkeleton />
  if (session) return <Navigate to={isAdmin(session) ? '/admin' : session.onboarded ? '/dashboard' : '/onboarding'} replace />
  return <>{children}</>
}
