import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Role } from '../common/auth/permissions';
import { afterCursor, cursorTimestamp, type CursorPosition } from '../common/pagination/cursor';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { tenants, users, type UserRow } from '../database/schema';

export type NewUser = typeof users.$inferInsert;
export type UserPatch = Partial<Omit<NewUser, 'id' | 'tenantId' | 'createdAt'>>;

export interface PrincipalRow {
  id: string;
  tenantId: string;
  role: Role;
  status: 'active' | 'disabled';
  tokenVersion: number;
  tenantStatus: 'active' | 'suspended';
  tenantDeletedAt: Date | null;
}

export interface ListOptions {
  roles: Role[];
  limit: number;
  cursor?: CursorPosition;
  search?: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Every method takes the tenant id explicitly and filters on it: there is no way to read
 * or change a user without naming the tenant the caller is authorised for.
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findById(tenantId: string, id: string, tx: Executor = this.db): Promise<UserRow | undefined> {
    const [row] = await tx
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  async findByEmail(tenantId: string, email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  /** One indexed lookup per authenticated request: current role, status, token version, tenant state. */
  async findPrincipal(userId: string, tenantId: string): Promise<PrincipalRow | undefined> {
    const [row] = await this.db
      .select({
        id: users.id,
        tenantId: users.tenantId,
        role: users.role,
        status: users.status,
        tokenVersion: users.tokenVersion,
        tenantStatus: tenants.status,
        tenantDeletedAt: tenants.deletedAt,
      })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(and(eq(users.id, userId), eq(users.tenantId, tenantId), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  async insert(values: NewUser, tx: Executor = this.db): Promise<UserRow> {
    const [row] = await tx.insert(users).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async update(tenantId: string, id: string, patch: UserPatch, tx: Executor = this.db): Promise<UserRow | undefined> {
    const [row] = await tx
      .update(users)
      .set(patch)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id), isNull(users.deletedAt)))
      .returning();
    return row;
  }

  /** Atomically count a failure; on reaching the limit, lock the account and reset the counter. */
  async recordFailedLogin(tenantId: string, id: string, maxFailures: number, lockMinutes: number): Promise<void> {
    await this.db
      .update(users)
      .set({
        failedLoginCount: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${maxFailures}::int THEN 0
                                   ELSE ${users.failedLoginCount} + 1 END`,
        lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${maxFailures}::int
                              THEN now() + make_interval(mins => ${lockMinutes}::int)
                              ELSE ${users.lockedUntil} END`,
      })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)));
  }

  /**
   * Records the login and returns the updated row, so the caller does not read it back.
   *
   * Tenant-scoped like every other write here. The id today comes from a tenant-scoped lookup, so
   * this is defence in depth rather than a live hole — but it was the one write in this file that
   * could reach across a tenant boundary if a future caller got its id from somewhere less careful,
   * and the file's own contract says that must not be possible.
   */
  async recordSuccessfulLogin(tenantId: string, id: string, rehashed?: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .update(users)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: sql`now()`,
        ...(rehashed ? { passwordHash: rehashed } : {}),
      })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)))
      .returning();
    return row;
  }

  /** Invalidates every access token already issued to this user (checked on each request). */
  async bumpTokenVersion(tenantId: string, id: string, tx: Executor = this.db): Promise<void> {
    await tx
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)));
  }

  async list(tenantId: string, opts: ListOptions): Promise<Array<UserRow & { cursorTs: string }>> {
    const conditions: SQL[] = [eq(users.tenantId, tenantId), isNull(users.deletedAt), inArray(users.role, opts.roles)];
    if (opts.search) {
      const pattern = `%${escapeLike(opts.search)}%`;
      const match = or(ilike(users.email, pattern), ilike(users.displayName, pattern));
      if (match) conditions.push(match);
    }
    if (opts.cursor) conditions.push(afterCursor(users.createdAt, users.id, opts.cursor));
    const rows = await this.db
      .select({ user: users, cursorTs: cursorTimestamp(users.createdAt) })
      .from(users)
      .where(and(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(opts.limit + 1);
    return rows.map((r) => ({ ...r.user, cursorTs: r.cursorTs }));
  }
}
