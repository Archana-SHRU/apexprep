-- Versioned engine configuration: immutable versions, one active, every change audited.
BEGIN;

DO $$
DECLARE
  t       uuid := pg_temp.fx_tenant('engine');
  admin1  uuid := pg_temp.fx_user(t, 'a1@engine.test', 'ADMIN');
  admin2  uuid := pg_temp.fx_user(t, 'a2@engine.test', 'ADMIN');
  v1      uuid := pg_temp.fx_config(t, admin1);
  v2      uuid;
BEGIN
  PERFORM pg_temp.ok((SELECT count(*) FROM audit_log WHERE entity_id = v1 AND action = 'engine_config.created'
                        AND actor_user_id = admin1 AND actor_role = 'ADMIN') = 1,
    'creating a version writes an audit row naming the admin');
  PERFORM pg_temp.ok((SELECT count(*) FROM audit_log WHERE entity_id = v1 AND action = 'engine_config.activated') = 1,
    'creating an active version also audits the activation');

  INSERT INTO engine_config (tenant_id, version, params, change_note, created_by)
  VALUES (t, 2, '{"elo_scale": 400, "k_student": 24}', 'lower K_s', admin2) RETURNING id INTO v2;

  PERFORM pg_temp.expect_error(format(
    'UPDATE engine_config SET is_active = true, activated_at = now(), activated_by = %L WHERE id = %L', admin2, v2),
    '23505', 'two versions cannot be active at once');

  UPDATE engine_config SET is_active = false, deactivated_at = now(), deactivated_by = admin2 WHERE id = v1;
  UPDATE engine_config SET is_active = true, activated_at = now(), activated_by = admin2 WHERE id = v2;

  PERFORM pg_temp.ok((SELECT actor_user_id FROM audit_log WHERE entity_id = v1 AND action = 'engine_config.deactivated') = admin2,
    'deactivation is attributed to the admin who switched versions');
  PERFORM pg_temp.ok((SELECT actor_user_id FROM audit_log WHERE entity_id = v2 AND action = 'engine_config.activated') = admin2,
    'activation is attributed to the activating admin');
  PERFORM pg_temp.ok((SELECT count(*) FROM audit_log WHERE tenant_id = t AND entity_type = 'engine_config') = 5,
    'five config events audited: 2 creates, 2 activations, 1 deactivation');

  PERFORM pg_temp.expect_error(format('UPDATE engine_config SET params = ''{"k_student": 99}'' WHERE id = %L', v2),
    'AP001', 'the parameters of a version cannot be edited');
  PERFORM pg_temp.expect_error(format('UPDATE engine_config SET version = 7 WHERE id = %L', v2),
    'AP001', 'a version number cannot be edited');
  PERFORM pg_temp.expect_error(format('DELETE FROM engine_config WHERE id = %L', v1),
    'AP001', 'a version cannot be deleted');
  PERFORM pg_temp.expect_error('TRUNCATE engine_config CASCADE', 'AP001', 'engine_config cannot be truncated');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO engine_config (tenant_id, version, params, change_note) VALUES (%L, 2, ''{}'', ''dup'')', t),
    '23505', 'version numbers are unique per tenant');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO engine_config (tenant_id, version, params, change_note) VALUES (%L, 3, ''[1, 2]'', ''array'')', t),
    '23514', 'params must be a JSON object');
END $$;

ROLLBACK;
