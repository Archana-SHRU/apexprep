import { ApiError, http, NetworkError } from '@/lib/http'

/**
 * Forgot / reset password against `POST /v1/auth/forgot-password` and `POST /v1/auth/reset-password`.
 *
 * The forgot-password answer is the same whether or not the address has an account, and the screens keep it
 * that way: they never say "no account found", so the form cannot be used to discover who is registered.
 */

/** The backend's own minimum, so the form does not promise something the server will reject. */
export const PASSWORD_MIN = 8

/** Shape of the token in a reset link: 43 URL-safe base64 characters (32 random bytes). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function requestPasswordReset(email: string): Promise<{ message: string }> {
  return http.post<{ message: string }>('/v1/auth/forgot-password', { email })
}

export function resetPassword(token: string, password: string): Promise<{ passwordReset: true }> {
  return http.post<{ passwordReset: true }>('/v1/auth/reset-password', { token, password })
}

/** The token from `?token=…`, or null when the link is missing it or it cannot be a real token. */
export function readResetToken(search: string): string | null {
  const token = new URLSearchParams(search).get('token')?.trim() ?? ''
  return TOKEN_PATTERN.test(token) ? token : null
}

export function forgotPasswordError(err: unknown): string {
  if (err instanceof NetworkError) return 'Could not reach the server. Check your connection and try again.'
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many requests. Wait a minute before trying again.'
    if (err.code === 'VALIDATION_FAILED') return 'Enter a valid email address.'
  }
  return 'Something went wrong. Please try again.'
}

export function resetPasswordError(err: unknown): string {
  if (err instanceof NetworkError) return 'Could not reach the server. Check your connection and try again.'
  if (err instanceof ApiError) {
    if (err.code === 'TOKEN_INVALID') return 'This reset link is invalid, has expired or has already been used. Request a new one.'
    if (err.status === 429) return 'Too many attempts. Wait a minute before trying again.'
    // Password-policy failures carry field-level messages written for a person.
    const fields = err.details.filter((d) => d.field === 'password').map((d) => d.message)
    if (fields.length > 0) return `The password was not accepted: ${fields.join(' ')}`
    if (err.code === 'VALIDATION_FAILED') return 'This reset link is invalid. Request a new one.'
  }
  return 'Something went wrong. Please try again.'
}
