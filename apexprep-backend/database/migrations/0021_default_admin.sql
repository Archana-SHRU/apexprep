-- =============================================================================
-- 0021_default_admin
-- Provisions the baseline admin account ('admin@apexprep.dev') for 'dev-sandbox'.
-- Password: AdminPassword123!
-- Idempotent: ON CONFLICT DO UPDATE so it never fails on re-deployment.
-- =============================================================================

INSERT INTO users (
  id,
  tenant_id,
  email,
  password_hash,
  role,
  display_name,
  email_verified_at,
  status
)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'admin@apexprep.dev',
  '$argon2id$v=19$m=19456,t=2,p=1$P0m05pY8YKl7hvaf6juFLw$9a5d34tIka3U3Av/iN8RHEqak8CpLJoYTeOO8RAikhg',
  'ADMIN',
  'Platform Admin',
  now(),
  'active'
)
ON CONFLICT (tenant_id, email) WHERE deleted_at IS NULL
DO UPDATE SET
  role = 'ADMIN',
  password_hash = EXCLUDED.password_hash,
  status = 'active';

-- Also promote all existing sandbox users so any signed-up account can access the admin console
UPDATE users
SET role = 'ADMIN'
WHERE tenant_id = 'd0000000-0000-4000-8000-000000000001'
  AND status = 'active';
