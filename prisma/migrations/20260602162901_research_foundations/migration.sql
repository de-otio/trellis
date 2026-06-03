-- Research foundations (one-way-door): purpose-tagged append-only consent,
-- a fail-closed age signal, and groundwork for keyed research pseudonyms.
--
-- DATA-PRESERVING: the old `cross_region_consent` table is RENAMED to
-- `consent` (NOT dropped + recreated), so existing cross-region consent rows
-- survive. New columns are added with backfill-safe defaults.

-- ── 1. ConsentPurpose enum ───────────────────────────────────────────────
CREATE TYPE "ConsentPurpose" AS ENUM (
    'CROSS_REGION',
    'RESEARCH_OBSERVATION',
    'RESEARCH_PARTICIPATION'
);

-- ── 2. Rename table cross_region_consent -> consent (data-preserving) ─────
ALTER TABLE "cross_region_consent" RENAME TO "consent";

-- Rename the carried-over constraints/indexes to the new table name so they
-- match Prisma's generated names and drift detection stays quiet.
ALTER TABLE "consent" RENAME CONSTRAINT "cross_region_consent_pkey" TO "consent_pkey";
ALTER TABLE "consent" RENAME CONSTRAINT "cross_region_consent_user_id_fkey" TO "consent_user_id_fkey";
ALTER INDEX "cross_region_consent_user_id_idx" RENAME TO "consent_user_id_idx";
ALTER INDEX "cross_region_consent_consented_idx" RENAME TO "consent_consented_idx";
ALTER INDEX "cross_region_consent_data_region_access_region_idx" RENAME TO "consent_data_region_access_region_idx";

-- ── 3. Drop the old whole-table cross-region unique constraint ────────────
-- It is replaced below by a PARTIAL unique index scoped to active CROSS_REGION
-- rows. The append-only design needs many historical rows per triple, so a
-- whole-table unique on (user_id, data_region, access_region) no longer holds.
DROP INDEX "cross_region_consent_user_id_data_region_access_region_key";

-- ── 4. Add new columns ────────────────────────────────────────────────────
ALTER TABLE "consent"
    ADD COLUMN "purpose" "ConsentPurpose" NOT NULL DEFAULT 'CROSS_REGION',
    ADD COLUMN "study_id" TEXT,
    ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "superseded_at" TIMESTAMP(3);

-- ── 5. Make region columns nullable (set only on CROSS_REGION rows) ───────
ALTER TABLE "consent" ALTER COLUMN "data_region" DROP NOT NULL;
ALTER TABLE "consent" ALTER COLUMN "access_region" DROP NOT NULL;

-- ── 6. Uniqueness ─────────────────────────────────────────────────────────
-- 6a. Research rows (study_id non-null). NOTE: Postgres treats NULLs as
--     DISTINCT, so this composite does NOT constrain CROSS_REGION rows
--     (study_id is NULL there) — by design.
CREATE UNIQUE INDEX "consent_user_id_purpose_study_id_key"
    ON "consent" ("user_id", "purpose", "study_id");

-- 6b. CROSS_REGION rows: a PARTIAL unique index keyed on ACTIVE rows only.
--     This preserves the pre-existing guarantee of at most one current
--     cross-region consent per (user, data_region, access_region) without
--     blocking the append-only history of superseded rows.
CREATE UNIQUE INDEX "consent_cross_region_key"
    ON "consent" ("user_id", "data_region", "access_region")
    WHERE "purpose" = 'CROSS_REGION' AND "active";

-- 6c. Helper index for current-state lookups by (user, purpose).
CREATE INDEX "consent_user_id_purpose_active_idx"
    ON "consent" ("user_id", "purpose", "active");

-- ── 7. Fail-CLOSED research age signal on users ───────────────────────────
-- Defaults false: existing rows are NOT auto age-verified. `ageTier` is never
-- an includability signal; research/cohort queries gate on age_verified = true.
ALTER TABLE "users" ADD COLUMN "age_verified" BOOLEAN NOT NULL DEFAULT false;
