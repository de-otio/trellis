-- Plan 031, C1 (the deferred moderation lane's call site).
--
-- An escalation is ITS OWN MediaModerationJob row. Two reasons, both
-- load-bearing (plan 031 §status, "the dedupe key is already claimed"):
--
--  1. The completion dedupe key is SHA-256(contentHash, jobId, track). If the
--     escalation re-entered under the PARENT's jobId, it would derive the SAME
--     key the inline completion already claimed, `claimMessage` would return
--     false, and the escalated verdict would be silently discarded with the
--     reasoning-model call already paid for. A distinct row gives it a distinct
--     jobId and therefore a distinct key.
--  2. The escalation's verdict comes from a DIFFERENT model under a DIFFERENT
--     taxonomy; its row carries the deferred lane's own threshold snapshot so
--     re-interpretation does not floor at `review` via the inline taxonomy pin.
--
-- `parent_job_id` is UNIQUE: at most one escalation per interactive job. That
-- uniqueness is what makes the trigger idempotent end to end — a retried
-- delivery re-finds the same escalation row, re-derives the same dedupe key,
-- and the engine absorbs the idempotency collision.
--
-- Additive only: a new enum, two nullable-or-defaulted columns, one unique
-- index. No rewrite of existing rows beyond the DEFAULT fill.

CREATE TYPE "ModerationJobPriority" AS ENUM ('interactive', 'deferred');

ALTER TABLE "media_moderation_jobs"
  ADD COLUMN "priority" "ModerationJobPriority" NOT NULL DEFAULT 'interactive',
  ADD COLUMN "parent_job_id" TEXT;

CREATE UNIQUE INDEX "media_moderation_jobs_parent_job_id_key"
  ON "media_moderation_jobs"("parent_job_id");
