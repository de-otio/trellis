-- WS-1 rate-limit port (ws1-kv-port-plan §3.10/§4.2, security fix F5). The
-- rate_limit_buckets table backs the PostgresTokenBucketLimiter
-- (@de-otio/saas-foundation/rate-limit) when the limiter runs on Postgres.
-- Additive, non-breaking: a new global (NOT tenant-scoped) table. No RLS /
-- CREATE POLICY, consistent with all existing migrations — the rate-limit pool
-- is a dedicated pool that bypasses the tenant Prisma extension, and every
-- bucket key is `<namespace>#<key>`-scoped by construction.

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "bucket_key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "last_refill_ms" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("bucket_key")
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "rate_limit_buckets"("expires_at");
