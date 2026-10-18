import type { Permission, Role } from './permissions';

/**
 * The authenticated principal for one request. Built only by JwtAuthGuard from a verified
 * access token **and** a fresh database lookup, so role, status and tenant are current.
 * Tenant scoping everywhere uses `tenantId` from here — never a tenant id from the request.
 */
export interface AuthContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly permissions: ReadonlySet<Permission>;
  readonly tokenVersion: number;
}

export function hasPermission(auth: AuthContext, permission: Permission): boolean {
  return auth.permissions.has(permission);
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
    requestId?: string;
  }
}
