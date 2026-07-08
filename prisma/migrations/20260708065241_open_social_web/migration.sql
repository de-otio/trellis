-- Open Social Web (additive): EmailSubscription + Collection/CollectionItem.
-- NOTE: `prisma migrate dev` also emitted DROP INDEX for the hand-written
-- GiST/GIN/trigram indexes the Prisma schema cannot express
-- (entity_location_location_idx, tenant_directory_profile_desc_trgm_idx,
-- tenant_display_name_trgm_idx). Those drops were hand-pruned here, exactly as
-- the t8 (push_devices) and t14 migrations did; this migration is additive.

-- CreateEnum
CREATE TYPE "EmailSubscriptionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'UNSUBSCRIBED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "CollectionVisibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateTable
CREATE TABLE "email_subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "email_enc" TEXT NOT NULL,
    "token_nonce" TEXT NOT NULL,
    "status" "EmailSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "locale" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "last_digest_at" TIMESTAMP(3),
    "bounce_count" INTEGER NOT NULL DEFAULT 0,
    "retention_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "CollectionVisibility" NOT NULL DEFAULT 'PRIVATE',
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_items" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_subscriptions_target_type_target_id_status_idx" ON "email_subscriptions"("target_type", "target_id", "status");

-- CreateIndex
CREATE INDEX "email_subscriptions_status_retention_until_idx" ON "email_subscriptions"("status", "retention_until");

-- CreateIndex
CREATE INDEX "email_subscriptions_tenant_id_idx" ON "email_subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_subscriptions_tenant_id_target_type_target_id_email_h_key" ON "email_subscriptions"("tenant_id", "target_type", "target_id", "email_hash");

-- CreateIndex
CREATE INDEX "collections_owner_user_id_idx" ON "collections"("owner_user_id");

-- CreateIndex
CREATE INDEX "collections_tenant_id_visibility_idx" ON "collections"("tenant_id", "visibility");

-- CreateIndex
CREATE INDEX "collection_items_collection_id_position_idx" ON "collection_items"("collection_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "collection_items_collection_id_target_type_target_id_key" ON "collection_items"("collection_id", "target_type", "target_id");

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
