-- CreateEnum
CREATE TYPE "SyntheticSourceType" AS ENUM ('UNKNOWN', 'HUMAN_CREATED', 'AI_EDITED', 'AI_ASSISTED', 'AI_GENERATED');

-- CreateEnum
CREATE TYPE "SyntheticBasis" AS ENUM ('AUTHOR_DECLARED', 'PLATFORM_GENERATED', 'EMBEDDED_METADATA', 'CLASSIFIER_INFERRED');

-- NOTE: `prisma migrate dev` generated three DROP INDEX statements here and they
-- were REMOVED BY HAND. Do not restore them, and do not let them back into a
-- future migration.
--
--   DROP INDEX "entity_location_location_idx";              -- GiST, ST_DWithin/KNN (C7)
--   DROP INDEX "tenant_directory_profile_desc_trgm_idx";    -- GIN gin_trgm_ops
--   DROP INDEX "tenant_display_name_trgm_idx";              -- GIN gin_trgm_ops
--
-- All three are hand-written PostGIS/pg_trgm indexes created in raw SQL by the
-- init migration. Prisma cannot express GiST or gin_trgm_ops in schema.prisma,
-- so every `migrate dev` diff sees them as unknown drift and proposes dropping
-- them. Dropping them would silently destroy geo-proximity search
-- (ST_DWithin/KNN over entity_location.location) and directory similarity
-- search (similarity()/% over tenants.display_name and
-- tenant_directory_profiles.short_description) — a severe, hard-to-notice
-- performance regression, not a schema change.
--
-- This migration is therefore PURELY ADDITIVE: two enum types and three
-- ALTER TABLE ADD COLUMNs with safe defaults.

-- AlterTable
ALTER TABLE "media_files" ADD COLUMN     "embedded_source_type" "SyntheticSourceType" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "provenance_examined" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "post_media" ADD COLUMN     "declared_basis" "SyntheticBasis",
ADD COLUMN     "declared_source_type" "SyntheticSourceType" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "text_basis" "SyntheticBasis",
ADD COLUMN     "text_source_type" "SyntheticSourceType" NOT NULL DEFAULT 'UNKNOWN';
