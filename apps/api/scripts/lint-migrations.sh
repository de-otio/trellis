#!/usr/bin/env bash
# Local runner for the squawk migration-lint gate (see
# .github/workflows/migration-lint.yml for the CI equivalent, and
# apps/api/scripts/migration-lint-scope.mjs for the scoping logic these two
# share).
#
# Downloads a checksum-pinned squawk binary (macOS arm64) and runs it only
# against the migration SQL files this checkout has added/changed relative to
# a base ref — never against the pre-existing migration history.
#
# WHY A PINNED BINARY, NOT `npx squawk-cli` / `brew install squawk`:
# a floating version can change lint behavior out from under CI without a
# corresponding diff in this repo, and an unpinned download is an unreviewed
# supply-chain input. See .github/workflows/migration-lint.yml for the CI
# (linux/x64) pin; this script pins the macOS/arm64 asset of the SAME
# release, so local and CI results agree.
#
# Usage:
#   apps/api/scripts/lint-migrations.sh [baseRef]
# baseRef defaults to the scoping script's own fallback chain
# (origin/main -> main -> HEAD~1 -> empty scope).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SQUAWK_VERSION="v2.62.0"
SQUAWK_ASSET="squawk-darwin-arm64"
SQUAWK_SHA256="699d5a2cc6ed622f1469caf4db2faf047d89049b09d89b91d8307238e002d1ac"
SQUAWK_URL="https://github.com/sbdchd/squawk/releases/download/${SQUAWK_VERSION}/${SQUAWK_ASSET}"

CACHE_DIR="${REPO_ROOT}/.cache/squawk"
SQUAWK_BIN="${CACHE_DIR}/${SQUAWK_ASSET}-${SQUAWK_VERSION}"

BASE_REF="${1:-}"

download_and_verify_squawk() {
  mkdir -p "${CACHE_DIR}"
  echo "lint-migrations: downloading ${SQUAWK_ASSET} ${SQUAWK_VERSION}..." >&2
  curl -fsSL -o "${SQUAWK_BIN}" "${SQUAWK_URL}"

  # shasum -a 256 -c style verification against the pinned checksum. Never
  # `latest`, never an unverified download.
  echo "${SQUAWK_SHA256}  ${SQUAWK_BIN}" | shasum -a 256 -c -

  chmod +x "${SQUAWK_BIN}"
}

if [ ! -x "${SQUAWK_BIN}" ]; then
  download_and_verify_squawk
else
  # Re-verify the cached binary every run: cheap, and it means a corrupted or
  # tampered cache entry is caught instead of silently trusted.
  if ! echo "${SQUAWK_SHA256}  ${SQUAWK_BIN}" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "lint-migrations: cached binary failed checksum verification; re-downloading" >&2
    rm -f "${SQUAWK_BIN}"
    download_and_verify_squawk
  fi
fi

cd "${REPO_ROOT}"

SCOPE_RAW="$(mktemp)"
trap 'rm -f "${SCOPE_RAW}"' EXIT

if [ -n "${BASE_REF}" ]; then
  node "${SCRIPT_DIR}/migration-lint-scope.mjs" "${BASE_REF}" >"${SCOPE_RAW}"
else
  node "${SCRIPT_DIR}/migration-lint-scope.mjs" >"${SCOPE_RAW}"
fi

if [ ! -s "${SCOPE_RAW}" ]; then
  echo "lint-migrations: no in-scope migration SQL files (nothing added/changed under prisma/migrations/); nothing to lint."
  exit 0
fi

echo "lint-migrations: linting the following files with squawk ${SQUAWK_VERSION}:" >&2
xargs -0 -a "${SCOPE_RAW}" -n1 echo "  " >&2

# NUL-delimited argv, never re-interpolated through a shell string — a
# filename containing a space or shell metacharacter must not be able to
# split into extra words or break out of a quoted argument. `xargs -0`
# builds the child process's argv directly (no `sh -c`).
xargs -0 -a "${SCOPE_RAW}" "${SQUAWK_BIN}" --config "${REPO_ROOT}/.squawk.toml"
