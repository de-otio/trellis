-- P0b: moderation job tracking — schema additions.
--
-- Summary of changes:
--   ~ media_files.original_key: DROP NOT NULL (nullable for video pending transcode)
--   ~ media_files.content_hash: DROP NOT NULL (null until the worker hashes the
--     transcoded bytes; @@unique([tenant, content_hash]) tolerates many NULLs)
--   + media_files.upload_id (TEXT, UNIQUE, nullable) — client idempotency key
--   + CREATE TYPE moderation_track AS ENUM ('VISUAL', 'AUDIO')
--   + CREATE TABLE media_moderation_jobs — per-track job records with FK + indexes
--   + CREATE TABLE processed_moderation_messages — SQS exactly-once dedup table
--
-- Not deployed standalone: consumed by Trellis as an npm dependency; migration
-- is applied when Trellis bumps @de-otio/trellis and runs prisma migrate deploy.

-- AlterTable: make original_key nullable (video rows have no key until post-transcode)
ALTER TABLE "media_files"
    ALTER COLUMN "original_key" DROP NOT NULL;

-- AlterTable: make content_hash nullable (video has no hash until the worker
-- hashes the transcoded bytes; the within-tenant unique tolerates many NULLs)
ALTER TABLE "media_files"
    ALTER COLUMN "content_hash" DROP NOT NULL;

-- AlterTable: add upload_id for client-side idempotency
ALTER TABLE "media_files"
    ADD COLUMN "upload_id" TEXT;

-- CreateIndex: unique constraint on upload_id (one row per upload session)
CREATE UNIQUE INDEX "media_files_upload_id_key" ON "media_files"("upload_id");

-- CreateEnum: moderation track discriminator
CREATE TYPE "ModerationTrack" AS ENUM ('VISUAL', 'AUDIO');

-- CreateTable: per-track moderation job records
CREATE TABLE "media_moderation_jobs" (
    "id"                 TEXT NOT NULL,
    "media_id"           TEXT NOT NULL,
    "track"              "ModerationTrack" NOT NULL,
    "job_id"             TEXT NOT NULL,
    "decision"           TEXT,
    "threshold_snapshot" JSONB NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_moderation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique constraint on job_id (one row per provider job)
CREATE UNIQUE INDEX "media_moderation_jobs_job_id_key" ON "media_moderation_jobs"("job_id");

-- CreateIndex: lookup jobs by media (used by the pipeline to find in-flight jobs)
CREATE INDEX "media_moderation_jobs_media_id_idx" ON "media_moderation_jobs"("media_id");

-- CreateIndex: lookup by job_id (used by the result-callback path)
CREATE INDEX "media_moderation_jobs_job_id_idx" ON "media_moderation_jobs"("job_id");

-- AddForeignKey: media_moderation_jobs -> media_files (cascade on delete)
ALTER TABLE "media_moderation_jobs"
    ADD CONSTRAINT "media_moderation_jobs_media_id_fkey"
    FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: SQS exactly-once dedup for moderation result messages
CREATE TABLE "processed_moderation_messages" (
    "id"                  TEXT NOT NULL,
    "message_dedupe_key"  TEXT NOT NULL,
    "processed_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_moderation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique constraint on dedupe key (collision = duplicate message)
CREATE UNIQUE INDEX "processed_moderation_messages_message_dedupe_key_key"
    ON "processed_moderation_messages"("message_dedupe_key");
