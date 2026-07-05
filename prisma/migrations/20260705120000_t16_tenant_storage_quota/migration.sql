-- T16 — per-tenant storage-quota entitlement seam.
-- NULL = free-tier default from env (MEDIA_QUOTA_MAX_BYTES / MEDIA_QUOTA_MAX_OBJECTS);
-- non-null = per-tenant override. Nullable columns, no backfill, no index
-- (read by primary key alongside the quota usage aggregate).
ALTER TABLE "tenants"
  ADD COLUMN "storage_quota_bytes" BIGINT,
  ADD COLUMN "storage_quota_objects" INTEGER;
