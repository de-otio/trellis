-- The @@index([tenantId]) on entity_taxonomy_tags (P1 convention: the RLS policy's
-- predicate). One CONCURRENTLY statement per file, as in
-- 20261101090000_tenant_fk_target_connection_codes. An interrupted build
-- leaves an INVALID index that IF NOT EXISTS then skips: DROP INDEX it first.

SET lock_timeout = '1s';
SET statement_timeout = '5min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "entity_taxonomy_tags_tenant_id_idx"
  ON "entity_taxonomy_tags"("tenant_id");
