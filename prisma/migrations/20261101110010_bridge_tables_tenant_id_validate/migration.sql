-- Join tables carry their own tenant_id, step 2 of 2: validate, make
-- tenant_id NOT NULL, and drop the single-column FKs the composite ones
-- replace.
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE (reads and writes continue) and is a
-- no-op when already valid. SET NOT NULL takes ACCESS EXCLUSIVE but skips the
-- table scan because the validated CHECK proves no NULL exists; the CHECK is
-- then redundant and dropped.

SET lock_timeout = '1s';
SET statement_timeout = '5min';

-- post_subjects
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_subjects" VALIDATE CONSTRAINT "post_subjects_tenant_id_not_null";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_subjects" VALIDATE CONSTRAINT "post_subjects_tenant_id_fkey";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_subjects" VALIDATE CONSTRAINT "post_subjects_tenant_id_post_id_fkey";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_subjects" VALIDATE CONSTRAINT "post_subjects_tenant_id_entity_id_fkey";
ALTER TABLE "post_subjects" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "post_subjects" DROP CONSTRAINT IF EXISTS "post_subjects_tenant_id_not_null";
ALTER TABLE "post_subjects" DROP CONSTRAINT IF EXISTS "post_subjects_post_id_fkey";
ALTER TABLE "post_subjects" DROP CONSTRAINT IF EXISTS "post_subjects_entity_id_fkey";

-- post_taxonomy_tags
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_taxonomy_tags" VALIDATE CONSTRAINT "post_taxonomy_tags_tenant_id_not_null";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_taxonomy_tags" VALIDATE CONSTRAINT "post_taxonomy_tags_tenant_id_fkey";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_taxonomy_tags" VALIDATE CONSTRAINT "post_taxonomy_tags_tenant_id_post_id_fkey";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_taxonomy_tags" VALIDATE CONSTRAINT "post_taxonomy_tags_tenant_id_taxon_id_fkey";
ALTER TABLE "post_taxonomy_tags" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "post_taxonomy_tags" DROP CONSTRAINT IF EXISTS "post_taxonomy_tags_tenant_id_not_null";
ALTER TABLE "post_taxonomy_tags" DROP CONSTRAINT IF EXISTS "post_taxonomy_tags_post_id_fkey";
ALTER TABLE "post_taxonomy_tags" DROP CONSTRAINT IF EXISTS "post_taxonomy_tags_taxon_id_fkey";

-- entity_taxonomy_tags
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_taxonomy_tags" VALIDATE CONSTRAINT "entity_taxonomy_tags_tenant_id_not_null";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_taxonomy_tags" VALIDATE CONSTRAINT "entity_taxonomy_tags_tenant_id_fkey";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_taxonomy_tags" VALIDATE CONSTRAINT "entity_taxonomy_tags_tenant_id_entity_id_fkey";
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_taxonomy_tags" VALIDATE CONSTRAINT "entity_taxonomy_tags_tenant_id_taxon_id_fkey";
ALTER TABLE "entity_taxonomy_tags" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "entity_taxonomy_tags" DROP CONSTRAINT IF EXISTS "entity_taxonomy_tags_tenant_id_not_null";
ALTER TABLE "entity_taxonomy_tags" DROP CONSTRAINT IF EXISTS "entity_taxonomy_tags_entity_id_fkey";
ALTER TABLE "entity_taxonomy_tags" DROP CONSTRAINT IF EXISTS "entity_taxonomy_tags_taxon_id_fkey";
