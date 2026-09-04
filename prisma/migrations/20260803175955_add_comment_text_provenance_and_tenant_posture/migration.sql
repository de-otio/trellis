-- Synthetic-content provenance, phase 2 (AI Act Art. 50 — decisions D14, D15):
--   * comment TEXT declarations, parallel to Post.textSourceType/textBasis
--   * per-tenant disclosure posture (NULL = platform default, from env)
--
-- Comment MEDIA deliberately gets no columns: nothing in the codebase creates a
-- PostCommentMedia row, so the feature does not exist and columns nothing can
-- write would assert coverage we do not have. See the note on the model.
--
-- Purely additive. Every column is nullable or has a default, so this is
-- backward-compatible with a running previous release.
--
-- !! THREE `DROP INDEX` STATEMENTS WERE REMOVED FROM THE GENERATED SQL BY HAND !!
--
-- `prisma migrate dev` proposed dropping `entity_location_location_idx` (GiST,
-- backs ST_DWithin/KNN geo-proximity), `tenant_display_name_trgm_idx` and
-- `tenant_directory_profile_desc_trgm_idx` (GIN gin_trgm_ops, back directory
-- similarity search). All three are hand-written raw SQL from the `init`
-- migration; Prisma cannot express GiST or gin_trgm_ops in schema.prisma, so it
-- reads them as unknown drift and proposes the drop on EVERY migration it
-- generates. Dropping them is a severe performance regression with no error and
-- no failing test.
--
-- This is the SECOND migration to hit it, so it is no longer treated as
-- something a reviewer will catch: `scripts/check-migration-sql.mjs` now runs in
-- CI (schema-drift job) and fails on any DROP INDEX that lacks an explicit
-- `-- ALLOW-DROP-INDEX: <reason>` marker.

-- CreateEnum
CREATE TYPE "TenantDisclosurePosture" AS ENUM ('OPTIONAL', 'REQUIRED_FOR_AI', 'PROMPTED');

-- AlterTable
ALTER TABLE "post_comments" ADD COLUMN     "text_basis" "SyntheticBasis",
ADD COLUMN     "text_source_type" "SyntheticSourceType" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "disclosure_posture" "TenantDisclosurePosture";
