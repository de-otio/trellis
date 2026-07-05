-- T14 — presigned direct-to-S3 uploads + AR4 lifecycle consolidation.
--
-- 1. media_files: consolidate the former moderation_status enum column +
--    upload_status string column into ONE `lifecycle` MediaLifecycle column.
--    Existing rows are mapped (dev data only — nothing is live):
--      moderation_status APPROVED/REVIEW/QUARANTINED/REJECTED -> same name
--      moderation_status PENDING + upload_status FAILED       -> UPLOAD_FAILED
--      moderation_status PENDING + anything else              -> UPLOADED
--        (a pre-T14 PENDING row was created only AFTER its bytes were written
--         by the proxied upload path, so its bytes are present = UPLOADED)
--
-- 2. upload_sessions: add the presigned-session columns (kind discriminator +
--    tenant/media/object-key/declared-metadata/uploaded-at). Legacy rows keep
--    working via kind='legacy' default.
--
-- NOTE: the hand-written raw indexes from the init migration
-- (entity_location_location_idx GiST, *_trgm_idx GIN) are NOT touched here —
-- prisma migrate dev proposes dropping them because they are not representable
-- in schema.prisma; those DROPs are deliberately removed from this migration.

-- CreateEnum
CREATE TYPE "MediaLifecycle" AS ENUM ('AWAITING_UPLOAD', 'UPLOADED', 'APPROVED', 'REVIEW', 'QUARANTINED', 'REJECTED', 'UPLOAD_FAILED');

-- AlterTable: add the consolidated column first (default = fail-closed born state)
ALTER TABLE "media_files" ADD COLUMN "lifecycle" "MediaLifecycle" NOT NULL DEFAULT 'AWAITING_UPLOAD';

-- Data mapping: carry the old two-column state into the consolidated column.
UPDATE "media_files" SET "lifecycle" = CASE
  WHEN "moderation_status" = 'APPROVED'    THEN 'APPROVED'::"MediaLifecycle"
  WHEN "moderation_status" = 'REVIEW'      THEN 'REVIEW'::"MediaLifecycle"
  WHEN "moderation_status" = 'QUARANTINED' THEN 'QUARANTINED'::"MediaLifecycle"
  WHEN "moderation_status" = 'REJECTED'    THEN 'REJECTED'::"MediaLifecycle"
  -- moderation_status = PENDING: split by the old upload column.
  WHEN "upload_status" = 'FAILED'          THEN 'UPLOAD_FAILED'::"MediaLifecycle"
  ELSE 'UPLOADED'::"MediaLifecycle"
END;

-- DropIndex (the two consolidated columns' indexes)
DROP INDEX "media_files_moderation_status_idx";

-- DropIndex
DROP INDEX "media_files_upload_status_idx";

-- AlterTable: drop the consolidated-away columns
ALTER TABLE "media_files" DROP COLUMN "moderation_status",
DROP COLUMN "upload_status";

-- AlterTable
ALTER TABLE "upload_sessions" ADD COLUMN     "declared_bytes" INTEGER,
ADD COLUMN     "declared_mime_type" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "media_id" TEXT,
ADD COLUMN     "object_key" TEXT,
ADD COLUMN     "tenant_id" TEXT,
ADD COLUMN     "uploaded_at" TIMESTAMP(3);

-- DropEnum
DROP TYPE "ModerationStatus";

-- CreateIndex
CREATE INDEX "media_files_lifecycle_idx" ON "media_files"("lifecycle");

-- CreateIndex
CREATE INDEX "upload_sessions_media_id_idx" ON "upload_sessions"("media_id");
