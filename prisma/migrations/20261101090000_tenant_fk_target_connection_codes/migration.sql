-- Tenant-qualified foreign keys, step 1 of 4: the (tenant_id, id) key on
-- `connection_codes` that child tables reference in step 2
-- (20261101090100_tenant_qualified_fks_add).
--
-- One CONCURRENTLY statement per file: it cannot run inside the transaction
-- Prisma wraps a multi-statement DDL file in (M7a/M7b precedent,
-- 20260823150001_deferred_escalation_parent_unique). The index name is the one
-- Prisma derives for @@unique([tenantId, id]), so `prisma migrate diff` sees
-- no drift. No ADD CONSTRAINT ... USING INDEX: Postgres accepts a unique index
-- as a foreign-key target.
--
-- If the build is interrupted it leaves an INVALID index of this name behind,
-- and IF NOT EXISTS then skips it on re-run: DROP INDEX the invalid index
-- first (it shows as INVALID in `\d connection_codes`), then re-run.

SET lock_timeout = '1s';
SET statement_timeout = '5min';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "connection_codes_tenant_id_id_key"
  ON "connection_codes"("tenant_id", "id");
