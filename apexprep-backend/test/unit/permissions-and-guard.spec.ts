import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppException } from '../../src/common/errors/app-exception';
import type { AuthContext } from '../../src/common/auth/auth-context';
import { AuthorizationGuard } from '../../src/common/auth/authorization.guard';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, ROLES_KEY, TENANT_SCOPED_KEY } from '../../src/common/auth/decorators';
import { PERMISSIONS, permissionsFor, ROLE_PERMISSIONS, type Permission, type Role } from '../../src/common/auth/permissions';

describe('role → permission policy', () => {
  it('keeps students to self-service', () => {
    expect([...permissionsFor('STUDENT')].sort()).toEqual(['analytics:own', 'practice:use', 'reports:own', 'self:profile', 'syllabus:read']);
  });

  it('gives admins tenant administration but not platform powers', () => {
    const admin = permissionsFor('ADMIN');
    for (const p of ['syllabus:read', 'content:manage', 'questions:manage', 'review:manage', 'students:read', 'students:manage', 'reports:tenant', 'engine_config:read'] as Permission[]) {
      expect(admin.has(p)).toBe(true);
    }
    for (const p of ['tenants:manage', 'staff:manage', 'engine_config:manage', 'self:profile', 'practice:use'] as Permission[]) {
      expect(admin.has(p)).toBe(false);
    }
  });

  it('makes super admin a superset of admin plus platform powers', () => {
    const superAdmin = permissionsFor('SUPER_ADMIN');
    for (const p of permissionsFor('ADMIN')) expect(superAdmin.has(p)).toBe(true);
    expect(superAdmin.has('tenants:manage')).toBe(true);
  });

  it('assigns every declared permission to at least one role', () => {
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]));
    expect(PERMISSIONS.filter((p) => !granted.has(p))).toEqual([]);
  });
});

describe('AuthorizationGuard', () => {
  const TENANT = '6f1c2c1e-0000-4000-8000-00000000000a';
  const OTHER = '6f1c2c1e-0000-4000-8000-00000000000b';
  const auth = (role: Role, tenantId = TENANT): AuthContext => ({ userId: 'u', tenantId, role, permissions: permissionsFor(role), tokenVersion: 0 });

  function run(meta: Record<string, unknown>, req: { auth?: AuthContext; params?: Record<string, string> }): 'allowed' | number {
    const handler = () => undefined;
    class Controller {}
    for (const [key, value] of Object.entries(meta)) Reflect.defineMetadata(key, value, handler);
    const context = {
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    try {
      new AuthorizationGuard(new Reflector()).canActivate(context);
      return 'allowed';
    } catch (e) {
      return (e as AppException).getStatus();
    }
  }

  it('lets public routes through without a principal', () => {
    expect(run({ [IS_PUBLIC_KEY]: true }, {})).toBe('allowed');
  });

  it('requires a principal otherwise', () => {
    expect(run({}, {})).toBe(401);
  });

  it('enforces permissions and roles with 403', () => {
    expect(run({ [PERMISSIONS_KEY]: ['students:read'] }, { auth: auth('STUDENT') })).toBe(403);
    expect(run({ [PERMISSIONS_KEY]: ['students:read'] }, { auth: auth('ADMIN') })).toBe('allowed');
    expect(run({ [ROLES_KEY]: ['SUPER_ADMIN'] }, { auth: auth('ADMIN') })).toBe(403);
  });

  it('scopes :tenantId to the caller unless they manage tenants (404 hides other tenants)', () => {
    const scoped = { [TENANT_SCOPED_KEY]: true };
    expect(run(scoped, { auth: auth('ADMIN'), params: { tenantId: TENANT } })).toBe('allowed');
    expect(run(scoped, { auth: auth('ADMIN'), params: { tenantId: OTHER } })).toBe(404);
    expect(run(scoped, { auth: auth('SUPER_ADMIN'), params: { tenantId: OTHER } })).toBe('allowed');
    expect(run(scoped, { auth: auth('SUPER_ADMIN'), params: { tenantId: 'not-a-uuid' } })).toBe(404);
  });
});

describe('AuthorizationGuard — the admin surface backstop', () => {
  const auth = (role: Role): AuthContext => ({ userId: 'u', tenantId: 't', role, permissions: permissionsFor(role), tokenVersion: 0 });
  /** A route with NO decorators at all: only the path-level rule stands between it and the caller. */
  function run(role: Role, originalUrl: string): 'allowed' | number {
    const handler = () => undefined;
    class Controller {}
    const req = { auth: auth(role), originalUrl, url: originalUrl };
    const context = {
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    try {
      new AuthorizationGuard(new Reflector()).canActivate(context);
      return 'allowed';
    } catch (e) {
      return (e as AppException).getStatus();
    }
  }

  it('refuses a student on an admin path even when the route forgot its permissions', () => {
    for (const url of ['/v1/admin', '/v1/admin/', '/v1/admin/tracks', '/v1/admin/ingestion/jobs?x=1', '/V1/ADMIN/students', '//v1//admin/tracks', '/v2/admin/anything']) {
      expect(run('STUDENT', url)).toBe(403);
    }
  });

  it('lets ADMIN and SUPER_ADMIN reach the admin surface (their permissions still apply per route)', () => {
    expect(run('ADMIN', '/v1/admin/tracks')).toBe('allowed');
    expect(run('SUPER_ADMIN', '/v1/admin/tenants')).toBe('allowed');
  });

  it('does not touch non-admin paths, or paths that merely start with the same letters', () => {
    for (const url of ['/v1/practice/sessions', '/v1/tracks', '/v1/administrator', '/v1/me/admin-notes']) {
      expect(run('STUDENT', url)).toBe('allowed');
    }
  });
});
