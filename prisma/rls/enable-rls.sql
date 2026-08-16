-- ARM the RLS backstop. NOT a migration — run this by hand, deliberately.
--
--     psql "$DIRECT_DATABASE_URL" -f prisma/rls/enable-rls.sql
--
-- Preconditions, ALL of them, checked before you run this anywhere real:
--
--   1. The policies exist — migration 20260816090100_rls_backstop_policies_inert
--      has been applied. Read its header FIRST; it documents the lockout mode
--      and the rehearsal script. This file is the trigger, that file is the
--      manual.
--   2. `TENANT_SCOPE_MODE` is "shadow" or "enforce" in the target environment.
--      With it "off", app.ts never establishes the ambient tenant, nothing sets
--      the GUC, and every policied table reads as EMPTY.
--   3. The request paths actually route database access through `withTenantTx`
--      (multi-tenancy plan P4). As of this file being written they DO NOT —
--      `withTenantTx` has no production call site. Arming now takes the app
--      down. This precondition is the blocking one.
--   4. You have rehearsed the full sequence, including the DISABLE, on a
--      scratch database, as the APPLICATION role.
--
-- FORCE ROW LEVEL SECURITY is set as well as ENABLE. Without FORCE, the table
-- OWNER bypasses every policy — and if the app connects as the owner (a common
-- local/dev setup) you get a green rehearsal and a false sense of protection.
-- With FORCE, the owner is subject to the policies too, which is what makes the
-- backstop a backstop. The consequence: migrations and maintenance jobs that
-- touch these tables must set the GUC or connect as a BYPASSRLS role.

\set ON_ERROR_STOP on

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'posts', 'post_comments', 'entities', 'notifications', 'blocked_users',
    'groups', 'group_members', 'entity_ownerships', 'connection_codes',
    'connection_code_redemptions', 'taxonomy_dimensions', 'taxonomy_categories',
    'taxonomy_taxons', 'entity_location', 'relationships',
    'entity_relationships', 'media_files', 'events', 'event_rsvps',
    'event_shifts', 'event_shift_signups'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Post-arm sanity: with no GUC set, this MUST return 0 on every row.
-- A non-zero count means a table is missing its policy or FORCE did not take.
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = current_schema()
   AND c.relkind = 'r'
   AND c.relrowsecurity
 ORDER BY c.relname;
