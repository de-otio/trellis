-- C2PA manifest sidecar summary on media_files.
--
-- PURELY ADDITIVE and entirely NULLABLE: five ADD COLUMNs with no default, no
-- backfill, no index, no constraint. Existing rows read as NULL, which is the
-- correct answer for them — they were ingested before the manifest was kept, so
-- "no manifest recorded" is the truth, not a gap to fill.
--
-- No `verified` column exists, deliberately. Trellis extracts the manifest and
-- never checks its signature; a column would be a place for a later change to
-- claim otherwise. See prisma/schema.prisma and
-- apps/api/src/lib/media/c2pa-sidecar.ts.
--
-- Do NOT let `prisma migrate dev` re-add DROP INDEX statements for the
-- hand-written PostGIS/pg_trgm indexes here — see the note in
-- 20260803153411_add_synthetic_provenance/migration.sql.

-- AlterTable
ALTER TABLE "media_files" ADD COLUMN     "c2pa_manifest_present" BOOLEAN,
ADD COLUMN     "c2pa_container" TEXT,
ADD COLUMN     "c2pa_sidecar_key" TEXT,
ADD COLUMN     "c2pa_sidecar_bytes" INTEGER,
ADD COLUMN     "c2pa_sidecar_sha256" TEXT;
