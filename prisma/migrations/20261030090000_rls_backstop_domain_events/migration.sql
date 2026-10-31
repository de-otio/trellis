-- WS3 RLS backstop: add the `tenant_isolation` policy to `domain_events`.
--
-- =========================================================================
-- THIS MIGRATION DOES NOT ENABLE RLS. Merging it changes NO query behaviour.
-- =========================================================================
--
-- `domain_events` (the DomainEvent outbox, migration
-- 20260904140000_domain_event_outbox) carries its own NOT NULL `tenant_id` and
-- is in TENANT_SCOPED_MODELS (apps/api/src/lib/tenant-scope.ts), but it landed
-- after the backstop migration (20260816090100_rls_backstop_policies_inert), so
-- it had no policy. This adds the same FOR ALL policy, with the same USING and
-- WITH CHECK, and `prisma/rls/enable-rls.sql` / `disable-rls.sql` now list the
-- table. Read the backstop migration's header before arming anything; the
-- policy is inert until `enable-rls.sql` runs.
--
-- The policy reads `app_current_tenant_id()`, created by the backstop
-- migration. `apps/api/test/unit/rls-guc-name.test.ts` checks that every
-- policied table is also armed and disarmed by the scripts.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

DROP POLICY IF EXISTS tenant_isolation ON domain_events;
CREATE POLICY tenant_isolation ON domain_events
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
