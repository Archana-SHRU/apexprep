import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthContext } from '../auth/auth-context';

export interface RequestStore {
  requestId: string;
  ip?: string;
  userAgent?: string;
  auth?: AuthContext;
}

const storage = new AsyncLocalStorage<RequestStore>();
const INCOMING_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Per-request context (request id, client ip/user-agent, principal) available to any
 * service without threading parameters — used by the audit writer and error logging.
 */
export const RequestContext = {
  get(): RequestStore | undefined {
    return storage.getStore();
  },
  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
  setAuth(auth: AuthContext): void {
    const store = storage.getStore();
    if (store) store.auth = auth;
  },
  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run(store, fn);
  },
};

/**
 * First middleware in the chain. Accepts a well-formed incoming X-Request-Id (so a
 * gateway's id is preserved), otherwise generates one, and echoes it on the response.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  const requestId = incoming && INCOMING_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  storage.run({ requestId, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 512) }, () => next());
}
