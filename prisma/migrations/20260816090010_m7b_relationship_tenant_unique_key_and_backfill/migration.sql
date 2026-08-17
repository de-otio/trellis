-- M7b — the tenant-leading `relationships` unique key, and the repair of the
-- stale `reciprocated` grants the old tenant-blind key produced.
--
-- Security review 2026-08, lane 7 MEDIUM-3. Second of two migrations — see
-- M7a (applied immediately before this one) for why the DROP of the old key
-- is a separate, single-statement migration file.
--
-- WHAT WAS WRONG (full analysis; M7a's header only summarizes)
-- --------------------------------------------------------------
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
-- `prisma migrate diff` emits this CREATE UNIQUE INDEX correctly as a
-- starting point, but not the `CONCURRENTLY` keyword, the `IF NOT EXISTS`
-- guard, the `lock_timeout`/`statement_timeout` prologue, or the split from
-- the DROP in M7a — all hand-added; see M7a's header for the Prisma
-- transaction-wrapping constraint that forces the split.
--
-- BACKFILL / DEDUP ANALYSIS
-- -------------------------
-- Step 1 (the CREATE UNIQUE INDEX below) needs NO dedup. The new key ADDS a
-- column to the old one, so it is strictly WEAKER: every row set that
-- satisfied (user_id, target_type, target_id) trivially satisfies
-- (tenant_id, user_id, target_type, target_id). A widening can never produce
-- a violation. (Had the change gone the other way — dropping a column — a
-- dedup pass would be mandatory before the CREATE UNIQUE INDEX.)
--
-- Step 2 IS a real repair and is the reason this migration is not
-- index-only. Fixing the code stops NEW stale grants; it does not revoke the
-- ones already written. Step 2 revokes them.
--
-- ---------------------------------------------------------------------------
-- Step 1 — the tenant-leading replacement key.
-- ---------------------------------------------------------------------------
-- `CONCURRENTLY` here does NOT force Prisma to wrap the file in a
-- transaction — verified locally 2026-08-17: a `SET lock_timeout` / `SET
-- statement_timeout` prologue ahead of `CREATE INDEX CONCURRENTLY` (unlike
-- ahead of `DROP INDEX CONCURRENTLY` in M7a) applies cleanly under `prisma
-- migrate deploy`, as does a further statement (the backfill below) after it
-- in the same file.
--
-- tenant_id LEADS: the key then doubles as the tenant-scoped lookup index that
-- every scoped read on this table wants. (The separate @@index([tenantId]) is
-- now a prefix of this key and therefore redundant; it is deliberately KEPT —
-- dropping an index is a separate change with its own query-plan risk, and
-- bundling it here would make this migration harder to reason about.)
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "relationships_tenant_id_user_id_target_type_target_id_key"
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
