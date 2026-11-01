-- Join tables carry their own tenant_id, step 1 of 2: add the column, backfill
-- it, and add the constraints NOT VALID.
--
-- post_subjects (posts x entities), post_taxonomy_tags (posts x taxons) and
-- entity_taxonomy_tags (entities x taxons) joined two tenant-holding parents
-- with no tenant of their own, so no FK could say both parents share a tenant.
-- Each now gets a tenant_id, and both of its FKs become tenant-qualified
-- ((tenant_id, <col>) -> parent(tenant_id, id)), so a row can only join two
-- rows of one tenant. Same shape as the other tenant-qualified FKs
-- (20261101090100_tenant_qualified_fks_add), plus a direct FK to tenants
-- (P1 convention, like post_media).
--
-- Backfill: tenant_id comes from the first parent (the post, or the entity for
-- entity_taxonomy_tags). A row whose other parent is in a different tenant
-- then fails the VALIDATE in step 2, naming the key: find out how it was
-- written before repairing it by hand.
--
-- NOT NULL without a long ACCESS EXCLUSIVE scan: a CHECK (tenant_id IS NOT
-- NULL) is added NOT VALID here and validated in step 2, after which SET NOT
-- NULL uses it instead of scanning.
--
-- Order matters: the CHECK goes in BEFORE the backfill. A NOT VALID CHECK
-- still applies to new rows, so once it exists an application version that
-- predates this release (it inserts these rows without tenant_id) is refused
-- at once, instead of writing a NULL after the backfill that would then stop
-- step 2. Roll the application out right after migrating. Rows inserted in
-- the moment between ADD COLUMN and the CHECK are caught by the backfill.
--
-- The backfill is one UPDATE per table, bounded by statement_timeout; on a
-- large table, batch it by hand first (it skips rows already set).
--
-- Statements commit one at a time (see 20261101090100's header); each ADD is
-- guarded by a pg_constraint lookup, so the file can be re-run.

SET lock_timeout = '1s';
SET statement_timeout = '5min';

-- post_subjects
ALTER TABLE "post_subjects" ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_subjects_tenant_id_not_null' AND conrelid = '"post_subjects"'::regclass) THEN
    ALTER TABLE "post_subjects" ADD CONSTRAINT "post_subjects_tenant_id_not_null"
      CHECK ("tenant_id" IS NOT NULL) NOT VALID;
  END IF;
END
$$;

UPDATE "post_subjects" AS c SET "tenant_id" = p."tenant_id"
  FROM "posts" AS p
 WHERE p."id" = c."post_id" AND c."tenant_id" IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_subjects_tenant_id_fkey' AND conrelid = '"post_subjects"'::regclass) THEN
    ALTER TABLE "post_subjects" ADD CONSTRAINT "post_subjects_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_subjects_tenant_id_post_id_fkey' AND conrelid = '"post_subjects"'::regclass) THEN
    ALTER TABLE "post_subjects" ADD CONSTRAINT "post_subjects_tenant_id_post_id_fkey"
      FOREIGN KEY ("tenant_id", "post_id") REFERENCES "posts"("tenant_id", "id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_subjects_tenant_id_entity_id_fkey' AND conrelid = '"post_subjects"'::regclass) THEN
    ALTER TABLE "post_subjects" ADD CONSTRAINT "post_subjects_tenant_id_entity_id_fkey"
      FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END
$$;

-- post_taxonomy_tags
ALTER TABLE "post_taxonomy_tags" ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_taxonomy_tags_tenant_id_not_null' AND conrelid = '"post_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "post_taxonomy_tags" ADD CONSTRAINT "post_taxonomy_tags_tenant_id_not_null"
      CHECK ("tenant_id" IS NOT NULL) NOT VALID;
  END IF;
END
$$;

UPDATE "post_taxonomy_tags" AS c SET "tenant_id" = p."tenant_id"
  FROM "posts" AS p
 WHERE p."id" = c."post_id" AND c."tenant_id" IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_taxonomy_tags_tenant_id_fkey' AND conrelid = '"post_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "post_taxonomy_tags" ADD CONSTRAINT "post_taxonomy_tags_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_taxonomy_tags_tenant_id_post_id_fkey' AND conrelid = '"post_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "post_taxonomy_tags" ADD CONSTRAINT "post_taxonomy_tags_tenant_id_post_id_fkey"
      FOREIGN KEY ("tenant_id", "post_id") REFERENCES "posts"("tenant_id", "id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'post_taxonomy_tags_tenant_id_taxon_id_fkey' AND conrelid = '"post_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "post_taxonomy_tags" ADD CONSTRAINT "post_taxonomy_tags_tenant_id_taxon_id_fkey"
      FOREIGN KEY ("tenant_id", "taxon_id") REFERENCES "taxonomy_taxons"("tenant_id", "id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END
$$;

-- entity_taxonomy_tags
ALTER TABLE "entity_taxonomy_tags" ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'entity_taxonomy_tags_tenant_id_not_null' AND conrelid = '"entity_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "entity_taxonomy_tags" ADD CONSTRAINT "entity_taxonomy_tags_tenant_id_not_null"
      CHECK ("tenant_id" IS NOT NULL) NOT VALID;
  END IF;
END
$$;

UPDATE "entity_taxonomy_tags" AS c SET "tenant_id" = p."tenant_id"
  FROM "entities" AS p
 WHERE p."id" = c."entity_id" AND c."tenant_id" IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'entity_taxonomy_tags_tenant_id_fkey' AND conrelid = '"entity_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "entity_taxonomy_tags" ADD CONSTRAINT "entity_taxonomy_tags_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'entity_taxonomy_tags_tenant_id_entity_id_fkey' AND conrelid = '"entity_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "entity_taxonomy_tags" ADD CONSTRAINT "entity_taxonomy_tags_tenant_id_entity_id_fkey"
      FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'entity_taxonomy_tags_tenant_id_taxon_id_fkey' AND conrelid = '"entity_taxonomy_tags"'::regclass) THEN
    ALTER TABLE "entity_taxonomy_tags" ADD CONSTRAINT "entity_taxonomy_tags_tenant_id_taxon_id_fkey"
      FOREIGN KEY ("tenant_id", "taxon_id") REFERENCES "taxonomy_taxons"("tenant_id", "id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END
$$;
