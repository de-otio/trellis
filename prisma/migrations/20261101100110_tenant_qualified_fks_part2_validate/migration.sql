-- Tenant-qualified foreign keys, part 2, step 3 of 4: validate existing rows.
-- Same locking and re-run behaviour as part 1's step 3
-- (20261101090110_tenant_qualified_fks_validate). A failure names the key;
-- the add file's header shows how to find the rows.
--
-- squawk's prefer-robust-stmts: VALIDATE is already idempotent.

SET lock_timeout = '1s';
SET statement_timeout = '5min';

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_tenant_id_group_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_tenant_id_primary_entity_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "taxonomy_taxons" VALIDATE CONSTRAINT "taxonomy_taxons_tenant_id_parent_taxon_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "connection_codes" VALIDATE CONSTRAINT "connection_codes_tenant_id_entity_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "events" VALIDATE CONSTRAINT "events_tenant_id_group_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "events" VALIDATE CONSTRAINT "events_tenant_id_announce_post_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_relationships" VALIDATE CONSTRAINT "entity_relationships_tenant_id_entity_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_relationships" VALIDATE CONSTRAINT "entity_relationships_tenant_id_related_entity_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_location" VALIDATE CONSTRAINT "entity_location_tenant_id_entity_id_fkey";
