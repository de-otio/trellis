-- media_moderation_jobs.job_id becomes NULLABLE.
--
-- A reserved placeholder row records that a media object WILL be moderated on a
-- track before the provider job for that track exists, so a completion for one
-- track can tell a sibling that has not started yet from one that never will
-- (see CompletionStore.reserveTracks). A placeholder has no provider job id.
--
-- ADDITIVE: dropping NOT NULL widens what the column accepts; no existing row
-- changes, no default, no backfill, no new index. The existing UNIQUE index on
-- job_id is kept as is: Postgres treats NULLs as distinct, so any number of
-- placeholders may coexist while a real job id stays unique.
--
-- House style (M7b): timeout prologue so a lock queue fails fast instead of
-- stalling the app. DROP NOT NULL is a catalog-only change (no table scan, no
-- rewrite) on every supported Postgres version.
--
-- Do NOT let `prisma migrate dev` re-add DROP INDEX statements for the
-- hand-written PostGIS/pg_trgm indexes here — see the note in
-- 20260803153411_add_synthetic_provenance/migration.sql.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

ALTER TABLE "media_moderation_jobs"
  ALTER COLUMN "job_id" DROP NOT NULL;
