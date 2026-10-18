/**
 * Typed mirror of the SQL schema (database/migrations is the source of truth).
 * Tables are added here as modules start using them; test/e2e/schema-drift.e2e-spec.ts
 * fails if a mirrored table's columns drift from the migrated database.
 */
export * from './tenants';
export * from './users';
export * from './auth-tokens';
export * from './audit-log';
export * from './tracks';
export * from './syllabus';
export * from './content';
export * from './questions';
export * from './engine-config';
export * from './review';
export * from './practice';
export * from './explanations';
export * from './learning-ai';
export * from './syllabus-suggestions';
export * from './tests';
export * from './analytics';
