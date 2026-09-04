-- Compliance plan 08 Phase 1 — part 3 of 3: the reporter-dedupe index on the
-- PRE-EXISTING `reports` table, then validation of the foreign key part 1 added
-- NOT VALID.
--
-- Separate file for the same reason as part 2: `CREATE INDEX CONCURRENTLY`
-- cannot run inside the transaction Prisma wraps a multi-statement DDL file
-- in. A further statement AFTER the CONCURRENTLY one is the shape M7b verified
-- locally (its backfill UPDATE follows its CONCURRENTLY index the same way).
--
-- The index name is the one Prisma derives for
-- @@index([reporterUserId, resourceType, resourceId, categoryKey, status]) on
-- Report, truncated to the 63-byte identifier limit — keep it exactly so
-- `prisma migrate diff` sees no drift.
--
-- If the build is interrupted it leaves an INVALID index of this name behind,
-- and IF NOT EXISTS then skips it on re-run: `DROP INDEX` the invalid index
-- first (it shows as INVALID in `\d reports`), then re-run.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "reports_reporter_user_id_resource_type_resource_id_category_idx"
  ON "reports"("reporter_user_id", "resource_type", "resource_id", "category_key", "status");

-- VALIDATE scans `reports` for rows that violate the key but takes only SHARE
-- UPDATE EXCLUSIVE (ROW SHARE on `report_categories`): reads and writes keep
-- flowing. Validating an already-valid constraint is a no-op, so this is
-- re-runnable as written. Expected violations in the current deploy: ZERO —
-- `category_key` was added nullable in part 1 and nothing has written it yet.
--
-- squawk's robust-statements rule wants a transaction around this; the
-- CONCURRENTLY statement above forbids one in this file, and idempotency is
-- what the rule is really after — VALIDATE already has it.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "reports" VALIDATE CONSTRAINT "reports_category_key_fkey";
