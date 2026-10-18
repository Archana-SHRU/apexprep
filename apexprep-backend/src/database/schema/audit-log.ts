import { inet, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './columns';

/** Mirror of migration 0001 (audit_log). Append-only: the database rejects UPDATE/DELETE. */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  actorUserId: uuid('actor_user_id'),
  actorRole: text('actor_role', { enum: ['STUDENT', 'ADMIN', 'SUPER_ADMIN', 'SYSTEM'] }).notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before').$type<Record<string, unknown>>(),
  after: jsonb('after').$type<Record<string, unknown>>(),
  requestId: text('request_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
});
