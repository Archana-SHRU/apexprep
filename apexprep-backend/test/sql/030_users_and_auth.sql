-- Password storage, identity constraints and refresh-token integrity.
BEGIN;

DO $$
DECLARE
  t  uuid := pg_temp.fx_tenant('auth');
  u  uuid := pg_temp.fx_user(t, 'reuse@auth.test');
BEGIN
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO users (tenant_id, email, password_hash, display_name) VALUES (%L, ''plain@auth.test'', ''correct horse battery staple'', ''P'')', t),
    '23514', 'a plaintext password is rejected');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO users (tenant_id, email, password_hash, display_name) VALUES (%L, ''bcrypt@auth.test'',
       ''$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'', ''B'')', t),
    '23514', 'a non-argon2id hash is rejected');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO users (tenant_id, email, password_hash, display_name) VALUES (%L, ''Mixed@Auth.test'', %L, ''M'')', t, pg_temp.fx_hash()),
    '23514', 'emails must be stored lower-case');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO users (tenant_id, email, password_hash, display_name, role) VALUES (%L, ''r@auth.test'', %L, ''R'', ''TEACHER'')', t, pg_temp.fx_hash()),
    '23514', 'unknown roles are rejected');

  UPDATE users SET deleted_at = now() WHERE id = u;
  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO users (tenant_id, email, password_hash, display_name) VALUES (%L, ''reuse@auth.test'', %L, ''Again'')', t, pg_temp.fx_hash()),
    'a soft-deleted user''s email can be registered again');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at)
     VALUES (%L, %L, gen_random_uuid(), ''\x00ff''::bytea, now() + interval ''30 days'')', t, u),
    '23514', 'refresh tokens are stored only as 32-byte SHA-256 digests');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at, revoked_at)
     VALUES (%L, %L, gen_random_uuid(), digest(''t1'', ''sha256''), now() + interval ''1 day'', now())', t, u),
    '23514', 'a revoked refresh token must record why');

  PERFORM pg_temp.expect_ok(format(
    'INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at)
     VALUES (%L, %L, gen_random_uuid(), digest(''t2'', ''sha256''), now() + interval ''30 days'')', t, u),
    'a well-formed refresh token is accepted');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at)
     VALUES (%L, %L, gen_random_uuid(), digest(''t2'', ''sha256''), now() + interval ''30 days'')', t, u),
    '23505', 'a refresh token hash can only exist once');
END $$;

ROLLBACK;
