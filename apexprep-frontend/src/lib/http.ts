/**
 * The one place the app talks to the network.
 *
 * Every call to the backend goes through `request()`, so the base URL, the access token, JSON parsing,
 * error shaping and token refresh each exist exactly once. No component builds a URL or reads a header.
 *
 * The backend's error envelope is always `{ error: { code, message, details?, requestId } }`, so an
 * `ApiError` carries the real `code` from the server rather than a guess made from the status. Screens
 * switch on `code` where the backend distinguishes cases (`IDEMPOTENCY_KEY_REUSED`, `AI_NOT_CONFIGURED`,
 * `NO_ELIGIBLE_QUESTIONS`, …) and on `status` where it does not.
 */

/**
 * Set in `.env` / `.env.local`; falls back to the backend's own default port for a local run.
 *
 * `import.meta.env?` rather than `import.meta.env`: Vite always defines it, but this module is also loaded
 * outside Vite by the verification harness, where it does not exist. One optional chain keeps the module
 * testable under plain Node instead of throwing on import.
 */
const rawBase = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.trim();
const BASE_URL: string = rawBase ? rawBase.replace(/\/$/, '') : (typeof window !== 'undefined' ? '' : 'http://localhost:3000');

/** The backend's error body. */
interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: { field?: string; message: string }[]; requestId?: string };
}

/**
 * A failed request, with everything a screen needs to react.
 *
 * `code` is the backend's own error code and is the thing to switch on. `status` is there for the cases
 * the backend does not give a distinct code — notably `GET /v1/questions/:id/explanation`, which answers a
 * bare 403 when the learner has not attempted the question yet.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { field?: string; message: string }[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server said the caller is not signed in (as opposed to not permitted). */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

/** Raised when the browser could not reach the API at all — a different problem from a 4xx. */
export class NetworkError extends Error {
  /**
   * The underlying `fetch` rejection.
   *
   * Named `reason` rather than assigned to `Error.cause`: `cause` is an ES2022 addition and this project compiles
   * against the ES2020 lib, so writing to it would not type-check. The value is the same thing.
   */
  readonly reason: unknown;

  constructor(reason: unknown) {
    super('Could not reach the API. Is the backend running?');
    this.name = 'NetworkError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- the access token

/**
 * The access token lives in memory, with a `sessionStorage` copy so a page reload does not sign the
 * learner out.
 *
 * The **refresh** token is never touched here: the backend sets it as an HttpOnly `apx_refresh` cookie,
 * which JavaScript cannot read by design. That is why every request sends `credentials: 'include'` — the
 * browser attaches the cookie itself, and the refresh token never passes through this code.
 *
 * `sessionStorage` rather than `localStorage`: it is scoped to the tab and cleared when the tab closes,
 * so a shared machine does not keep a signed-in session lying around.
 */
const TOKEN_KEY = 'apexprep.accessToken';
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode): the in-memory copy still works for this page */
  }
}

export function getAccessToken(): string | null {
  if (accessToken) return accessToken;
  try {
    accessToken = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    accessToken = null;
  }
  return accessToken;
}

/** Called when a refresh fails, so the app can send the learner to /login exactly once. */
let onSessionLost: (() => void) | null = null;
export function setSessionLostHandler(fn: (() => void) | null): void {
  onSessionLost = fn;
}

// ---------------------------------------------------------------- requests

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Extra headers; `Idempotency-Key` for attempts is the only current use. */
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * A binary body sent as-is with its own content type — the PDF upload, which the backend takes as the raw
   * request body rather than multipart. Mutually exclusive with `body`.
   */
  raw?: { data: Blob | ArrayBuffer; contentType: string };
  /** Return the response as a Blob (an image) instead of parsing JSON. */
  asBlob?: boolean;
  /** Internal: prevents a refresh loop when the refresh call itself 401s. */
  skipRefresh?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = BASE_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
  const url = new URL(`${base}${normalizedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** One in-flight refresh at a time, so a burst of 401s does not fire a burst of refreshes. */
let refreshing: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(buildUrl('/v1/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken?: string };
      if (!data.accessToken) return false;
      setAccessToken(data.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so concurrent callers all see the same result first.
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

/**
 * Endpoints where a 401 is the answer, not a stale token.
 *
 * A wrong password on `/auth/login` is a 401 that means "those credentials are wrong". Trying to refresh after
 * it is pointless — there is no session to refresh — and it costs the learner an extra failed request, and the
 * log an extra confusing 401, every time they mistype a password.
 */
const NO_REFRESH = ['/v1/auth/login', '/v1/auth/register', '/v1/auth/refresh', '/v1/auth/logout'];

/**
 * Performs a request and returns the parsed body.
 *
 * On a 401 it tries **one** refresh and replays the request. If the refresh fails the session is lost, the
 * handler fires, and the original error is thrown — the caller is never handed mock data or a silent empty
 * result in place of a real failure.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, query, raw } = options;
  const skipRefresh = options.skipRefresh ?? NO_REFRESH.some((p) => path.startsWith(p));

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      // The refresh cookie rides on this. The backend must list the app's origin in CORS_ORIGINS.
      credentials: 'include',
      headers: {
        ...(raw ? { 'content-type': raw.contentType } : body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(getAccessToken() ? { authorization: `Bearer ${getAccessToken()!}` } : {}),
        ...headers,
      },
      body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(err);
  }

  if (res.status === 401 && !skipRefresh) {
    if (await refreshOnce()) return request<T>(path, { ...options, skipRefresh: true });
    setAccessToken(null);
    onSessionLost?.();
  }

  if (res.status === 204) return undefined as T;
  if (options.asBlob && res.ok) return (await res.blob()) as T;

  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();

  if (contentType.includes('text/html') || text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
    throw new ApiError(
      res.status,
      'HTML_RESPONSE_NOT_API',
      'The API endpoint returned HTML instead of JSON. Ensure VITE_API_BASE_URL is configured in your deployment to point to your backend API URL.',
    );
  }

  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-JSON body from a proxy or a crash: surfaced as an error rather than guessed at.
      throw new ApiError(res.status, 'UNEXPECTED_RESPONSE', text.slice(0, 200));
    }
  }

  if (!res.ok) {
    const envelope = (parsed ?? {}) as ErrorEnvelope;
    throw new ApiError(
      res.status,
      envelope.error?.code ?? `HTTP_${res.status}`,
      envelope.error?.message ?? `Request failed with status ${res.status}`,
      envelope.error?.details ?? [],
      envelope.error?.requestId,
    );
  }

  return parsed as T;
}

export const http = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>(path, { method: 'POST', body, headers }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** An authenticated binary download (an image the API serves behind the access token). */
  getBlob: (path: string) => request<Blob>(path, { method: 'GET', asBlob: true }),
  /** A raw binary upload, with the content type and any extra headers the endpoint expects. */
  postRaw: <T>(path: string, data: Blob | ArrayBuffer, contentType: string, query?: RequestOptions['query'], headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', raw: { data, contentType }, query, headers }),
};

export const apiBaseUrl = BASE_URL;
