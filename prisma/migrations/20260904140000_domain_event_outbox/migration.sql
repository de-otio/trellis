-- Domain-event outbox (plan 034 lane E). Additive, non-breaking: one new table,
-- no change to any existing object.
--
-- Rows are written by `emitDomainEvent(tx, …)` (apps/api/src/lib/events/emit.ts)
-- INSIDE the emitting mutation's own transaction, so a rolled-back mutation
-- leaves no event behind. NOTHING READS THIS TABLE in Phase 0 — there is no
-- dispatcher, sweeper or subscriber, and `delivered_at` is written by nobody.
-- The column is created now because adding a column to a table that already has
-- rows is a migration; adding it today is a line of DDL.
--
-- Payloads are minimised by design: ids and changed field names only, never
-- their values. See the model doc in prisma/schema.prisma for the erasure
-- posture this table is held to.
--
-- No RLS / CREATE POLICY, consistent with every existing migration — isolation
-- is the denormalized tenant_id plus mandatory tenant filtering at the callers.
--
-- Hand-written rather than generated: no Postgres was reachable in the
-- authoring environment (`prisma migrate dev` needs a live database), so this
-- file follows the shape `prisma migrate dev` emits for this model and the
-- house style of the surrounding migrations (timeout prologue, re-runnable
-- statements — see 20260823150000 and 20260718000000).

SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "domain_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Per-tenant replay, newest-first.
--
-- CONCURRENTLY is neither possible nor needed here: Prisma applies a
-- migration file inside a transaction (which forbids it), and the table is
-- created a few statements up — there is nothing to lock and no row to scan.
-- The rule cannot see that, so the exception is stated here rather than
-- silenced globally in .squawk.toml.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "domain_events_tenant_id_occurred_at_idx" ON "domain_events"("tenant_id", "occurred_at");

-- CreateIndex
-- The predicate a future dispatcher sweeps on (delivered_at IS NULL).
--
-- Same reason as the index above: empty table, created in this file.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "domain_events_delivered_at_idx" ON "domain_events"("delivered_at");
