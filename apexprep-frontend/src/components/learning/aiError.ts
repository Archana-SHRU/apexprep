import { errorMessage } from '@/hooks/useApi'
import { ApiError } from '@/lib/http'

/**
 * What to tell the learner when a learning-AI request does not succeed.
 *
 * Every case is an ordinary state of a working system — no provider configured, the provider down, output
 * that failed the safety checks, nothing published to work from — and none of them affects the question or
 * the practice set the learner is in. The backend writes a specific sentence for the validation cases, so
 * that sentence is shown as written.
 */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'AI_NOT_CONFIGURED' || err.code === 'AI_PROVIDER_UNAVAILABLE' || err.status === 503) {
      return 'AI help is unavailable right now. Everything else keeps working — try again in a little while.'
    }
    if (err.code === 'AI_OUTPUT_REJECTED' || err.code === 'NO_SOURCE_CONTENT' || err.code === 'SCOPE_TOO_LARGE' || err.code === 'RATE_LIMITED') {
      return err.message
    }
  }
  return errorMessage(err instanceof Error ? err : new Error(String(err)))
}
