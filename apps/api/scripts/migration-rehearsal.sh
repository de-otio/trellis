#!/usr/bin/env bash
# Migration rehearsal — time `prisma migrate deploy` against a Postgres seeded
# with representative row counts, and fail if it exceeds a time budget.
#
# WHY THIS EXISTS
# ---------------
# The safe-vs-unsafe DDL table in docs/guides/migrations.md tells you whether a
# statement blocks; it does not tell you how LONG a safe-but-scanning
# operation (CREATE INDEX CONCURRENTLY, VALIDATE CONSTRAINT, a backfill) takes
# on a table the size the production table actually is. A migration that is
# provably non-blocking can still be too slow for the deploy window. This
# script seeds the Compose Postgres with caller-specified row counts, applies
# the pending migrations, and fails the run if it took longer than the budget
# — a cheap early signal, not a substitute for reading the DDL table.
#
# Usage:
#   apps/api/scripts/migration-rehearsal.sh
#
# Env vars (all optional; validated below — never interpolated unquoted):
#   REHEARSAL_TIME_BUDGET_SECONDS   Max wall-clock seconds for `migrate deploy`.
#                                   Default: 300.
#   REHEARSAL_SEED_SPEC             Comma-separated `table:rowcount` pairs,
#                                   e.g. "posts:100000,comments:500000".
#                                   Default: "" (no seeding — times deploy
#                                   against whatever the DB already has).
#   REHEARSAL_COMPOSE_SERVICE       docker-compose service name for Postgres.
#                                   Default: "postgres" (matches
#                                   docker-compose.yml at the repo root).
#
# Requires Docker Compose (the repo-root docker-compose.yml's `postgres`
# service). If Docker is unavailable in the current environment, this script
# is not runnable here — do not attempt a workaround; run it where Docker is
# available (e.g. CI's migration-rehearsal.yml, or a developer machine).

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the repo root and apps/api (Prisma 7 discovers prisma.config.ts from
# apps/api; the docker-compose.yml this script drives lives at the repo root).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$API_DIR/../.." && pwd)"

TIME_BUDGET_SECONDS="${REHEARSAL_TIME_BUDGET_SECONDS:-300}"
SEED_SPEC="${REHEARSAL_SEED_SPEC:-}"
COMPOSE_SERVICE="${REHEARSAL_COMPOSE_SERVICE:-postgres}"

# --- Validate REHEARSAL_TIME_BUDGET_SECONDS: positive integer only ----------
if ! [[ "$TIME_BUDGET_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "migration-rehearsal: REHEARSAL_TIME_BUDGET_SECONDS must be a positive integer, got: ${TIME_BUDGET_SECONDS}" >&2
  exit 2
fi

# --- Validate REHEARSAL_COMPOSE_SERVICE: safe identifier only ---------------
if ! [[ "$COMPOSE_SERVICE" =~ ^[a-zA-Z][a-zA-Z0-9_-]*$ ]]; then
  echo "migration-rehearsal: REHEARSAL_COMPOSE_SERVICE has an unsafe value: ${COMPOSE_SERVICE}" >&2
  exit 2
fi

# --- Postgres connection (matches docker-compose.yml's postgres service) ---
: "${REHEARSAL_DB_USER:=trellis}"
: "${REHEARSAL_DB_PASSWORD:=trellis_dev_password}"
: "${REHEARSAL_DB_NAME:=trellis_dev}"
: "${REHEARSAL_DB_HOST:=localhost}"
: "${REHEARSAL_DB_PORT:=5432}"

for var_name in REHEARSAL_DB_USER REHEARSAL_DB_PASSWORD REHEARSAL_DB_NAME REHEARSAL_DB_HOST REHEARSAL_DB_PORT; do
  value="${!var_name}"
  if [[ -z "$value" ]]; then
    echo "migration-rehearsal: ${var_name} must not be empty" >&2
    exit 2
  fi
done
if ! [[ "$REHEARSAL_DB_PORT" =~ ^[1-9][0-9]*$ ]]; then
  echo "migration-rehearsal: REHEARSAL_DB_PORT must be a positive integer, got: ${REHEARSAL_DB_PORT}" >&2
  exit 2
fi
# Identifier-shaped: alnum/underscore only — this is interpolated into a
# connection URL and passed to psql as -U/-d, never through a shell string
# that itself gets re-interpreted.
for var_name in REHEARSAL_DB_USER REHEARSAL_DB_NAME REHEARSAL_DB_HOST; do
  value="${!var_name}"
  if ! [[ "$value" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    echo "migration-rehearsal: ${var_name} has an unsafe value: ${value}" >&2
    exit 2
  fi
done

DATABASE_URL="postgresql://${REHEARSAL_DB_USER}:${REHEARSAL_DB_PASSWORD}@${REHEARSAL_DB_HOST}:${REHEARSAL_DB_PORT}/${REHEARSAL_DB_NAME}"
export DATABASE_URL
export DIRECT_DATABASE_URL="$DATABASE_URL"

# --- Parse and validate REHEARSAL_SEED_SPEC up front: "table:count,..." ----
# Validated before any docker/network activity so a malformed spec fails fast
# and is testable without Docker. Each table name must be a plausible SQL
# identifier (letters, digits, underscores; must start with a letter or
# underscore) and each count a positive integer. Rejects anything else rather
# than attempting to sanitize it.
SEED_TABLES=()
SEED_COUNTS=()
if [[ -n "$SEED_SPEC" ]]; then
  IFS=',' read -ra PAIRS <<<"$SEED_SPEC"
  for pair in "${PAIRS[@]}"; do
    table="${pair%%:*}"
    count="${pair##*:}"
    if [[ -z "$table" || -z "$count" || "$table" == "$pair" ]]; then
      echo "migration-rehearsal: malformed REHEARSAL_SEED_SPEC entry: '${pair}' (expected table:count)" >&2
      exit 2
    fi
    if ! [[ "$table" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
      echo "migration-rehearsal: unsafe table name in REHEARSAL_SEED_SPEC: '${table}'" >&2
      exit 2
    fi
    if ! [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
      echo "migration-rehearsal: unsafe row count in REHEARSAL_SEED_SPEC for '${table}': '${count}'" >&2
      exit 2
    fi
    SEED_TABLES+=("$table")
    SEED_COUNTS+=("$count")
  done
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "migration-rehearsal: docker not found in PATH — cannot rehearse here. Run this on a machine/CI job with Docker available (see migration-rehearsal.yml)." >&2
  exit 3
fi

echo "migration-rehearsal: starting Postgres (compose service: ${COMPOSE_SERVICE})..."
( cd "$REPO_ROOT" && docker compose up -d "$COMPOSE_SERVICE" )

echo "migration-rehearsal: waiting for Postgres to become healthy..."
ATTEMPTS=0
MAX_ATTEMPTS=60
until ( cd "$REPO_ROOT" && docker compose exec -T "$COMPOSE_SERVICE" pg_isready -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" ) >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]]; then
    echo "migration-rehearsal: Postgres did not become ready after ${MAX_ATTEMPTS} attempts" >&2
    exit 4
  fi
  sleep 2
done

# --- Seed representative row counts (spec already validated above) --------
# Best-effort generic seed: without knowing the target table's full column
# set, this script cannot construct a real INSERT for an arbitrary table
# (required columns, foreign keys, and check constraints vary per table). It
# validates and echoes the requested (table, count) pairs — enforcing that
# REHEARSAL_SEED_SPEC is well-formed and safe to place into SQL — but the
# actual row generation is deliberately left to a schema-aware seed script
# the caller supplies via REHEARSAL_SEED_SQL_SCRIPT (a path, run through
# `psql -f`, never through shell interpolation of its contents). This keeps
# the contract "validated + quoted, no unquoted interpolation" honest instead
# of guessing at column shapes that would silently violate NOT NULL/FK
# constraints on real tables.
if [[ "${#SEED_TABLES[@]}" -gt 0 ]]; then
  echo "migration-rehearsal: requested seed counts:"
  for i in "${!SEED_TABLES[@]}"; do
    echo "  ${SEED_TABLES[$i]}: ${SEED_COUNTS[$i]} rows"
  done
  if [[ -n "${REHEARSAL_SEED_SQL_SCRIPT:-}" ]]; then
    if [[ ! -f "$REHEARSAL_SEED_SQL_SCRIPT" ]]; then
      echo "migration-rehearsal: REHEARSAL_SEED_SQL_SCRIPT does not exist: ${REHEARSAL_SEED_SQL_SCRIPT}" >&2
      exit 2
    fi
    echo "migration-rehearsal: running seed script ${REHEARSAL_SEED_SQL_SCRIPT}..."
    ( cd "$REPO_ROOT" && docker compose exec -T "$COMPOSE_SERVICE" \
      psql -v ON_ERROR_STOP=1 -U "$REHEARSAL_DB_USER" -d "$REHEARSAL_DB_NAME" ) \
      <"$REHEARSAL_SEED_SQL_SCRIPT" || {
      echo "migration-rehearsal: seed script failed" >&2
      exit 5
    }
  else
    echo "migration-rehearsal: no REHEARSAL_SEED_SQL_SCRIPT provided — row counts above are recorded as intent only; provide a schema-aware SQL file to actually seed rows before timing the deploy."
  fi
fi

echo "migration-rehearsal: timing 'prisma migrate deploy' (budget: ${TIME_BUDGET_SECONDS}s)..."
START_EPOCH=$(date +%s)

set +e
( cd "$API_DIR" && npx prisma migrate deploy )
DEPLOY_STATUS=$?
set -e

END_EPOCH=$(date +%s)
ELAPSED=$((END_EPOCH - START_EPOCH))

if [[ "$DEPLOY_STATUS" -ne 0 ]]; then
  echo "migration-rehearsal: 'prisma migrate deploy' FAILED (exit ${DEPLOY_STATUS}) after ${ELAPSED}s" >&2
  exit "$DEPLOY_STATUS"
fi

echo "migration-rehearsal: 'prisma migrate deploy' completed in ${ELAPSED}s (budget ${TIME_BUDGET_SECONDS}s)"

if [[ "$ELAPSED" -gt "$TIME_BUDGET_SECONDS" ]]; then
  echo "migration-rehearsal: OVER BUDGET — ${ELAPSED}s > ${TIME_BUDGET_SECONDS}s. See docs/guides/migrations.md for staged-DDL alternatives before shipping this migration." >&2
  exit 6
fi

echo "migration-rehearsal: OK — within budget."
