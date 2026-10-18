/**
 * Role → permission map: the single place authorization policy lives.
 * Controllers declare what they need with @RequirePermissions(...); they never compare
 * role strings themselves. Changing who may do what is a one-line edit here.
 */
export const ROLES = ['STUDENT', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // any signed-in user
  'syllabus:read',
  // student self-service
  'self:profile',
  'practice:use',
  'analytics:own',
  'reports:own',
  // tenant administration
  'content:manage',
  'questions:manage',
  'review:manage',
  'students:read',
  'students:manage',
  'reports:tenant',
  'engine_config:read',
  'engine_config:manage',
  'audit:read',
  // platform administration (cross-tenant)
  'staff:manage',
  'tenants:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STUDENT: readonly Permission[] = ['syllabus:read', 'self:profile', 'practice:use', 'analytics:own', 'reports:own'];

const ADMIN: readonly Permission[] = [
  'syllabus:read',
  'content:manage',
  'questions:manage',
  'review:manage',
  'students:read',
  'students:manage',
  'reports:tenant',
  'engine_config:read',
  'audit:read',
];

// Default (DECISIONS.md §B15): changing adaptive-engine parameters and managing staff
// accounts are platform-level powers; a tenant ADMIN can read the engine config but not
// change it. Move 'engine_config:manage' into ADMIN above to delegate it to tenants.
const SUPER_ADMIN: readonly Permission[] = [...ADMIN, 'engine_config:manage', 'staff:manage', 'tenants:manage'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  STUDENT: new Set(STUDENT),
  ADMIN: new Set(ADMIN),
  SUPER_ADMIN: new Set(SUPER_ADMIN),
};

/**
 * The roles that may reach the admin surface (`/v1/admin/*`) at all. Enforced as a backstop by the global
 * AuthorizationGuard on top of each admin route's own permissions, so an admin route that forgot its
 * `@RequirePermissions` is still closed to students rather than open to any signed-in user.
 */
export const ADMIN_ROLES: readonly Role[] = ['ADMIN', 'SUPER_ADMIN'];

export function permissionsFor(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
