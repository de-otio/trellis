-- Track D — block-list store for the realtime delivery FLOOR. Directed,
-- tenant-scoped block edges (blocker has blocked blocked). Consulted by
-- BlockStore.isBlocked to drop a blocked sender's wakeup at the floor.

-- CreateTable
CREATE TABLE "blocked_users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blocked_users_tenant_id_blocker_id_idx" ON "blocked_users"("tenant_id", "blocker_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_users_tenant_id_blocker_id_blocked_id_key" ON "blocked_users"("tenant_id", "blocker_id", "blocked_id");

-- AddForeignKey
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
