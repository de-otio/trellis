-- Tenant-qualified foreign keys, part 2, step 1 of 4: the unique key Prisma
-- needs for the one-to-one relation added in step 2. announce_post_id alone is
-- already unique; Prisma requires the relation's own fields, as a set, to be.
--
-- One CONCURRENTLY statement per file, as in part 1
-- (20261101090000_tenant_fk_target_connection_codes). If the build is
-- interrupted it leaves an INVALID index behind that IF NOT EXISTS then
-- skips: DROP INDEX it first, then re-run.

SET lock_timeout = '1s';
SET statement_timeout = '5min';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "events_tenant_id_announce_post_id_key"
  ON "events"("tenant_id", "announce_post_id");
