-- squawk-ignore-file prefer-bigint-over-int
--
-- The one int4 column below counts the bytes of a C2PA sidecar, which can never
-- exceed the upload it was copied out of; the image byte cap is orders of
-- magnitude below the 2^31 limit that rule guards. int4 also matches
-- media_files.size, which counts the same kind of thing — a bigint here would
-- disagree with its own table for no gain. Scoped to this FILE rather than added
-- to .squawk.toml so the rule keeps applying to every other migration.

-- C2PA manifest sidecar summary on media_files.
--
-- The ingest re-encode destroys any C2PA manifest along with the rest of the
-- metadata, and that strip stays. But the destruction is irreversible: once the
-- original bytes are gone nobody can check a Content Credentials claim about
-- that image again. So the manifest store is copied out before the strip into a
-- sidecar object, and summarised in these columns. See
-- apps/api/src/lib/media/c2pa-sidecar.ts and prisma/schema.prisma.
--
-- PURELY ADDITIVE and entirely NULLABLE: five ADD COLUMNs with no default, no
-- backfill, no index, no constraint. Existing rows read as NULL, which is the
-- truth for them — they were ingested before the manifest was kept, so this is
-- not a gap to fill later.
--
-- There is deliberately NO `verified` column. Trellis extracts the manifest and
-- never checks its signature; a column would be somewhere for a later change to
-- claim otherwise. The API emits a constant `verified: false` instead.
--
-- House style (M7b): timeout prologue so a lock queue fails fast instead of
-- stalling the app; robust (re-runnable) statements throughout.
--
-- Do NOT let `prisma migrate dev` re-add DROP INDEX statements for the
-- hand-written PostGIS/pg_trgm indexes here — see the note in
-- 20260803153411_add_synthetic_provenance/migration.sql.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- Nullable columns with no default are catalog-only changes (no table rewrite).
ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "c2pa_manifest_present" BOOLEAN;

ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "c2pa_container" TEXT;

ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "c2pa_sidecar_key" TEXT;

-- int4, not bigint — see the file-scoped ignore and its reasoning at the top.
ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "c2pa_sidecar_bytes" INTEGER;

ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "c2pa_sidecar_sha256" TEXT;
