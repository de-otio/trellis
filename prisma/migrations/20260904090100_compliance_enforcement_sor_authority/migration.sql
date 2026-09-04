-- squawk-ignore-file prefer-timestamp-tz
--
-- The timestamp columns below are TIMESTAMP(3) because that is what Prisma
-- maps `DateTime` to, and it is what every other timestamp column in this
-- schema is (170+ columns; two deliberate Timestamptz exceptions). A
-- timestamptz here would need `@db.Timestamptz` in schema.prisma and would
-- disagree with the `media_files` / `reports` rows these tables join to, for no
-- gain: the app reads and writes UTC instants through Prisma on every path.
-- Scoped to this FILE, not .squawk.toml, so the rule keeps applying to every
-- other migration.

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
--
-- HAND-AUTHORED from `prisma migrate dev` output: the generated SQL carries
-- none of the house style below, and it emitted DROP INDEX for the hand-written
-- GiST/GIN/trigram indexes the Prisma schema cannot express; those drops were
-- pruned (see 20260904090000_compliance_report_categories for the list).
--
-- House style (M7b): timeout prologue so a lock queue fails fast instead of
-- stalling the app; robust (re-runnable) statements throughout.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- Nullable columns with no default are catalog-only changes (no table rewrite);
-- NOT NULL with a constant DEFAULT is catalog-only too on PostgreSQL 11+.
ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "block_class" TEXT;

ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "evidence_hold" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "evidence_id" TEXT;

CREATE TABLE IF NOT EXISTS "statements_of_reasons" (
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

CREATE TABLE IF NOT EXISTS "authority_reports" (
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

-- Not CONCURRENTLY: both tables are created in this same transaction and are
-- invisible to every other session until commit, so there are no writers to
-- block — and CONCURRENTLY cannot run inside the transaction anyway.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "statements_of_reasons_affected_user_id_idx"
  ON "statements_of_reasons"("affected_user_id");

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "authority_reports_status_idx"
  ON "authority_reports"("status");
