import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../errors/app-exception';
import type { AuthContext } from './auth-context';
import type { Permission, Role } from './permissions';

export const IS_PUBLIC_KEY = 'apexprep:isPublic';
export const PERMISSIONS_KEY = 'apexprep:permissions';
export const ROLES_KEY = 'apexprep:roles';
export const TENANT_SCOPED_KEY = 'apexprep:tenantScoped';
export const AUTH_RATE_LIMIT_KEY = 'apexprep:authRateLimit';

/** Route needs no access token. Everything else is authenticated by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Caller must hold every listed permission (see common/auth/permissions.ts). */
export const RequirePermissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Caller's role must be one of these. Prefer RequirePermissions; this exists for coarse gates. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/**
 * Route has a `:tenantId` path parameter. The caller may use it only for their own tenant,
 * unless they hold `tenants:manage`. Anything else answers 404 so tenant ids don't leak.
 */
export const TenantScoped = (): MethodDecorator & ClassDecorator => SetMetadata(TENANT_SCOPED_KEY, true);

/** Apply the stricter authentication rate limit (AUTH_THROTTLE_LIMIT) to this route. */
export const AuthRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(AUTH_RATE_LIMIT_KEY, true);

/** Injects the AuthContext set by JwtAuthGuard. */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw AppException.unauthenticated();
  return req.auth;
});
