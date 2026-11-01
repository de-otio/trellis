-- Tenant-qualified foreign keys, part 2, step 2 of 4: add the composite keys
-- NOT VALID. Part 1 (20261101090100_tenant_qualified_fks_add) explains the
-- shape; this part covers the nullable pointers and the relations that had no
-- FK at all (events.group_id, events.announce_post_id, both ends of
-- entity_relationships, entity_location.entity_id).
--
-- ON DELETE SET NULL ("<col>"), HAND-WRITTEN. A plain SET NULL on a composite
-- key nulls every column of it, tenant_id included, and tenant_id is NOT
-- NULL, so deleting the parent would fail. The column list (Postgres 15+)
-- nulls only the pointer. Prisma cannot express the list: schema.prisma says
-- onDelete: SetNull, and `prisma migrate diff` does not compare the list, so
-- it reports no drift either way. If Prisma ever regenerates one of these
-- FKs it will drop the list; tenant-qualified-fk-shape.integration.test.ts
-- fails when that happens.
--
-- The relations that had no FK before may hold rows whose pointer names a
-- row that no longer exists (the app-code cascades were the only guard).
-- Step 3 refuses those too. Find them with, for example:
--   SELECT e.id FROM events e
--    WHERE e.group_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM groups g
--                       WHERE g.id = e.group_id AND g.tenant_id = e.tenant_id);
--
-- Statements commit one at a time (part 1's step 2 header), so each ADD is
-- preceded by DROP CONSTRAINT IF EXISTS of the same name to make a re-run
-- after a part-way failure safe.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_tenant_id_group_id_fkey";
ALTER TABLE "posts" ADD CONSTRAINT "posts_tenant_id_group_id_fkey"
  FOREIGN KEY ("tenant_id", "group_id") REFERENCES "groups"("tenant_id", "id")
  ON DELETE SET NULL ("group_id") ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_tenant_id_primary_entity_id_fkey";
ALTER TABLE "posts" ADD CONSTRAINT "posts_tenant_id_primary_entity_id_fkey"
  FOREIGN KEY ("tenant_id", "primary_entity_id") REFERENCES "entities"("tenant_id", "id")
  ON DELETE SET NULL ("primary_entity_id") ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "taxonomy_taxons" DROP CONSTRAINT IF EXISTS "taxonomy_taxons_tenant_id_parent_taxon_id_fkey";
ALTER TABLE "taxonomy_taxons" ADD CONSTRAINT "taxonomy_taxons_tenant_id_parent_taxon_id_fkey"
  FOREIGN KEY ("tenant_id", "parent_taxon_id") REFERENCES "taxonomy_taxons"("tenant_id", "id")
  ON DELETE SET NULL ("parent_taxon_id") ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "connection_codes" DROP CONSTRAINT IF EXISTS "connection_codes_tenant_id_entity_id_fkey";
ALTER TABLE "connection_codes" ADD CONSTRAINT "connection_codes_tenant_id_entity_id_fkey"
  FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
  ON DELETE SET NULL ("entity_id") ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_tenant_id_group_id_fkey";
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_group_id_fkey"
  FOREIGN KEY ("tenant_id", "group_id") REFERENCES "groups"("tenant_id", "id")
  ON DELETE SET NULL ("group_id") ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_tenant_id_announce_post_id_fkey";
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_announce_post_id_fkey"
  FOREIGN KEY ("tenant_id", "announce_post_id") REFERENCES "posts"("tenant_id", "id")
  ON DELETE SET NULL ("announce_post_id") ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "entity_relationships" DROP CONSTRAINT IF EXISTS "entity_relationships_tenant_id_entity_id_fkey";
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_tenant_id_entity_id_fkey"
  FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "entity_relationships" DROP CONSTRAINT IF EXISTS "entity_relationships_tenant_id_related_entity_id_fkey";
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_tenant_id_related_entity_id_fkey"
  FOREIGN KEY ("tenant_id", "related_entity_id") REFERENCES "entities"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "entity_location" DROP CONSTRAINT IF EXISTS "entity_location_tenant_id_entity_id_fkey";
ALTER TABLE "entity_location" ADD CONSTRAINT "entity_location_tenant_id_entity_id_fkey"
  FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
