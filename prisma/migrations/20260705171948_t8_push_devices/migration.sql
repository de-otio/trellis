-- T8 push devices (additive). NOTE: prisma migrate diff also emitted DROP
-- INDEX statements for the hand-written GiST/GIN indexes the schema cannot
-- express (entity_location_location_idx, *_trgm_idx — created in the init
-- migration); those drops were hand-pruned here, same as the t14 migration.

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('APNS', 'FCM', 'WEB');

-- CreateTable
CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_token_hash_key" ON "push_devices"("token_hash");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
