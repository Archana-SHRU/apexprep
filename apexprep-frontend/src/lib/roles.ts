import type { UserDto } from '@/types/api'

/**
 * Who may open the admin console, judged from the **server's** account record.
 *
 * `user` is always the object `/v1/auth/me` (or the login response) returned — never anything read from
 * `localStorage` or `sessionStorage` — so the role cannot be edited in the browser to open the console. And this
 * is only the UI gate: the backend refuses every `/v1/admin/*` request from a non-admin role with 403 regardless,
 * so a tampered client could at most render an empty shell that every request then fails.
 *
 * Mirrors `ADMIN_ROLES` in the backend's `src/common/auth/permissions.ts`.
 */
const ADMIN_ROLES: readonly UserDto['role'][] = ['ADMIN', 'SUPER_ADMIN']

export function isAdmin(user: Pick<UserDto, 'role'> | null | undefined): boolean {
  return Boolean(user && ADMIN_ROLES.includes(user.role))
}

/**
 * What the admin route does for the current session:
 * `wait` while the server is still being asked who this is (nothing of the console renders),
 * `login` when no one is signed in, `denied` for a signed-in non-admin, `allow` for an administrator.
 */
export type AdminRouteDecision = 'wait' | 'login' | 'denied' | 'allow'

export function adminRouteDecision(session: Pick<UserDto, 'role'> | null | undefined, restoring: boolean): AdminRouteDecision {
  if (restoring || session === undefined) return 'wait'
  if (session === null) return 'login'
  return isAdmin(session) ? 'allow' : 'denied'
}
