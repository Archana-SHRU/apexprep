-- =============================================================================
-- 0008_tenant_self_registration
-- Public sign-up (POST /v1/auth/register) is opt-in per tenant. Existing and new
-- tenants default to closed, so no tenant gains open registration by accident;
-- a SUPER_ADMIN (or the dev seed) turns it on explicitly.
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN self_registration_enabled boolean NOT NULL DEFAULT false;
