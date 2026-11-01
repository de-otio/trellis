-- Tenant-qualified foreign keys, part 2, step 4 of 4: drop the four
-- single-column FKs that step 2 replaced. As in part 1, each composite key
-- implies the old one, so nothing is lost.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_group_id_fkey";

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_primary_entity_id_fkey";

ALTER TABLE "taxonomy_taxons" DROP CONSTRAINT IF EXISTS "taxonomy_taxons_parent_taxon_id_fkey";

ALTER TABLE "connection_codes" DROP CONSTRAINT IF EXISTS "connection_codes_entity_id_fkey";
