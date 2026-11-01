-- WS3 RLS backstop: add the `tenant_isolation` policy to the child tables that
-- carry their own `tenant_id`.
--
-- =========================================================================
-- THIS MIGRATION DOES NOT ENABLE RLS. Merging it changes NO query behaviour.
-- =========================================================================
--
-- The backstop migration (20260816090100_rls_backstop_policies_inert) left the
-- "by-relation" child tables out, on the grounds that they have no tenant_id of
-- their own. That no longer holds for these five: each now carries a
-- denormalized NOT NULL `tenant_id`, so the same FOR ALL policy applies to
-- them directly, with no subquery to the parent:
--
--   post_media, post_sentiments, link_checks, post_geo_index,
--   product_taxonomy_tags
--
-- Still left out, deliberately: `tenant_classification_tags`. It carries a
-- tenant_id, but its parent (`tenant_classifications`) is a tenant-admin table
-- that platform admins update across tenants and that has no policy; the child
-- follows the parent. By-relation tables without a tenant_id (post_subjects,
-- post_comment_media, …) still inherit scope through their parent only.
--
-- `prisma/rls/enable-rls.sql` / `disable-rls.sql` now list the five tables.
-- Read the backstop migration's header before arming anything; the policies
-- are inert until `enable-rls.sql` runs. `apps/api/test/unit/rls-guc-name.test.ts`
-- checks that every policied table is also armed and disarmed by the scripts,
-- and that every by-relation model with a tenant_id is policied or exempted.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'post_media',
    'post_sentiments',
    'link_checks',
    'post_geo_index',
    'product_taxonomy_tags'
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
