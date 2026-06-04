-- Surveillance-hardening Phase 0 — fold LinkReport into the generalized Report
-- model (P4). See plans/surveillance-hardening-phase0/04-report-model-adoption.md.
--
-- Nothing is deployed live, so there is NO data migration: link_reports is
-- dropped outright (no INSERT ... SELECT into reports). The code switch
-- (routes/link-reports.ts → Report with reportType=LINK) lands in the same PR,
-- so no release ever writes to the dropped table.
--
-- Prisma applies this DML+DDL in a single transaction on Postgres (no
-- CREATE INDEX CONCURRENTLY here), so there is no window where reports are
-- half-migrated.

-- DropForeignKey
ALTER TABLE "link_reports" DROP CONSTRAINT "link_reports_user_id_fkey";

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "domain" TEXT;

-- DropTable
DROP TABLE "link_reports";

-- CreateIndex
CREATE INDEX "reports_domain_idx" ON "reports"("domain");
