-- Plan 031, C1 — part 2 of 2: the parent-uniqueness that makes the trigger
-- idempotent.
--
-- `parent_job_id` is UNIQUE: at most one escalation per interactive job. A
-- retried delivery re-finds the same escalation row, re-derives the same
-- dedupe key, and the engine absorbs the idempotency collision — that chain
-- starts at this index.
--
-- Separate file because `CREATE INDEX CONCURRENTLY` cannot run inside the
-- transaction Prisma wraps part 1 in (M7a/M7b precedent; M7b's header records
-- the local verification that a timeout prologue ahead of a CONCURRENTLY
-- statement applies cleanly under `prisma migrate`).

SET lock_timeout = '1s';
SET statement_timeout = '30s';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "media_moderation_jobs_parent_job_id_key"
  ON "media_moderation_jobs"("parent_job_id");
