-- Surveillance-hardening Phase 0 — schema enablers (P1).
-- See doc/02-technical/surveillance-threat-model/ and
-- plans/surveillance-hardening-phase0/01-schema-enablers.md.
--
-- Additive except for SecurityEvent.retention_until -> NOT NULL and the
-- feature_toggles unique-constraint change (single global-unique index
-- replaced by a (key, tenant_id) unique + a PARTIAL global-unique index).
-- Nothing is live; this migration assumes no pre-existing rows that would
-- violate the new NOT NULL / unique constraints.

-- CreateEnum
CREATE TYPE "SignupMethod" AS ENUM ('COGNITO', 'INVITE', 'MAGIC_LINK');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('LINK', 'ACCOUNT');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'MODERATOR';

-- DropIndex
DROP INDEX "feature_toggles_key_key";

-- AlterTable
ALTER TABLE "feature_toggles" ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "security_events" ALTER COLUMN "retention_until" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "invitation_id" TEXT,
ADD COLUMN     "signup_method" "SignupMethod";

-- CreateTable
CREATE TABLE "interaction_events" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "interaction_type" TEXT NOT NULL,
    "tenant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interaction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "report_type" "ReportType" NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "reporter_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assignee_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interaction_events_actor_user_id_created_at_idx" ON "interaction_events"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "interaction_events_target_type_target_id_created_at_idx" ON "interaction_events"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "interaction_events_expires_at_idx" ON "interaction_events"("expires_at");

-- CreateIndex
CREATE INDEX "reports_report_type_status_idx" ON "reports"("report_type", "status");

-- CreateIndex
CREATE INDEX "reports_resource_type_resource_id_idx" ON "reports"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "reports_reporter_user_id_idx" ON "reports"("reporter_user_id");

-- CreateIndex
CREATE INDEX "feature_toggles_tenant_id_idx" ON "feature_toggles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_toggles_key_tenant_id_key" ON "feature_toggles"("key", "tenant_id");

-- CreateIndex (PARTIAL, hand-added — NOT expressible in schema.prisma)
-- Postgres treats NULLs as DISTINCT, so feature_toggles_key_tenant_id_key
-- alone would permit duplicate GLOBAL rows (tenant_id IS NULL) for one key.
-- This partial index enforces "at most one global row per key". Precedent:
-- 20260602162901_research_foundations ships a partial unique index. Keep the
-- schema.prisma comment in sync so `prisma migrate dev` never treats this as
-- drift (the diff tool ignores partial indexes it can't model).
CREATE UNIQUE INDEX "feature_toggles_key_global" ON "feature_toggles"("key") WHERE "tenant_id" IS NULL;

-- CreateIndex
CREATE INDEX "users_invitation_id_idx" ON "users"("invitation_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interaction_events" ADD CONSTRAINT "interaction_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
