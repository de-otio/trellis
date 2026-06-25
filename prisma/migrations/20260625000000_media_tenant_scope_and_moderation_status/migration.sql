-- T8: MediaFile tenant-scope reclassification + moderation status (D18, D13).
--
-- Summary of changes:
--   + tenantId (NOT NULL) — every object belongs to exactly one tenant
--   + ModerationStatus enum — PENDING | APPROVED | REVIEW | QUARANTINED | REJECTED
--   + moderationStatus column defaulting to PENDING (fail-closed)
--   - contentHash @unique (bare global unique) dropped
--   + @@unique([tenantId, contentHash]) — within-tenant dedup replaces global dedup
--   - gpsLatitude / gpsLongitude columns dropped (data-minimization, D13)
--   - @@index([gpsLatitude, gpsLongitude]) dropped with the columns
--   ~ metadataVisible default changed true -> false (D13 P0a)
--   + @@index([moderationStatus]) — moderation-queue queries
--   + @@index([tenantId, contentHash]) — tenant-scoped CAS serve path
--
-- Greenfield: Skybber is not live. No backfill. Dev media wiped + re-seeded
-- (human checkpoint per README §9 item 1 before apply).

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REVIEW', 'QUARANTINED', 'REJECTED');

-- AlterTable: add tenantId (NOT NULL), moderationStatus; drop GPS columns;
-- flip metadataVisible default.
ALTER TABLE "media_files"
    ADD COLUMN "tenant_id" TEXT NOT NULL,
    ADD COLUMN "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    DROP COLUMN "gps_latitude",
    DROP COLUMN "gps_longitude",
    ALTER COLUMN "metadata_visible" SET DEFAULT false;

-- DropIndex: remove bare global unique on content_hash
DROP INDEX "media_files_content_hash_key";

-- DropIndex: remove GPS composite index (columns gone)
DROP INDEX "media_files_gps_latitude_gps_longitude_idx";

-- CreateIndex: within-tenant dedup (replaces bare @unique)
CREATE UNIQUE INDEX "media_files_tenant_id_content_hash_key" ON "media_files"("tenant_id", "content_hash");

-- CreateIndex: moderation queue lookups
CREATE INDEX "media_files_moderation_status_idx" ON "media_files"("moderation_status");

-- CreateIndex: tenant-scoped CAS serve path
CREATE INDEX "media_files_tenant_id_content_hash_idx" ON "media_files"("tenant_id", "content_hash");

-- AddForeignKey: tenantId references tenants
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
