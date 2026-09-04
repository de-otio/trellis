-- Compliance plan 08 Phase 2 + spec 07 §4 (Lane A2, enforcement).
-- Purely ADDITIVE, back-compat: no drops, no changes to existing columns.
--
-- 1. MediaFile server-only enrichment (spec 07 §4.3): `block_class`
--    ("lawful-flagged" | "illegal-suspected"; NEVER client-visible) + the
--    evidence-hold fields (`evidence_hold`, `evidence_id`) that the hard-delete
--    GC purge and account-deletion cascade skip (plan 08 §2.3 item 5).
-- 2. `statements_of_reasons` (plan 08 §2.4 / DSA Art. 17) — params carry
--    template params ONLY, never raw classifier output.
-- 3. `authority_reports` (plan 08 §2.6 / M3) — created pending, NEVER
--    auto-submitted; bundle holds Art.-18 refs, not bytes.

-- AlterTable
ALTER TABLE "media_files" ADD COLUMN     "block_class" TEXT,
ADD COLUMN     "evidence_hold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "evidence_id" TEXT;

-- CreateTable
CREATE TABLE "statements_of_reasons" (
    "id" TEXT NOT NULL,
    "affected_user_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "restriction" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "params" JSONB,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "suppress_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statements_of_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_reports" (
    "id" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "channel_mode" TEXT,
    "evidence_id" TEXT,
    "bundle" JSONB NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statements_of_reasons_affected_user_id_idx" ON "statements_of_reasons"("affected_user_id");

-- CreateIndex
CREATE INDEX "authority_reports_status_idx" ON "authority_reports"("status");
