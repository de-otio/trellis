#!/usr/bin/env bash
# Schema-drift guard (pre-launch schema end-state pass).
#
# Fails when prisma/schema.prisma has drifted from prisma/migrations/ — i.e.
# someone edited the schema without generating a migration. After the single
# clean `init` migration, schema and migrations must move in lockstep; a
# schema-only edit would deploy a Prisma client that disagrees with the
# database.
#
# Mechanics: the caller applies the migrations to a scratch Postgres
# (`prisma migrate deploy`, exactly like the other CI lanes), then this script
# diffs that database against schema.prisma with `prisma migrate diff`. The
# diff is rendered as SQL (`--script`) so the known HAND-WRITTEN migration
# objects — which by design exist only in migration SQL and are invisible to
# schema.prisma — can be allowlisted:
#
#   entity_location_location_idx              GiST (geography)
#   tenant_directory_profile_location_idx     GiST expression index
#   tenant_display_name_trgm_idx              pg_trgm GIN
#   tenant_directory_profile_desc_trgm_idx    pg_trgm GIN
#   consent_cross_region_key                  partial unique
#   consent_third_party_sharing_key           partial unique, NULLS NOT DISTINCT
#   consent_third_party_sharing_shape_check   CHECK constraint (row shape)
#   feature_toggles_key_global                partial unique
#
# Anything else in the diff is real drift and fails the check. If you add a
# new hand-written object to a migration, add its name here AND to the
# "Hand-written SQL" block documentation in the init migration.
#
# Requires: DATABASE_URL pointing at a Postgres that has had
# `prisma migrate deploy` run against it.

set -euo pipefail

cd "$(dirname "$0")/.." # apps/api — so Prisma 7 discovers prisma.config.ts

if [ -z "${DATABASE_URL:-}" ]; then
  echo "check-schema-drift: DATABASE_URL must point at a scratch DB with migrations applied" >&2
  exit 1
fi

DIFF_SQL="$(mktemp)"
trap 'rm -f "$DIFF_SQL"' EXIT

npx prisma migrate diff \
  --from-config-datasource \
  --to-schema ../../prisma/schema.prisma \
  --script >"$DIFF_SQL"

# Known hand-written migration objects (see header). One name per alternation.
ALLOWLIST='entity_location_location_idx|tenant_directory_profile_location_idx|tenant_display_name_trgm_idx|tenant_directory_profile_desc_trgm_idx|consent_cross_region_key|consent_third_party_sharing_key|consent_third_party_sharing_shape_check|feature_toggles_key_global'

# Drop allowlisted statements, SQL comments, the config-loader banner, and
# blank lines. Whatever remains is genuine drift.
REMAINING="$(grep -vE "\"?(${ALLOWLIST})\"?" "$DIFF_SQL" | grep -vE '^[[:space:]]*(--.*)?$' | grep -v 'Loaded Prisma config' || true)"

if [ -n "$REMAINING" ]; then
  echo "──────────────────────────────────────────────────────────────────────"
  echo "SCHEMA DRIFT: prisma/schema.prisma does not match prisma/migrations/."
  echo "Generate a migration for your schema change:"
  echo "  cd apps/api && npx prisma migrate dev --name <describe_change>"
  echo "Unexplained diff (DB-built-from-migrations → schema.prisma):"
  echo "──────────────────────────────────────────────────────────────────────"
  echo "$REMAINING"
  exit 1
fi

echo "check-schema-drift: OK — schema.prisma matches prisma/migrations/ (allowlisted hand-written objects only)"
