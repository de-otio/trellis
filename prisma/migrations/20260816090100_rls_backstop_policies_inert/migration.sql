-- WS3 / L3c — the PostgreSQL Row-Level-Security backstop, INSTALLED BUT NOT
-- SWITCHED ON.
--
-- Security review 2026-08, lane 7 HIGH-1. The tenant-scope Prisma extension
-- (apps/api/src/lib/tenant-scope.ts) says in its own module doc that `enforce`
-- is a PARTIAL defence and that the gaps — unique-selector reads/writes
-- (findUnique/update/delete by id), raw SQL, by-relation models — are "closed
-- only by the PostgreSQL RLS backstop (WS3)". WS3 never shipped. This migration
-- is WS3's data-definition half.
--
-- =========================================================================
-- THIS MIGRATION DOES NOT ENABLE RLS. Merging it changes NO query behaviour.
-- =========================================================================
--
-- It creates one helper function and a set of policies. A policy on a table
-- WITHOUT `ROW LEVEL SECURITY` enabled is inert — PostgreSQL stores it and
-- never consults it. Turning the backstop on is a SEPARATE, deliberate step:
--
--     psql "$DATABASE_URL" -f prisma/rls/enable-rls.sql      -- arm it
--     psql "$DATABASE_URL" -f prisma/rls/disable-rls.sql     -- stand it down
--
-- Those two scripts are the opt-in. They are not migrations, on purpose: a
-- migration runs automatically on deploy, and arming RLS must never be
-- something that happens because someone ran `migrate deploy`.
--
-- -------------------------------------------------------------------------
-- THE GUC, AND THE ONE WAY THIS LOCKS THE APP OUT
-- -------------------------------------------------------------------------
-- Policies read the session/transaction GUC `app.current_tenant`.
--
-- NOTE ON THE NAME: the remediation plan writes this as `app.tenant_id`. The
-- name used here is `app.current_tenant` because that is what the application
-- ALREADY sets — `withTenantTx` in
-- apps/api/src/lib/database-connection-manager.ts issues
-- `SELECT set_config('app.current_tenant', $1, true)` as the first statement of
-- every tenant transaction. Introducing a second name would mean the policies
-- read one GUC while the code sets another, which presents as a total,
-- silent, application-wide lockout the moment RLS is armed. One name.
-- `apps/api/test/unit/rls-guc-name.test.ts` pins the code and this file to the
-- same string so they cannot drift apart later.
--
-- ** WHAT BREAKS IF THE GUC IS UNSET, once RLS is armed **
--   Every SELECT on a policied table returns ZERO ROWS. Every INSERT fails the
--   WITH CHECK. Every UPDATE/DELETE matches nothing. There is no error that
--   says "RLS refused you" — a filtered-out row is indistinguishable from an
--   absent one, so the application presents as an empty, broken installation
--   rather than as a permissions failure. This is the classic RLS
--   lock-yourself-out, and it is the reason arming is a separate script.
--
--   The trigger for that state is concrete and currently TRUE:
--   `TENANT_SCOPE_MODE` defaults to "off", and with it off `app.ts` never
--   establishes the ambient tenant, so `withTenantTx` throws and nothing sets
--   the GUC. Do NOT arm RLS before `TENANT_SCOPE_MODE` is at least "shadow"
--   AND the request paths actually route their database access through
--   `withTenantTx` (that routing is P4 and is NOT done yet — `withTenantTx`
--   has no production call site today). Arming RLS in the current tree would
--   take the application down.
--
--   Two further footguns worth writing down:
--     * The table OWNER and any SUPERUSER BYPASS RLS unless the table is set
--       `FORCE ROW LEVEL SECURITY`. So a test run as the owner will PASS while
--       the app role is locked out. Rehearse as the application role, never as
--       the owner. `enable-rls.sql` sets FORCE for exactly this reason.
--     * Migrations themselves run as the owner. With FORCE on, a future data
--       migration that touches a policied table must either set the GUC or run
--       as a role with BYPASSRLS. Budget for that before arming.
--
-- -------------------------------------------------------------------------
-- HOW TO REHEARSE (do this before arming anywhere that matters)
-- -------------------------------------------------------------------------
--  1. Fresh scratch database; apply all migrations.
--  2. Seed two tenants, T1 and T2, each with a post, an entity and a
--     relationship edge.
--  3. Create/assume the APPLICATION role (not the owner, not a superuser).
--  4. Baseline, RLS not yet armed: as the app role, confirm both tenants'
--     rows are visible. This proves the fixture, not the policy.
--  5. Arm: `\i prisma/rls/enable-rls.sql`.
--  6. GUC UNSET: `SELECT count(*) FROM posts;`  -> MUST be 0.
--     This is the lockout, reproduced deliberately. Confirm you recognise it.
--  7. GUC SET to T1: `SELECT set_config('app.current_tenant','<T1>',false);`
--     -> only T1's rows, on every policied table. Then repeat for T2.
--  8. Write path: as T1, `INSERT` a row with tenant_id = T2 -> MUST fail the
--     WITH CHECK. `UPDATE` a T2 row -> MUST affect 0 rows.
--  9. Cross-check the raw-SQL paths specifically (circles.ts, discovery.ts,
--     directory-search.ts, entity-geo-repository.ts) — those bypass the Prisma
--     extension entirely and are the whole point of the backstop.
-- 10. Stand down: `\i prisma/rls/disable-rls.sql`; confirm step 4's behaviour
--     returns. An arming step you have not practised UNDOING is not rehearsed.
--
-- In CI this belongs in the migration-rehearsal workflow against an ephemeral
-- database, never against dev on first contact.
--
-- -------------------------------------------------------------------------
-- REHEARSAL RESULT — steps 1-10 executed 2026-08-16, PostgreSQL 16, ephemeral
-- local database, no dev/live database involved. Recorded because the whole
-- point of a rehearsal is that someone can read what happened.
-- -------------------------------------------------------------------------
--   * Inert as promised: after `migrate deploy`, every listed table showed
--     relrowsecurity = false with exactly 1 policy attached, and both tenants'
--     rows were visible. Merging this migration changes nothing.
--   * Armed, GUC unset      -> 0 rows. The lockout, reproduced on purpose.
--   * Armed, GUC = ''       -> 0 rows. NULLIF does its job; a "cleared" tenant
--                              is not a wildcard.
--   * Armed, GUC = T1 / T2  -> exactly that tenant's rows, both directions.
--   * Armed, cross-tenant INSERT -> refused by WITH CHECK
--                              (SQLSTATE 42501, insufficient_privilege).
--   * Armed, cross-tenant UPDATE -> UPDATE 0.
--   * Stood down            -> both tenants visible again; no policy dropped.
--
--   ** The owner/superuser footgun is REAL and was hit during this rehearsal.**
--   The first pass ran as the docker-compose superuser and every assertion
--   above came back WRONG-BUT-GREEN: 2 rows with the GUC unset, the
--   cross-tenant INSERT accepted, UPDATE 1. FORCE ROW LEVEL SECURITY subjects
--   the table OWNER to the policies but a SUPERUSER bypasses RLS regardless.
--   Re-running as a plain LOGIN role produced every result listed above.
--   A rehearsal conducted as the superuser proves nothing and looks like proof.

