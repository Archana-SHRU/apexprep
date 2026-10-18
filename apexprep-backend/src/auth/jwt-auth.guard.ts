import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../common/auth/decorators';
import { AppException } from '../common/errors/app-exception';
import { RequestContext } from '../common/request-context/request-context';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * Global guard: every route requires a valid access token unless marked @Public().
 * Beyond verifying the JWT, it re-reads the user and tenant, so a disabled user, a
 * suspended tenant, a logout-all (token_version bump) or a forged tenant claim is rejected
 * immediately rather than when the token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.get('authorization');
    if (!header) throw AppException.unauthenticated('Missing access token');
    const match = BEARER.exec(header);
    if (!match?.[1]) throw AppException.unauthenticated('Access token is invalid', 'TOKEN_INVALID');

    const claims = this.tokens.verifyAccessToken(match[1]);
    const principal = await this.auth.loadPrincipal(claims.userId, claims.tenantId, claims.tokenVersion);
    if (!principal) throw AppException.unauthenticated('Session is no longer valid', 'TOKEN_INVALID');

    req.auth = principal;
    RequestContext.setAuth(principal);
    return true;
  }
}
