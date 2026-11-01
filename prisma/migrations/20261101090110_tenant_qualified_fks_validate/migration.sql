-- Tenant-qualified foreign keys, step 3 of 4: validate existing rows.
--
-- VALIDATE scans each child but takes only SHARE UPDATE EXCLUSIVE on it (ROW
-- SHARE on the parent): reads and writes keep flowing. Validating an
-- already-valid constraint is a no-op, so this file is re-runnable.
--
-- A row whose parent sits in another tenant fails VALIDATE and stops
-- `migrate deploy` here, naming the key. Find out how the row was written
-- before repairing it by hand, then `prisma migrate resolve`.
--
-- squawk's prefer-robust-stmts: VALIDATE is already idempotent, which is what
-- the rule is after (precedent 20260904090020_compliance_reports_dedupe_idx_fk_validate).

SET lock_timeout = '1s';
SET statement_timeout = '5min';

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_media" VALIDATE CONSTRAINT "post_media_tenant_id_post_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_media" VALIDATE CONSTRAINT "post_media_tenant_id_media_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_sentiments" VALIDATE CONSTRAINT "post_sentiments_tenant_id_post_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "post_comments" VALIDATE CONSTRAINT "post_comments_tenant_id_post_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "taxonomy_categories" VALIDATE CONSTRAINT "taxonomy_categories_tenant_id_dimension_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "taxonomy_taxons" VALIDATE CONSTRAINT "taxonomy_taxons_tenant_id_category_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "product_taxonomy_tags" VALIDATE CONSTRAINT "product_taxonomy_tags_tenant_id_taxon_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_ownerships" VALIDATE CONSTRAINT "entity_ownerships_tenant_id_entity_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "group_members" VALIDATE CONSTRAINT "group_members_tenant_id_group_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "link_checks" VALIDATE CONSTRAINT "link_checks_tenant_id_post_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "link_checks" VALIDATE CONSTRAINT "link_checks_tenant_id_comment_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "connection_code_redemptions" VALIDATE CONSTRAINT "connection_code_redemptions_tenant_id_code_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "event_rsvps" VALIDATE CONSTRAINT "event_rsvps_tenant_id_event_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "event_shifts" VALIDATE CONSTRAINT "event_shifts_tenant_id_event_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "event_shift_signups" VALIDATE CONSTRAINT "event_shift_signups_tenant_id_shift_id_fkey";

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "tenant_classification_tags" VALIDATE CONSTRAINT "tenant_classification_tags_tenant_id_classification_id_fkey";
