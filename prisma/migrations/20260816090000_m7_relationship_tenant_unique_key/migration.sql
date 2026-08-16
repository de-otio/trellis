-- M7 — tenant-scope the `relationships` unique key, and repair the stale
-- `reciprocated` grants the tenant-blind key produced.
--
-- Security review 2026-08, lane 7 MEDIUM-3.
--
-- WHAT WAS WRONG
-- --------------
-- `relationships.tenant_id` is NOT NULL, but the unique key was
-- (user_id, target_type, target_id) — tenant-blind. One pair of users could
-- therefore hold exactly ONE edge across the entire installation, and
-- `findUnique` on that key returned whichever tenant's row happened to exist.
-- Two consequences, both authorization-relevant:
--
--   1. An edge created in tenant B silently blocked the same edge in tenant A
--      (the create path is idempotent-on-match, so tenant A's caller got back
--      tenant B's row and no error).
--   2. `createRelationship`'s reverse-edge lookup was NOT tenant-scoped while
--      `removeRelationship`'s clear WAS. So: A→B in T1; B→A in T2 flipped BOTH
--      rows to reciprocated = true (T1 now believes B consented back, with no
--      T1 edge from B at all); B then deletes B→A in T2, and the clear — being
--      tenant-scoped — misses A's T1 row, which stays reciprocated = true
--      forever with nothing anywhere that can revoke it.
--
-- `reciprocated` is the consent bit the audience model is built on
-- (`authorAudienceSql`, `getFriendUserIds`), so (2) is a permanent, unrevokable
-- read grant, not a bookkeeping wart.
--
-- HAND-AUTHORED, and why
-- ----------------------
-- `prisma migrate diff` emits the two index statements below correctly, but it
-- ALSO emits DROP INDEX for three hand-written raw-SQL indexes it cannot model
-- (entity_location_location_idx, tenant_display_name_trgm_idx,
-- tenant_directory_profile_desc_trgm_idx — GiST / pg_trgm). Those DROPs are
-- removed here; applying them would silently destroy geo-proximity and
-- directory search. This is the same trap documented in
-- 20260805080531_add_audience_axes and mechanically guarded by
-- scripts/check-migration-sql.mjs.
--
-- BACKFILL / DEDUP ANALYSIS
-- -------------------------
-- Step 1 needs NO dedup. The new key ADDS a column to the old one, so it is
-- strictly WEAKER: every row set that satisfied
-- (user_id, target_type, target_id) trivially satisfies
-- (tenant_id, user_id, target_type, target_id). A widening can never produce a
-- violation. (Had the change gone the other way — dropping a column — a dedup
-- pass would be mandatory before the CREATE UNIQUE INDEX.)
--
-- Step 2 IS a real repair and is the reason this migration is not index-only.
-- Fixing the code stops NEW stale grants; it does not revoke the ones already
-- written. Step 2 revokes them.

-- ---------------------------------------------------------------------------
-- Step 1 — replace the unique key.
-- ---------------------------------------------------------------------------
-- ALLOW-DROP-INDEX: relationships_user_id_target_type_target_id_key is
-- superseded by the tenant-leading key created immediately below. It is the
-- defect itself (a tenant-blind unique constraint on a NOT NULL tenant column),
-- not Prisma drift, and it must go before the replacement can mean anything.
DROP INDEX "relationships_user_id_target_type_target_id_key";

-- tenant_id LEADS: the key then doubles as the tenant-scoped lookup index that
-- every scoped read on this table wants. (The separate @@index([tenantId]) is
-- now a prefix of this key and therefore redundant; it is deliberately KEPT —
-- dropping an index is a separate change with its own query-plan risk, and
-- bundling it here would make this migration harder to reason about.)
CREATE UNIQUE INDEX "relationships_tenant_id_user_id_target_type_target_id_key"
  ON "relationships"("tenant_id", "user_id", "target_type", "target_id");

-- ---------------------------------------------------------------------------
-- Step 2 — revoke stale cross-tenant `reciprocated` grants.
-- ---------------------------------------------------------------------------
-- Definition of stale: a user→user edge marked reciprocated whose reverse edge
-- does not exist IN THE SAME TENANT. Under the corrected semantics that row is
-- asserting a consent that no edge supports.
--
-- REVOKE-ONLY, deliberately. The symmetric repair — setting reciprocated = true
-- where a same-tenant reverse edge exists but the flag is false — is NOT done
-- here. That direction WIDENS an audience, and a migration is the wrong place
-- to grant read access to posts on a user's behalf. Those rows (if any) simply
-- behave as un-reciprocated until one side re-creates the edge through the API,
-- which is the fail-closed outcome.
--
-- Only `target_type = 'user'` rows are touched: reciprocity is a user↔user
-- concept, and `target_type = 'entity'` rows carry reciprocated = false already
-- (see SyncOps.syncOwnership).
UPDATE "relationships" r
   SET "reciprocated" = false
 WHERE r."reciprocated" = true
   AND r."target_type" = 'user'
   AND NOT EXISTS (
     SELECT 1
       FROM "relationships" rev
      WHERE rev."tenant_id"   = r."tenant_id"
        AND rev."user_id"     = r."target_id"
        AND rev."target_type" = 'user'
        AND rev."target_id"   = r."user_id"
   );

-- Expected affected rows in the current deploy: ZERO. `TENANT_SCOPE_MODE`
-- defaults to "off", the ambient tenant is established only when it is not
-- "off" (app.ts), and `createRelationship` has always refused without one — so
-- no user→user edge can have been written in the default configuration. Count
-- first if you are applying this anywhere that ran with the mode on:
--
--   SELECT count(*) FROM relationships r
--    WHERE r.reciprocated AND r.target_type = 'user'
--      AND NOT EXISTS (SELECT 1 FROM relationships rev
--                       WHERE rev.tenant_id = r.tenant_id
--                         AND rev.user_id = r.target_id
--                         AND rev.target_type = 'user'
--                         AND rev.target_id = r.user_id);
--
-- A non-zero count is not necessarily evidence of the attack — a legitimate
-- pre-fix cross-tenant flip produces the same row — but it IS evidence of
-- grants that were never revocable, so revoking them is correct either way.
