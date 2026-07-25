-- WS-1 KV port (ws1-kv-port-plan §4.2). The kv_entries table backs the
-- PostgresKvStore adapter (@de-otio/saas-foundation/kv/postgres) for the 10
-- hot-spot namespaces when KV_PROVIDER=postgres. Additive, non-breaking: a new
-- global (NOT tenant-scoped) table. No RLS / CREATE POLICY, consistent with all
-- existing migrations — the KV pool is a dedicated pool that bypasses the tenant
-- Prisma extension, and every key is namespace-scoped by construction.

-- CreateTable
CREATE TABLE "kv_entries" (
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(6),
    "indexed_key" TEXT,

    CONSTRAINT "kv_entries_pkey" PRIMARY KEY ("namespace", "key")
);

-- CreateIndex
CREATE INDEX "kv_entries_namespace_indexed_key_idx" ON "kv_entries"("namespace", "indexed_key");

-- CreateIndex
CREATE INDEX "kv_entries_expires_at_idx" ON "kv_entries"("expires_at");
