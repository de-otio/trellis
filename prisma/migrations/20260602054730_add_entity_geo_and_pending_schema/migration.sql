/*
  Warnings:

  - Added the required column `tenant_id` to the `link_checks` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `post_geo_index` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `post_media` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `post_sentiments` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenant_id` to the `product_taxonomy_tags` table without a default value. This is not possible if the table is not empty.

*/
-- PostGIS: required for the entity_location.location geography column + GiST index (C7).
CREATE EXTENSION IF NOT EXISTS postgis;

-- AlterTable
ALTER TABLE "link_checks" ADD COLUMN     "tenant_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "post_geo_index" ADD COLUMN     "tenant_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "post_media" ADD COLUMN     "tenant_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "post_sentiments" ADD COLUMN     "tenant_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "product_taxonomy_tags" ADD COLUMN     "tenant_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "entity_location" (
    "entity_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "location" geography(Point, 4326) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_location_pkey" PRIMARY KEY ("entity_id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "tenant_id" TEXT,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_kind" TEXT,
    "resource_id" TEXT,
    "outcome" TEXT NOT NULL,
    "failure_reason" TEXT,
    "severity" TEXT NOT NULL,
    "request_id" TEXT,
    "trace_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "retention_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_location_tenant_id_idx" ON "entity_location"("tenant_id");

-- Spatial index for ST_DWithin / KNN (<->) proximity queries (C7).
CREATE INDEX "entity_location_location_idx" ON "entity_location" USING GIST ("location");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_idx" ON "audit_event"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_event_timestamp_idx" ON "audit_event"("timestamp");

-- CreateIndex
CREATE INDEX "audit_event_action_idx" ON "audit_event"("action");

-- CreateIndex
CREATE INDEX "audit_event_retention_until_idx" ON "audit_event"("retention_until");

-- CreateIndex
CREATE INDEX "link_checks_tenant_id_idx" ON "link_checks"("tenant_id");

-- CreateIndex
CREATE INDEX "post_geo_index_tenant_id_idx" ON "post_geo_index"("tenant_id");

-- CreateIndex
CREATE INDEX "post_media_tenant_id_idx" ON "post_media"("tenant_id");

-- CreateIndex
CREATE INDEX "post_sentiments_tenant_id_idx" ON "post_sentiments"("tenant_id");

-- CreateIndex
CREATE INDEX "product_taxonomy_tags_tenant_id_idx" ON "product_taxonomy_tags"("tenant_id");

-- AddForeignKey
ALTER TABLE "post_geo_index" ADD CONSTRAINT "post_geo_index_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_location" ADD CONSTRAINT "entity_location_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_sentiments" ADD CONSTRAINT "post_sentiments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_taxonomy_tags" ADD CONSTRAINT "product_taxonomy_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
