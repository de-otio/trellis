-- REFERENCE rollback for 20260604140000_fold_link_reports_into_reports.
--
-- Prisma migrate is FORWARD-ONLY and will NEVER execute this file. It exists
-- for a human operating a PRE-RELEASE rollback (revert the code commit, then
-- run this by hand). After a release ships, roll forward only.
--
-- Nothing is live, so there are no LINK reports to restore; this simply
-- recreates the empty link_reports table at its pre-P4 shape. If LINK reports
-- ever exist in `reports` at rollback time, restore them with:
--   INSERT INTO link_reports (id, user_id, link_url, domain, reason, status, created_at)
--   SELECT id, reporter_user_id, resource_id, COALESCE(domain, ''), reason, status, created_at
--     FROM reports WHERE report_type = 'LINK';

DROP INDEX IF EXISTS "reports_domain_idx";
ALTER TABLE "reports" DROP COLUMN IF EXISTS "domain";

CREATE TABLE "link_reports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "link_url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "link_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "link_reports_domain_idx" ON "link_reports"("domain");
CREATE INDEX "link_reports_status_idx" ON "link_reports"("status");
CREATE INDEX "link_reports_user_id_idx" ON "link_reports"("user_id");
ALTER TABLE "link_reports" ADD CONSTRAINT "link_reports_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
