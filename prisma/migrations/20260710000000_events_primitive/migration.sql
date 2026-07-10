-- Events primitive (R1 — plans/events-primitive/README.md §4.2). Additive:
-- new Event / Rsvp / EventShift / ShiftSignup tables + enums, the EVENT_*
-- NotificationType values, and NotificationPreference.event_enabled.
-- No RLS / CREATE POLICY (consistent with all existing migrations); isolation
-- is tenant-scope + mandatory handler-level tenant filtering. Every child
-- carries a denormalized tenant_id. Location uses lat/lng + the fuzzed
-- display_lat/display_lng pair + location_precision (no PostGIS for M1).

-- AlterEnum
-- The new NotificationType values are not referenced by any table created in
-- this migration, so ADD VALUE is safe here (no same-transaction usage).
ALTER TYPE "NotificationType" ADD VALUE 'EVENT_INVITE';
ALTER TYPE "NotificationType" ADD VALUE 'EVENT_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'EVENT_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'EVENT_CANCELLED';

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventVisibility" AS ENUM ('TENANT_ONLY', 'GROUP_ONLY', 'PUBLIC');

-- CreateEnum
CREATE TYPE "RsvpStatus" AS ENUM ('GOING', 'MAYBE', 'NOT_GOING', 'WAITLISTED');

-- CreateEnum
CREATE TYPE "ShiftSignupStatus" AS ENUM ('CONFIRMED', 'WAITLISTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN "event_enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "group_id" TEXT,
    "creator_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "EventVisibility" NOT NULL DEFAULT 'TENANT_ONLY',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
    "location_name" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "display_lat" DOUBLE PRECISION,
    "display_lng" DOUBLE PRECISION,
    "location_precision" "LocationPrecision" NOT NULL DEFAULT 'CITY',
    "capacity" INTEGER,
    "rsvp_count" INTEGER NOT NULL DEFAULT 0,
    "waitlist_count" INTEGER NOT NULL DEFAULT 0,
    "announce_post_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_rsvps" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "RsvpStatus" NOT NULL,
    "guests" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_rsvps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_shifts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "capacity" INTEGER NOT NULL,
    "filled_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_shift_signups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "ShiftSignupStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_shift_signups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_announce_post_id_key" ON "events"("announce_post_id");

-- CreateIndex
CREATE INDEX "events_tenant_id_starts_at_idx" ON "events"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "events_tenant_id_status_starts_at_idx" ON "events"("tenant_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "events_group_id_starts_at_idx" ON "events"("group_id", "starts_at");

-- CreateIndex
CREATE INDEX "event_rsvps_tenant_id_event_id_status_idx" ON "event_rsvps"("tenant_id", "event_id", "status");

-- CreateIndex
CREATE INDEX "event_rsvps_user_id_idx" ON "event_rsvps"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_rsvps_event_id_user_id_key" ON "event_rsvps"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "event_shifts_tenant_id_event_id_idx" ON "event_shifts"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "event_shift_signups_tenant_id_shift_id_idx" ON "event_shift_signups"("tenant_id", "shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_shift_signups_shift_id_user_id_key" ON "event_shift_signups"("shift_id", "user_id");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_shifts" ADD CONSTRAINT "event_shifts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_shift_signups" ADD CONSTRAINT "event_shift_signups_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "event_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
