import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tstz } from './columns';

/** Mirror of migrations 0001 + 0008. SQL is the source of truth; see test/e2e/schema-drift. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
  benchmarkingEnabled: boolean('benchmarking_enabled').notNull().default(true),
  focusTrackingEnabled: boolean('focus_tracking_enabled').notNull().default(true),
  selfRegistrationEnabled: boolean('self_registration_enabled').notNull().default(false),
  ...timestamps,
  deletedAt: tstz('deleted_at'),
});

export type TenantRow = typeof tenants.$inferSelect;
