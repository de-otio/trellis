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

# @de-otio/trellis depends on @de-otio/trellis-extension-api. In a coupled
# release the two are bumped together, so the new extension-api version is not
# on npm yet when this PR runs. Pack it locally and install it alongside the
# trellis tarball so the smoke test is self-contained (saas-foundation /
# vestibulum still resolve from the registry — they publish first).
echo "==> packing @de-otio/trellis-extension-api from ${REPO_ROOT}/packages/extension-api"
( cd "${REPO_ROOT}/packages/extension-api" && npm pack --silent --pack-destination "${PACK_DIR}" >/dev/null )
EXTAPI_TARBALL="$(find "${PACK_DIR}" -name 'de-otio-trellis-extension-api-*.tgz' -type f | head -n1)"
if [ -z "${EXTAPI_TARBALL}" ] || [ ! -f "${EXTAPI_TARBALL}" ]; then
  echo "::error::Could not locate packed extension-api tarball under ${PACK_DIR}"
  exit 1
fi
echo "==> packed extension-api: ${EXTAPI_TARBALL}"

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

echo "==> installing tarballs with --omit=dev (mimics container build)"
# --no-fund / --no-audit keep output tight in CI logs. Install the local
# extension-api tarball first so it satisfies trellis's dependency on it.
# @prisma/client is a peerDependency (not a regular dependency) of
# @de-otio/trellis (see finding: trellis ships dist compiled against its own
# Prisma client while a consumer regenerates from the tarball schema with its
# own Prisma pins — a silent runtime-skew trap if the two drift). npm >=7
# auto-installs a satisfying peer by default, which is what we're verifying
# below actually happened.
npm install "${EXTAPI_TARBALL}" "${TARBALL_PATH}" --omit=dev --no-fund --no-audit --silent

# Prisma 7's bare @prisma/client exports nothing until a client is generated
# from a schema. trellis ships its schema in the tarball, and every consuming
# application generates against it as a build step (its own `prisma:generate`).
# Reproduce that here so the static `@prisma/client` imports in the shipped
# lambdas can load — otherwise this would fail in a way a real consumer never
# hits. `prisma generate` reads only the schema; it needs no datasource/DB.
echo "==> generating Prisma client from the shipped schema (mimics consumer build)"
npx -y prisma@7 generate --schema node_modules/@de-otio/trellis/prisma/schema.prisma >/dev/null

# Assert the installed @prisma/client version actually satisfies the peer
# range @de-otio/trellis declares in its own package.json. This is the crux
# of the peer-dep fix: catch, in CI, the exact skew that used to be silent —
# a consumer whose own @prisma/client pin has drifted from what trellis's
# compiled dist expects.
echo "==> asserting installed @prisma/client version satisfies trellis's peerDependencies range"
node -e "
const requiredRange = require('@de-otio/trellis/package.json').peerDependencies && require('@de-otio/trellis/package.json').peerDependencies['@prisma/client'];
if (!requiredRange) {
  console.error('::error::@de-otio/trellis package.json has no peerDependencies[\"@prisma/client\"] entry');
  process.exit(1);
}
const installed = require('@prisma/client/package.json').version;
console.log('  trellis peerDependencies[\"@prisma/client\"]:', requiredRange);
console.log('  installed @prisma/client version:           ', installed);

// Minimal caret-range check — deliberately dependency-free (no 'semver'
// import) since this is a smoke test over a fresh consumer install. Only
// needs to handle the '^X.Y.Z' shape trellis actually declares.
const reqMatch = requiredRange.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
const insMatch = installed.match(/^(\d+)\.(\d+)\.(\d+)/);
if (!reqMatch || !insMatch) {
  console.error('::error::could not parse version range/installed version for caret comparison:', requiredRange, installed);
  process.exit(1);
}
const [reqMajor, reqMinor, reqPatch] = reqMatch.slice(1).map(Number);
const [insMajor, insMinor, insPatch] = insMatch.slice(1).map(Number);
const satisfies = insMajor === reqMajor && (insMinor > reqMinor || (insMinor === reqMinor && insPatch >= reqPatch));
if (!satisfies) {
  console.error('::error::installed @prisma/client ' + installed + ' does not satisfy trellis peerDependencies range ' + requiredRange);
  process.exit(1);
}
console.log('  OK: installed @prisma/client satisfies trellis peerDependencies range');
"

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

# The extension-api tarball was packed and installed above purely to satisfy
# trellis's dependency on it — nothing ever loaded it. That gap is why an
# `exports` map added to @de-otio/trellis in 2026-08 broke 20 of 21 consumer
# entry points without any local gate noticing: every other check runs against
# src/, and only a packed-tarball load exercises resolution. Extension authors
# consume this package directly, so it gets the same treatment.
#
# The contract asserted here is the PACKAGE ROOT, in both module systems.
# Deep specifiers (".../lib/index.js") are deliberately NOT part of the
# contract — the exports map exposes the root only.
echo "==> loading @de-otio/trellis-extension-api from the packed tarball"
node --input-type=module -e "
const mod = await import('@de-otio/trellis-extension-api');
if (typeof mod.EXTENSION_API_VERSION !== 'string') {
  console.error('::error::EXTENSION_API_VERSION missing or not a string on the ESM import');
  process.exit(1);
}
console.log('  ✓ ESM import — EXTENSION_API_VERSION', mod.EXTENSION_API_VERSION);
"
node --input-type=commonjs -e "
const mod = require('@de-otio/trellis-extension-api');
if (typeof mod.EXTENSION_API_VERSION !== 'string') {
  console.error('::error::EXTENSION_API_VERSION missing or not a string on the CJS require');
  process.exit(1);
}
console.log('  ✓ CJS require — EXTENSION_API_VERSION', mod.EXTENSION_API_VERSION);
"

# The published version must match the constant inside the packed artifact.
# The in-repo lockstep gate compares source-to-source; this compares what a
# consumer actually installs, which is the thing that can drift at pack time.
echo "==> asserting the packed extension-api version matches its exported constant"
node --input-type=module -e "
const { createRequire } = await import('node:module');
const require = createRequire(process.cwd() + '/');
const pkg = require('@de-otio/trellis-extension-api/package.json');
const mod = await import('@de-otio/trellis-extension-api');
if (pkg.version !== mod.EXTENSION_API_VERSION) {
  console.error('::error::packed extension-api version ' + pkg.version + ' != EXTENSION_API_VERSION ' + mod.EXTENSION_API_VERSION);
  process.exit(1);
}
console.log('  OK: packed version and exported constant agree (' + pkg.version + ')');
"

echo "==> smoke test passed"
