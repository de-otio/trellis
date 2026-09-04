-- Compliance plan 08 Phase 1 (additive, back-compat): RoutingClass enum, the
-- CONTENT ReportType value, Report.category_key, and the report_categories table.
-- NOTE: `prisma migrate dev` also emitted DROP INDEX for the hand-written
-- GiST/GIN/trigram indexes the Prisma schema cannot express
-- (entity_location_location_idx, tenant_directory_profile_desc_trgm_idx,
-- tenant_display_name_trgm_idx). Those drops were hand-pruned here, exactly as
-- the t8 (push_devices), t14, and open_social_web migrations did; this migration
-- is additive and must not drop those indexes.

-- CreateEnum
CREATE TYPE "RoutingClass" AS ENUM ('ILLEGAL_PRIORITY', 'ILLEGAL', 'POLICY_VIOLATION', 'FEEDBACK');

-- AlterEnum
ALTER TYPE "ReportType" ADD VALUE 'CONTENT';

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "category_key" TEXT;

-- CreateTable
CREATE TABLE "report_categories" (
    "key" TEXT NOT NULL,
    "routing_class" "RoutingClass" NOT NULL,
    "labels" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_categories_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "report_categories_active_sort_order_idx" ON "report_categories"("active", "sort_order");

-- CreateIndex
CREATE INDEX "reports_category_key_idx" ON "reports"("category_key");

-- CreateIndex
CREATE INDEX "reports_reporter_user_id_resource_type_resource_id_category_idx" ON "reports"("reporter_user_id", "resource_type", "resource_id", "category_key", "status");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_category_key_fkey" FOREIGN KEY ("category_key") REFERENCES "report_categories"("key") ON DELETE SET NULL ON UPDATE CASCADE;
