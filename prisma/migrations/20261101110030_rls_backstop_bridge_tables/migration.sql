-- WS3 RLS backstop: the tenant_isolation policy on the join tables that now
-- carry their own tenant_id (20261101110000_bridge_tables_tenant_id_add).
--
-- =========================================================================
-- THIS MIGRATION DOES NOT ENABLE RLS. Merging it changes NO query behaviour.
-- =========================================================================
--
-- Same FOR ALL policy as the child tables in
-- 20261031090000_rls_backstop_child_tables. `prisma/rls/enable-rls.sql` /
-- `disable-rls.sql` now list these three tables too.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'post_subjects',
    'post_taxonomy_tags',
    'entity_taxonomy_tags'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      'USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      t
    );
  END LOOP;
END
$$;
