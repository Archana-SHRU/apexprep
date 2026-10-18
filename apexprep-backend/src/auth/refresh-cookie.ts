import type { CookieOptions, Response } from 'express';
import type { Env } from '../config/env.schema';

export const REFRESH_COOKIE = 'apx_refresh';
/** Scoped to the auth routes, so the refresh token isn't sent with every API request. */
export const REFRESH_COOKIE_PATH = '/v1/auth';

type CookieConfig = Pick<Env, 'REFRESH_COOKIE_SECURE' | 'REFRESH_COOKIE_SAMESITE'>;

function baseOptions(config: CookieConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.REFRESH_COOKIE_SECURE,
    sameSite: config.REFRESH_COOKIE_SAMESITE,
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, token: string, maxAgeSeconds: number, config: CookieConfig): void {
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions(config), maxAge: maxAgeSeconds * 1000 });
}

export function clearRefreshCookie(res: Response, config: CookieConfig): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions(config));
}
