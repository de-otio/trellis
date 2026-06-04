-- Add `region` column to `tenants`. Defaults to "EU" so all existing
-- rows match the prior hardcoded value used by the compliance route.
-- See G4 LOW-5 in the trellis v0.7 publish-gate review.
ALTER TABLE "tenants" ADD COLUMN "region" TEXT NOT NULL DEFAULT 'EU';
