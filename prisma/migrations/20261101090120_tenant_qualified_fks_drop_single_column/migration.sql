-- Tenant-qualified foreign keys, step 4 of 4: drop the single-column FKs.
--
-- Each composite key added in step 2 and validated in step 3 implies the old
-- one (tenant_id is NOT NULL on both sides; MATCH SIMPLE still skips a NULL
-- <col>, as before), so nothing is lost. Each DROP takes a brief ACCESS
-- EXCLUSIVE lock on the child and the parent; statements commit one at a time
-- (see step 2's header), so no lock is held across them, and IF EXISTS makes
-- a re-run after a part-way failure safe.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_post_id_fkey";

ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_media_id_fkey";

ALTER TABLE "post_sentiments" DROP CONSTRAINT IF EXISTS "post_sentiments_post_id_fkey";

ALTER TABLE "post_comments" DROP CONSTRAINT IF EXISTS "post_comments_post_id_fkey";

ALTER TABLE "taxonomy_categories" DROP CONSTRAINT IF EXISTS "taxonomy_categories_dimension_id_fkey";

ALTER TABLE "taxonomy_taxons" DROP CONSTRAINT IF EXISTS "taxonomy_taxons_category_id_fkey";

ALTER TABLE "product_taxonomy_tags" DROP CONSTRAINT IF EXISTS "product_taxonomy_tags_taxon_id_fkey";

ALTER TABLE "entity_ownerships" DROP CONSTRAINT IF EXISTS "entity_ownerships_entity_id_fkey";

ALTER TABLE "group_members" DROP CONSTRAINT IF EXISTS "group_members_group_id_fkey";

ALTER TABLE "link_checks" DROP CONSTRAINT IF EXISTS "link_checks_post_id_fkey";

ALTER TABLE "link_checks" DROP CONSTRAINT IF EXISTS "link_checks_comment_id_fkey";

ALTER TABLE "connection_code_redemptions" DROP CONSTRAINT IF EXISTS "connection_code_redemptions_code_id_fkey";

ALTER TABLE "event_rsvps" DROP CONSTRAINT IF EXISTS "event_rsvps_event_id_fkey";

ALTER TABLE "event_shifts" DROP CONSTRAINT IF EXISTS "event_shifts_event_id_fkey";

ALTER TABLE "event_shift_signups" DROP CONSTRAINT IF EXISTS "event_shift_signups_shift_id_fkey";

ALTER TABLE "tenant_classification_tags" DROP CONSTRAINT IF EXISTS "tenant_classification_tags_classification_id_fkey";
