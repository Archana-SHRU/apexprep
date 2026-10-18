import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable error codes. Every error body is
 *   { "error": { "code", "message", "details"?, "requestId" } }
 * so the frontend can switch on `code` instead of parsing messages.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'ACCOUNT_DISABLED'
  | 'EMAIL_NOT_VERIFIED'
  | 'FORBIDDEN'
  | 'ORIGIN_NOT_ALLOWED'
  | 'REGISTRATION_CLOSED'
  | 'NOT_FOUND'
  | 'TENANT_NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'SLUG_TAKEN'
  /** The same source PDF has already been uploaded to this organisation (SHA-256 match). */
  | 'DUPLICATE'
  | 'NODE_NOT_EMPTY'
  | 'INVALID_STATE'
  /** A mock-test session is closed: answers and timing can no longer change. */
  | 'SESSION_CLOSED'
  /** The mock test's deadline has passed; the session was closed and graded. */
  | 'TIME_EXPIRED'
  /** Reopening a test whose deadline passed: details carry the closed session's id, whose result is available. */
  | 'SESSION_EXPIRED'
  /** An Idempotency-Key already used for a *different* answer: a fresh key is needed per answer. */
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'NOT_PUBLISHABLE'
  | 'ENGINE_CONFIG_MISSING'
  | 'ENGINE_CONFIG_INVALID'
  | 'SESSION_PAUSED'
  | 'NO_ELIGIBLE_QUESTIONS'
  | 'EXPLANATION_UNAVAILABLE'
  | 'AI_NOT_CONFIGURED'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'UNPROCESSABLE'
  | 'REFERENCE_NOT_FOUND'
  | 'IMMUTABLE_RECORD'
  | 'RATE_LIMITED'
  | 'TOO_MANY_ATTEMPTS'
  | 'PAYLOAD_TOO_LARGE'
  /** A new syllabus name approved from an upload does not appear in that upload's text. */
  | 'NAME_NOT_GROUNDED'
  /** A learning-AI request found no published source content to work from. */
  | 'NO_SOURCE_CONTENT'
  /** The requested scope holds more source content than one bounded request may process. */
  | 'SCOPE_TOO_LARGE'
  /** The provider answered, but its output failed validation (grounding, leakage, shape). */
  | 'AI_OUTPUT_REJECTED'
  | 'INTERNAL';

export interface ErrorDetail {
  field?: string;
  message: string;
}

export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
    readonly headers?: Record<string, string>,
  ) {
    super({ code, message, details }, status);
  }

  static unauthenticated(message = 'Authentication required', code: ErrorCode = 'UNAUTHENTICATED'): AppException {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(message = 'You do not have permission to do this', code: ErrorCode = 'FORBIDDEN'): AppException {
    return new AppException(HttpStatus.FORBIDDEN, code, message);
  }

  static notFound(message = 'Not found', code: ErrorCode = 'NOT_FOUND'): AppException {
    return new AppException(HttpStatus.NOT_FOUND, code, message);
  }

  static conflict(message: string, code: ErrorCode = 'CONFLICT'): AppException {
    return new AppException(HttpStatus.CONFLICT, code, message);
  }

  static unprocessable(message: string, code: ErrorCode = 'UNPROCESSABLE', details?: ErrorDetail[]): AppException {
    return new AppException(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
  }

  static validation(details: ErrorDetail[]): AppException {
    return new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Request validation failed', details);
  }

  /** A dependency this feature needs is not configured or not reachable right now. */
  static unavailable(message: string, code: ErrorCode = 'AI_PROVIDER_UNAVAILABLE'): AppException {
    return new AppException(HttpStatus.SERVICE_UNAVAILABLE, code, message);
  }
}
