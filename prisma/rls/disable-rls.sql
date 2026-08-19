-- STAND DOWN the RLS backstop. The undo for prisma/rls/enable-rls.sql.
--
--     psql "$DIRECT_DATABASE_URL" -f prisma/rls/disable-rls.sql
--
-- Leaves the policies in place (they are inert without ENABLE) so re-arming is
-- one command and does not require re-running a migration.
--
-- Keep this next to the enable script and rehearse it in the same sitting. An
-- arming step whose undo has never been executed is not a rehearsed change —
-- it is a change you are hoping about. The failure mode being undone here is
-- total: an application reading zero rows from every tenant-scoped table.

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
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Should return no rows once the stand-down is complete.
SELECT c.relname AS still_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = current_schema()
   AND c.relkind = 'r'
   AND c.relrowsecurity
 ORDER BY c.relname;
