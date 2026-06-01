#!/usr/bin/env bash
#
# Consumer-install smoke test for @de-otio/trellis.
#
# Why: trellis has been bitten twice by published-tarball defects that
#   the in-repo test suite couldn't catch, because tests run with
#   devDependencies installed and the source tree intact:
#
#   - 0.7.0 published with @aws-sdk/client-cloudwatch-logs and
#     @aws-sdk/client-cognito-identity-provider in devDependencies.
#     Consumer installs (`npm ci --omit=dev`) stripped them; the API
#     container failed at startup with MODULE_NOT_FOUND.
#   - The 0.6.x → 0.7.0 transition added imports from `../lib/...` in
#     the published `src/lambda/*.ts` files, but `src/lib/` was not in
#     the package's `files` list. Consumers bundling from .ts source
#     hit unresolved imports.
#
# This script reproduces what a consumer does — `npm pack`, install the
# tarball into a fresh project with --omit=dev, then `require()` every
# entry point a consumer would actually load. Any missing runtime dep
# or unshipped source file fails here, before publish.
#
# Run locally before tagging: `bash apps/api/scripts/smoke-pack.sh`
# Wired into .github/workflows/{ci,publish}.yml.

set -euo pipefail

API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${API_DIR}/../.." && pwd)"

echo "==> packing @de-otio/trellis from ${API_DIR}"
cd "${API_DIR}"

# Pack into a known directory so we don't have to parse npm's output.
PACK_DIR="$(mktemp -d -t trellis-pack-XXXXXX)"
npm pack --silent --pack-destination "${PACK_DIR}" >/dev/null

TARBALL_PATH="$(find "${PACK_DIR}" -name 'de-otio-trellis-*.tgz' -type f | head -n1)"

if [ -z "${TARBALL_PATH}" ] || [ ! -f "${TARBALL_PATH}" ]; then
  echo "::error::Could not locate packed tarball under ${PACK_DIR}"
  ls -la "${PACK_DIR}" || true
  exit 1
fi

echo "==> packed: ${TARBALL_PATH}"

# Test fixtures (the dummy-target example-extension and the whole test/ tree)
# must never ship. The published `files` list is dist/prisma/src/lambda, so
# this asserts the boundary holds even if `files` is edited later.
echo "==> asserting test fixtures are absent from the tarball"
LEAKED="$(tar -tzf "${TARBALL_PATH}" | grep -E '(^|/)(test/|example-extension)' || true)"
if [ -n "${LEAKED}" ]; then
  echo "::error::test fixtures leaked into the published tarball:"
  echo "${LEAKED}"
  exit 1
fi

# Fresh consumer project outside the monorepo so npm doesn't resolve via
# workspaces. Use a tempdir we own.
CONSUMER_DIR="$(mktemp -d -t trellis-smoke-XXXXXX)"
trap 'rm -rf "${CONSUMER_DIR}" "${PACK_DIR}"' EXIT

cd "${CONSUMER_DIR}"
npm init -y >/dev/null

echo "==> installing tarball with --omit=dev (mimics container build)"
# --no-fund / --no-audit keep output tight in CI logs.
npm install "${TARBALL_PATH}" --omit=dev --no-fund --no-audit --silent

echo "==> requiring every published runtime entry point"
# We require:
#   1. The package main (dist/index.js).
#   2. Every dist/lambda/*.js file (these are what trellis's CDK packages
#      as Lambda assets via NodejsFunction).
#   3. The dist/server.js entry (consumer apps boot this).
#
# If any require() throws (typically MODULE_NOT_FOUND on a missing
# devDep promoted to runtime, or an unshipped relative import), this
# script fails — and so does the publish.
node --input-type=commonjs -e "
const path = require('path');
const fs = require('fs');

const pkgRoot = path.dirname(require.resolve('@de-otio/trellis/package.json'));
const lambdaDir = path.join(pkgRoot, 'dist', 'lambda');

const targets = ['@de-otio/trellis'];
if (fs.existsSync(lambdaDir)) {
  for (const f of fs.readdirSync(lambdaDir)) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      targets.push(path.join('@de-otio/trellis/dist/lambda', f.replace(/\\.js$/, '')));
    }
  }
}

let failed = 0;
for (const t of targets) {
  try {
    require(t);
    console.log('  ✓', t);
  } catch (err) {
    failed++;
    console.error('  ✗', t);
    console.error('   ', err.code || err.name, '-', err.message);
  }
}

if (failed > 0) {
  console.error('');
  console.error(failed + ' entry point(s) failed to load from the packed tarball.');
  console.error('Likely cause: a runtime import targets a package that is in');
  console.error('devDependencies, or a relative path that is not in package.json files[].');
  process.exit(1);
}

console.log('');
console.log('All ' + targets.length + ' entry point(s) loaded cleanly.');
"

echo "==> smoke test passed"
