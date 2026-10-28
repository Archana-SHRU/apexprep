-- =============================================================================
-- 0020_default_tenant
-- Provisions the baseline default tenant ('dev-sandbox') and default track
-- ('jee-advanced') with self-registration enabled.
-- Idempotent: ON CONFLICT DO UPDATE so it is safe against subsequent seeds.
-- =============================================================================

INSERT INTO tenants (id, slug, name, benchmarking_enabled, focus_tracking_enabled, self_registration_enabled)
VALUES (
  'd0000000-0000-4000-8000-000000000001',
  'dev-sandbox',
  'ApexPrep Sandbox',
  true,
  true,
  true
)
ON CONFLICT (id) DO UPDATE SET
  self_registration_enabled = true,
  status = 'active';

INSERT INTO tracks (id, tenant_id, slug, name, short_name, description, sort_order, status)
VALUES (
  'd1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'jee-advanced',
  'JEE Advanced',
  'JEE',
  'Physics, Chemistry and Mathematics for IIT admission.',
  0,
  'published'
)
ON CONFLICT (id) DO NOTHING;
