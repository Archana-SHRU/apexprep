-- audit_log accepts inserts only.
BEGIN;

DO $$
DECLARE
  t  uuid := pg_temp.fx_tenant('audit');
  u  uuid := pg_temp.fx_user(t, 'admin@audit.test', 'ADMIN');
BEGIN
  INSERT INTO audit_log (tenant_id, actor_user_id, actor_role, action, entity_type, entity_id)
  VALUES (t, u, 'ADMIN', 'question.published', 'question', gen_random_uuid());

  PERFORM pg_temp.expect_error('UPDATE audit_log SET action = ''question.retracted''', 'AP001', 'audit_log rows cannot be updated');
  PERFORM pg_temp.expect_error('DELETE FROM audit_log', 'AP001', 'audit_log rows cannot be deleted');
  PERFORM pg_temp.expect_error('TRUNCATE audit_log', 'AP001', 'audit_log cannot be truncated');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO audit_log (tenant_id, actor_user_id, actor_role, action, entity_type) VALUES (%L, %L, ''SYSTEM'', ''x.y'', ''x'')', t, u),
    '23514', 'a SYSTEM entry cannot name a user as actor');

  PERFORM pg_temp.expect_error(format(
    'INSERT INTO audit_log (tenant_id, actor_role, action, entity_type) VALUES (%L, ''SYSTEM'', ''Not An Action'', ''x'')', t),
    '23514', 'audit actions must be dotted snake_case');

  PERFORM pg_temp.ok((SELECT count(*) FROM audit_log WHERE tenant_id = t) = 1, 'the original audit row is untouched');
END $$;

ROLLBACK;
