#!/usr/bin/env bash
# Run all e2e test shards in parallel (for local development).
# Usage: API_URL=https://api.dev.example.com ./scripts/e2e-parallel.sh

set -euo pipefail

if [ -z "${API_URL:-}" ]; then
  echo "ERROR: API_URL must be set"
  echo "Usage: API_URL=https://api.dev.example.com $0"
  exit 1
fi

SHARDS=(smoke crud social media security readonly)
PIDS=()
RESULTS=()

echo "Starting ${#SHARDS[@]} e2e shards in parallel..."
echo "API_URL: ${API_URL}"
echo ""

for shard in "${SHARDS[@]}"; do
  echo "  Starting shard: ${shard}"
  npm run "test:e2e:${shard}" -w @de-otio/trellis &
  PIDS+=($!)
done

echo ""
echo "Waiting for all shards to complete..."

FAILED=0
for i in "${!SHARDS[@]}"; do
  if wait "${PIDS[$i]}"; then
    RESULTS+=("PASS")
    echo "  ${SHARDS[$i]}: PASS"
  else
    RESULTS+=("FAIL")
    echo "  ${SHARDS[$i]}: FAIL"
    FAILED=1
  fi
done

echo ""
echo "=== Results ==="
for i in "${!SHARDS[@]}"; do
  echo "  ${SHARDS[$i]}: ${RESULTS[$i]}"
done

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "Some shards failed!"
  exit 1
fi

echo ""
echo "All shards passed!"
