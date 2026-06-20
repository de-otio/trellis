-- WS5 — encrypted-settings state-sync. Server-blind per-namespace encrypted
-- setting blob with optimistic-concurrency version + cascade on user delete.

-- CreateTable
CREATE TABLE "encrypted_user_settings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encrypted_user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encrypted_user_settings_user_id_idx" ON "encrypted_user_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_user_settings_user_id_namespace_key" ON "encrypted_user_settings"("user_id", "namespace");

-- AddForeignKey
ALTER TABLE "encrypted_user_settings" ADD CONSTRAINT "encrypted_user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
