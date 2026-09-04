-- squawk-ignore-file prefer-timestamp-tz
--
-- `created_at` / `updated_at` are TIMESTAMP(3) because that is what Prisma maps
-- `DateTime` to, and it is what every other timestamp column in this schema is
-- (170+ columns; two deliberate Timestamptz exceptions). A timestamptz here
-- would need `@db.Timestamptz` in schema.prisma and would disagree with the
-- `reports` rows these categories join to, for no gain: the app reads and
-- writes UTC instants through Prisma on every path. Scoped to this FILE, not
-- .squawk.toml, so the rule keeps applying to every other migration.

-- Compliance plan 08 Phase 1 (additive, back-compat) — part 1 of 3: the
-- RoutingClass enum, the CONTENT ReportType value, Report.category_key, the
-- report_categories table, and the (NOT VALID) foreign key between them.
--
-- HAND-AUTHORED from `prisma migrate dev` output, and why: the generated SQL
-- carries none of the house style (M7b) — the timeout prologue, re-runnable
-- statements, the NOT VALID foreign key, the enum-value position — and it also
-- emitted DROP INDEX for the hand-written GiST/GIN/trigram indexes the Prisma
-- schema cannot express (entity_location_location_idx,
-- tenant_directory_profile_desc_trgm_idx, tenant_display_name_trgm_idx). Those
-- drops were pruned, exactly as the t8 (push_devices), t14 and open_social_web
-- migrations did; this migration is additive and must not drop those indexes.
--
-- The two indexes on the PRE-EXISTING `reports` table are created CONCURRENTLY
-- in the next two migration files, one statement each (the M7a/M7b precedent:
-- Prisma applies a multi-statement file inside one transaction, and CREATE
-- INDEX CONCURRENTLY cannot share one with the ALTERs below). The foreign key
-- is added NOT VALID here and validated in part 3.
--
-- House style (M7b): timeout prologue so a lock queue fails fast instead of
-- stalling the app; robust (re-runnable) statements throughout.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- CREATE TYPE has no IF NOT EXISTS; the guard makes the file re-runnable.
DO $$ BEGIN
  CREATE TYPE "RoutingClass" AS ENUM ('ILLEGAL_PRIORITY', 'ILLEGAL', 'POLICY_VIOLATION', 'FEEDBACK');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AFTER 'ACCOUNT' pins the value's position to the declaration order in
-- schema.prisma (LINK, ACCOUNT, CONTENT) instead of "wherever the end is".
-- The new value is not used anywhere in this file, so adding it inside the
-- migration's transaction is fine (PostgreSQL 12+ requirement).
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'CONTENT' AFTER 'ACCOUNT';

-- Nullable column with no default: a catalog-only change, no table rewrite.
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "category_key" TEXT;

CREATE TABLE IF NOT EXISTS "report_categories" (
    "key" TEXT NOT NULL,
    "routing_class" "RoutingClass" NOT NULL,
    "labels" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    -- int4, not bigint: the display ordinal of a category vocabulary a
    -- deployment seeds by hand (tens of rows, never millions), matching the
    -- Prisma `Int` that declares it. Line-scoped so the bigint rule keeps
    -- applying to every other column.
    -- squawk-ignore prefer-bigint-over-int
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_categories_pkey" PRIMARY KEY ("key")
);

-- Not CONCURRENTLY: `report_categories` is created in this same transaction
-- and is invisible to every other session until commit, so there are no
-- writers to block — and CONCURRENTLY cannot run inside the transaction anyway.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "report_categories_active_sort_order_idx"
  ON "report_categories"("active", "sort_order");

-- NOT VALID: a validated foreign key holds a SHARE ROW EXCLUSIVE lock on
-- `reports` while it scans every row; NOT VALID skips the scan and enforces the
-- constraint for new writes only. The scan runs as VALIDATE CONSTRAINT in part
-- 3 under a lock that does not block writes. ADD CONSTRAINT has no IF NOT
-- EXISTS, so the preceding DROP is what makes the pair re-runnable.
ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "reports_category_key_fkey";
ALTER TABLE "reports" ADD CONSTRAINT "reports_category_key_fkey"
  FOREIGN KEY ("category_key") REFERENCES "report_categories"("key")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
