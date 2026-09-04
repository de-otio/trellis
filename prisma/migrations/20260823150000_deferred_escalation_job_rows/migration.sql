-- Plan 031, C1 (the deferred moderation lane's call site) — part 1 of 2.
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
-- Additive only. The unique index on parent_job_id is created CONCURRENTLY in
-- the NEXT migration file — Prisma applies each file transactionally unless it
-- must not, and `CREATE INDEX CONCURRENTLY` cannot share a transaction with
-- these ALTERs, so the split follows the M7a/M7b precedent.
--
-- House style (M7b): timeout prologue so a lock queue fails fast instead of
-- stalling the app; robust (re-runnable) statements throughout.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- CREATE TYPE has no IF NOT EXISTS; the guard makes the file re-runnable.
DO $$ BEGIN
  CREATE TYPE "ModerationJobPriority" AS ENUM ('interactive', 'deferred');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- NOT NULL with a constant DEFAULT is a catalog-only change on PostgreSQL 11+
-- (no table rewrite); this estate runs PostgreSQL 17.
ALTER TABLE "media_moderation_jobs"
  ADD COLUMN IF NOT EXISTS "priority" "ModerationJobPriority" NOT NULL DEFAULT 'interactive';

ALTER TABLE "media_moderation_jobs"
  ADD COLUMN IF NOT EXISTS "parent_job_id" TEXT;
