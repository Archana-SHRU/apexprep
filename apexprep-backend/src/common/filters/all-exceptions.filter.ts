import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { asPgError, PG } from '../../database/pg-error';
import { AppException, type ErrorCode, type ErrorDetail } from '../errors/app-exception';
import { RequestContext } from '../request-context/request-context';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
}

interface Mapped {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

/**
 * Turns anything thrown into a safe, predictable body. Database errors never reach the
 * client verbatim (no SQL, constraint or column names); 5xx responses carry only a generic
 * message plus the request id, and the full error is logged server-side.
 */
export function mapException(exception: unknown): Mapped {
  if (exception instanceof AppException) {
    return {
      status: exception.getStatus(),
      body: { code: exception.code, message: exception.message, details: exception.details },
      headers: exception.headers,
    };
  }

  if (exception instanceof ThrottlerException) {
    return { status: 429, body: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL' : 'UNPROCESSABLE');
    if (status >= 500) return { status, body: { code: 'INTERNAL', message: 'An unexpected error occurred' } };
    const response = exception.getResponse();
    const raw =
      typeof response === 'string'
        ? response
        : (response as { message?: unknown }).message ?? exception.message;
    const message = Array.isArray(raw)
      ? 'Request validation failed'
      : typeof raw === 'string'
        ? raw
        : exception.message;
    const details = Array.isArray(raw) ? raw.map((m) => ({ message: String(m) })) : undefined;
    return { status, body: { code, message: status === 404 && message.startsWith('Cannot ') ? 'Route not found' : message, details } };
  }

  // Express body-parser errors (malformed JSON, oversize body) carry status/type fields.
  const bodyError = exception as { type?: unknown; status?: unknown };
  if (bodyError && typeof bodyError.type === 'string' && typeof bodyError.status === 'number') {
    if (bodyError.type === 'entity.too.large') {
      return { status: 413, body: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } };
    }
    if (bodyError.status === 400) {
      return { status: 400, body: { code: 'VALIDATION_FAILED', message: 'Request body is not valid JSON' } };
    }
  }

  const pg = asPgError(exception);
  if (pg) {
    switch (pg.code) {
      case PG.UNIQUE_VIOLATION:
        return { status: 409, body: { code: 'CONFLICT', message: 'A record with these values already exists' } };
      case PG.FOREIGN_KEY_VIOLATION:
        return { status: 422, body: { code: 'REFERENCE_NOT_FOUND', message: 'A referenced record does not exist' } };
      case PG.CHECK_VIOLATION:
      case PG.NOT_NULL_VIOLATION:
      case PG.INVALID_TEXT_REPRESENTATION:
      case PG.INVALID_CROSS_ROW_STATE:
        return { status: 422, body: { code: 'UNPROCESSABLE', message: 'The request violates a data rule' } };
      case PG.NOT_PUBLISHABLE:
        // Backstop only: the question service validates first and returns field details.
        return { status: 422, body: { code: 'NOT_PUBLISHABLE', message: 'The question does not meet the publishing rules' } };
      case PG.IMMUTABLE:
        return { status: 409, body: { code: 'IMMUTABLE_RECORD', message: 'This record cannot be changed' } };
      case PG.FOCUS_TRACKING_DISABLED:
        return { status: 409, body: { code: 'CONFLICT', message: 'Focus tracking is disabled for this session' } };
    }
  }

  return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { code: 'INTERNAL', message: 'An unexpected error occurred' } };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = RequestContext.requestId();
    const { status, body, headers } = mapException(exception);

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${requestId ?? '-'}] ${err.message}`, err.stack);
    } else {
      const pg = asPgError(exception);
      if (pg) this.logger.warn(`[${requestId ?? '-'}] db ${pg.code} ${pg.constraint ?? ''}`.trim());
    }

    if (res.headersSent) return;
    for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
    res.status(status).json({ error: { ...body, requestId } });
  }
}