-- ---------------------------------------------------------------------------
-- The tenant resolver.
-- ---------------------------------------------------------------------------
-- `current_setting(..., true)` — the `true` is `missing_ok`: it returns NULL
-- instead of raising when the GUC was never set. Raising would turn every
-- unscoped query into an error, which is arguably better feedback but would
-- also break the "policy is inert until armed" property during rollout.
--
-- NULL propagates into the policy predicate as `tenant_id = NULL`, which is
-- NULL, which is not TRUE — so an unset GUC denies everything. Fail-closed by
-- construction rather than by a written rule.
--
-- Empty string is mapped to NULL as well: `set_config(..., '', ...)` is what a
-- caller that "cleared" the tenant leaves behind, and '' must not be allowed to
-- match a tenant_id column that could conceivably hold ''.
--
-- STABLE, not IMMUTABLE: the value can change between statements in a
-- transaction. Marking it IMMUTABLE would let the planner fold it into a cached
-- plan and serve one tenant's snapshot to another.
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')
$$;

COMMENT ON FUNCTION app_current_tenant_id() IS
  'RLS tenant resolver. Reads the app.current_tenant GUC set by withTenantTx '
  '(apps/api/src/lib/database-connection-manager.ts). Returns NULL when unset, '
  'which makes every tenant policy deny. See the migration header before arming.';

-- ---------------------------------------------------------------------------
-- The policies. INERT until `enable-rls.sql` runs.
-- ---------------------------------------------------------------------------
-- One FOR ALL policy per table, with both USING (reads, and the row-matching
-- half of UPDATE/DELETE) and WITH CHECK (the row-producing half of
-- INSERT/UPDATE). Both halves are required: USING alone lets a caller INSERT a
-- row into another tenant, or UPDATE one of their own rows INTO another tenant.
--
-- Every table below carries its own NOT NULL `tenant_id` column — this list is
-- exactly TENANT_SCOPED_MODELS in apps/api/src/lib/tenant-scope.ts, minus the
-- composed `ext_*` extension tables, which are generated per installation and
-- must be policied by the composer that creates them (O-1 design §12.3 H1).
--
-- NOT covered, and deliberately so: "by-relation" models with no tenant_id of
-- their own (e.g. PostMedia, PostSubject). They inherit scope through a join to
-- a policied parent. A backstop cannot express that without a subquery per row;
-- they remain the app layer's responsibility and are called out here so their
-- absence is a recorded decision rather than an oversight.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'posts',
    'post_comments',
    'entities',
    'notifications',
    'blocked_users',
    'groups',
    'group_members',
    'entity_ownerships',
    'connection_codes',
    'connection_code_redemptions',
    'taxonomy_dimensions',
    'taxonomy_categories',
    'taxonomy_taxons',
    'entity_location',
    'relationships',
    'entity_relationships',
    'media_files',
    'events',
    'event_rsvps',
    'event_shifts',
    'event_shift_signups'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Idempotent: re-running the migration (or hand-applying it) must not fail
    -- on an existing policy.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         FOR ALL
         USING (tenant_id = app_current_tenant_id())
         WITH CHECK (tenant_id = app_current_tenant_id())', t);
  END LOOP;
END
$$;
