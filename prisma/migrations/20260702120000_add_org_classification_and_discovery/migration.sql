-- Org classification, directory & discovery (MVP / Phase 1).
-- Additive-only: no existing column is dropped or renamed. See
-- analysis/org-classification-and-discovery/05-schema-changes.md.

-- CreateEnum
CREATE TYPE "VerificationSource" AS ENUM ('SELF_DECLARED', 'TECHSOUP', 'HAUS_DES_STIFTENS', 'PLATFORM_MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "LocationPrecision" AS ENUM ('EXACT', 'NEIGHBORHOOD', 'CITY', 'HIDDEN');

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "author_org_root_category_code" TEXT;

-- CreateTable
CREATE TABLE "platform_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "synonyms" JSONB,
    "translations" JSONB,
    "parent_category_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_classifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "verification_source" "VerificationSource" NOT NULL DEFAULT 'SELF_DECLARED',
    "verified_at" TIMESTAMP(3),
    "verified_by_ref" TEXT,
    "verification_revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_classification_tags" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "classification_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "tenant_classification_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_directory_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "is_discoverable" BOOLEAN NOT NULL DEFAULT false,
    "short_description" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "displayLat" DOUBLE PRECISION,
    "displayLng" DOUBLE PRECISION,
    "location_label" TEXT,
    "location_precision" "LocationPrecision" NOT NULL DEFAULT 'CITY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_directory_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_categories_code_key" ON "platform_categories"("code");

-- CreateIndex
CREATE INDEX "platform_categories_parent_category_id_idx" ON "platform_categories"("parent_category_id");

-- CreateIndex
CREATE INDEX "platform_categories_is_active_idx" ON "platform_categories"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_classifications_tenant_id_key" ON "tenant_classifications"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_classifications_category_id_idx" ON "tenant_classifications"("category_id");

-- CreateIndex
CREATE INDEX "tenant_classifications_verification_source_idx" ON "tenant_classifications"("verification_source");

-- CreateIndex
CREATE INDEX "tenant_classification_tags_tenant_id_idx" ON "tenant_classification_tags"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_classification_tags_category_id_idx" ON "tenant_classification_tags"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_classification_tags_classification_id_category_id_key" ON "tenant_classification_tags"("classification_id", "category_id");

-- CreateIndex
CREATE INDEX "tenant_directory_profiles_is_discoverable_idx" ON "tenant_directory_profiles"("is_discoverable");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_directory_profiles_tenant_id_key" ON "tenant_directory_profiles"("tenant_id");

-- CreateIndex
CREATE INDEX "posts_author_org_root_category_code_created_at_idx" ON "posts"("author_org_root_category_code", "created_at");

-- AddForeignKey
ALTER TABLE "platform_categories" ADD CONSTRAINT "platform_categories_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "platform_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classifications" ADD CONSTRAINT "tenant_classifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classifications" ADD CONSTRAINT "tenant_classifications_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "platform_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classification_tags" ADD CONSTRAINT "tenant_classification_tags_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "tenant_classifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_classification_tags" ADD CONSTRAINT "tenant_classification_tags_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "platform_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_directory_profiles" ADD CONSTRAINT "tenant_directory_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Raw-SQL search infrastructure (not expressible as Prisma field annotations).
-- ============================================================================

-- pg_trgm powers typo-tolerant name/description search (directory).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN indexes for similarity() / % matching on directory search fields.
CREATE INDEX "tenant_display_name_trgm_idx" ON "tenants" USING GIN ("display_name" gin_trgm_ops);
CREATE INDEX "tenant_directory_profile_desc_trgm_idx" ON "tenant_directory_profiles" USING GIN ("short_description" gin_trgm_ops);

-- PostGIS: proximity search over the directory profile's lat/lng. Matches the
-- EntityLocation spatial-index shape (USING GIST over a geography(Point,4326)).
-- TenantDirectoryProfile stores lat/lng as plain columns (per the schema spec,
-- no stored geography column), so this is an expression index over the same
-- ST_MakePoint(lng, lat)::geography value ST_DWithin will filter on.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE INDEX "tenant_directory_profile_location_idx" ON "tenant_directory_profiles" USING GIST ((ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography));
