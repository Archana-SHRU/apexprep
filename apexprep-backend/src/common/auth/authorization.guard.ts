import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../errors/app-exception';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, ROLES_KEY, TENANT_SCOPED_KEY } from './decorators';
import { ADMIN_ROLES, type Permission, type Role } from './permissions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/v1/admin` or anything below it (any API version), judged from the path the router actually matched. */
const ADMIN_PATH = /^\/v\d+\/admin(?:\/|$)/i;

export function isAdminPath(req: Pick<Request, 'originalUrl' | 'url'>): boolean {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  // Collapse repeated slashes so "//v1//admin" cannot slip past the prefix match.
  return ADMIN_PATH.test(path.replace(/\/{2,}/g, '/'));
}

/**
 * Global guard, runs after JwtAuthGuard. Enforces, in order:
 *  0. /v1/admin/*              → 403 unless the caller's role is ADMIN or SUPER_ADMIN (a backstop
 *                                that holds even for an admin route missing its decorators)
 *  1. @Roles(...)              → 403 unless the caller's role is listed
 *  2. @RequirePermissions(...) → 403 unless the caller holds every permission
 *  3. @TenantScoped()          → 404 unless :tenantId is the caller's own tenant or the
 *                                caller holds tenants:manage (404, not 403, so other
 *                                tenants' ids are not confirmed to exist)
 * Routes with none of these only require authentication.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.auth;
    if (!auth) throw AppException.unauthenticated();

    // The admin surface is closed to non-admin roles by its path, not only by each route's decorators: a
    // route added under /admin without @RequirePermissions must fail closed, never open to every signed-in user.
    if (isAdminPath(req) && !ADMIN_ROLES.includes(auth.role)) throw AppException.forbidden();

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles?.length && !roles.includes(auth.role)) throw AppException.forbidden();

    // Class-level and method-level permission lists both apply.
    const required = [
      ...(this.reflector.get<Permission[] | undefined>(PERMISSIONS_KEY, context.getClass()) ?? []),
      ...(this.reflector.get<Permission[] | undefined>(PERMISSIONS_KEY, context.getHandler()) ?? []),
    ];
    if (required.some((p) => !auth.permissions.has(p))) throw AppException.forbidden();

    if (this.reflector.getAllAndOverride<boolean>(TENANT_SCOPED_KEY, targets)) {
      const tenantId = req.params?.tenantId;
      if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw AppException.notFound();
      if (tenantId !== auth.tenantId && !auth.permissions.has('tenants:manage')) throw AppException.notFound();
    }
    return true;
  }
}
