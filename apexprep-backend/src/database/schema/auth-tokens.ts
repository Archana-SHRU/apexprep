import { inet, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from './columns';

/** Mirror of migration 0001 (refresh_tokens). Only the SHA-256 of a token is stored. */
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  familyId: uuid('family_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  issuedAt: tstz('issued_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
  revokedReason: text('revoked_reason', {
    enum: ['rotated', 'logout', 'reuse_detected', 'admin', 'password_change'],
  }),
  replacedById: uuid('replaced_by_id'),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

/** Mirror of migration 0001 (user_tokens): single-use verification / reset tokens. */
export const userTokens = pgTable('user_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  purpose: text('purpose', { enum: ['email_verification', 'password_reset'] }).notNull(),
  tokenHash: bytea('token_hash').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  consumedAt: tstz('consumed_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;

