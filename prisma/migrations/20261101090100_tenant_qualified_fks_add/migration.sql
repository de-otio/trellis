-- Tenant-qualified foreign keys, step 2 of 4: add the composite keys NOT VALID.
--
-- Each child row already carries its own tenant_id. A single-column FK only
-- proves the parent row exists; (tenant_id, <col>) -> parent (tenant_id, id)
-- also proves the parent belongs to the child's tenant. This holds for every
-- client: extended or not, raw SQL included, and whether or not row security
-- is armed (Postgres runs FK checks without row security).
--
-- ON UPDATE NO ACTION, deliberately not Prisma's default CASCADE: a cascade
-- would carry a parent's tenant_id change into every child. NO ACTION makes
-- that change fail while children exist.
--
-- NOT VALID: new and updated rows are checked from commit; existing rows are
-- checked in step 3 under a weaker lock. The old single-column FKs stay in
-- place until step 4, so there is no window without a foreign key.
--
-- squawk's prefer-robust-stmts wants IF NOT EXISTS or a transaction; ADD
-- CONSTRAINT has no IF NOT EXISTS and Prisma already runs this file in a
-- transaction, so a failure rolls the whole file back.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "posts"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_tenant_id_media_id_fkey"
  FOREIGN KEY ("tenant_id", "media_id") REFERENCES "media_files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_sentiments" ADD CONSTRAINT "post_sentiments_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "posts"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "posts"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "taxonomy_categories" ADD CONSTRAINT "taxonomy_categories_tenant_id_dimension_id_fkey"
  FOREIGN KEY ("tenant_id", "dimension_id") REFERENCES "taxonomy_dimensions"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "taxonomy_taxons" ADD CONSTRAINT "taxonomy_taxons_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "taxonomy_categories"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "product_taxonomy_tags" ADD CONSTRAINT "product_taxonomy_tags_tenant_id_taxon_id_fkey"
  FOREIGN KEY ("tenant_id", "taxon_id") REFERENCES "taxonomy_taxons"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_tenant_id_entity_id_fkey"
  FOREIGN KEY ("tenant_id", "entity_id") REFERENCES "entities"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_group_id_fkey"
  FOREIGN KEY ("tenant_id", "group_id") REFERENCES "groups"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_tenant_id_post_id_fkey"
  FOREIGN KEY ("tenant_id", "post_id") REFERENCES "posts"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_tenant_id_comment_id_fkey"
  FOREIGN KEY ("tenant_id", "comment_id") REFERENCES "post_comments"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "connection_code_redemptions" ADD CONSTRAINT "connection_code_redemptions_tenant_id_code_id_fkey"
  FOREIGN KEY ("tenant_id", "code_id") REFERENCES "connection_codes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_tenant_id_event_id_fkey"
  FOREIGN KEY ("tenant_id", "event_id") REFERENCES "events"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "event_shifts" ADD CONSTRAINT "event_shifts_tenant_id_event_id_fkey"
  FOREIGN KEY ("tenant_id", "event_id") REFERENCES "events"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "event_shift_signups" ADD CONSTRAINT "event_shift_signups_tenant_id_shift_id_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "event_shifts"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "tenant_classification_tags" ADD CONSTRAINT "tenant_classification_tags_tenant_id_classification_id_fkey"
  FOREIGN KEY ("tenant_id", "classification_id") REFERENCES "tenant_classifications"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
