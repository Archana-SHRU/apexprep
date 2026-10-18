import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../common/auth/auth-context';
import type { Role } from '../common/auth/permissions';
import { RequestContext } from '../common/request-context/request-context';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { auditLog } from '../database/schema';

export interface AuditActor {
  userId: string;
  role: Role;
}

export interface AuditEntry {
  tenantId: string | null;
  /** Defaults to the request's authenticated principal; pass null for system actions. */
  actor?: AuditActor | AuthContext | null;
  action: string; // dotted snake_case, e.g. user.status_changed (DB-enforced format)
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Append-only audit writer. Request id, client IP and user agent are taken from the
 * request context automatically. Pass the open transaction so the audit row commits
 * (or rolls back) together with the change it describes.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async record(entry: AuditEntry, tx: Executor = this.db): Promise<void> {
    const ctx = RequestContext.get();
    const actor = entry.actor === undefined ? ctx?.auth ?? null : entry.actor;
    await tx.insert(auditLog).values({
      tenantId: entry.tenantId,
      actorUserId: actor?.userId ?? null,
      actorRole: actor?.role ?? 'SYSTEM',
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      requestId: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    });
  }
}
