-- Compliance plan 08 Phase 1 — part 2 of 3: the category lookup index on the
-- PRE-EXISTING `reports` table.
--
-- Separate file because `CREATE INDEX CONCURRENTLY` cannot run inside the
-- transaction Prisma wraps part 1 in (M7a/M7b precedent; M7b's header records
-- the local verification that a timeout prologue ahead of a CONCURRENTLY
-- statement applies cleanly under `prisma migrate`). One CONCURRENTLY statement
-- per file, matching the verified shape.
--
-- If the build is interrupted it leaves an INVALID index of this name behind,
-- and IF NOT EXISTS then skips it on re-run: `DROP INDEX` the invalid index
-- first (it shows as INVALID in `\d reports`), then re-run.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "reports_category_key_idx"
  ON "reports"("category_key");
