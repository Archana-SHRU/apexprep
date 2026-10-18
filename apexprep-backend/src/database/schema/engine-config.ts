import { boolean, integer, jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/** Mirror of migration 0005 (engine_config). Versions are immutable in the database (AP001). */
export const engineConfig = pgTable('engine_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  version: integer('version').notNull(),
  schemaVersion: smallint('schema_version').notNull().default(1),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  changeNote: text('change_note').notNull(),
  createdBy: uuid('created_by'),
  isActive: boolean('is_active').notNull().default(false),
  activatedAt: tstz('activated_at'),
  activatedBy: uuid('activated_by'),
  deactivatedAt: tstz('deactivated_at'),
  deactivatedBy: uuid('deactivated_by'),
  ...timestamps,
});

export type EngineConfigRow = typeof engineConfig.$inferSelect;
