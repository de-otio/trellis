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
# NOTE ON THE EXPORTS MAP (added 2026-08). @de-otio/trellis declares an
# `exports` map whose only job is to make the unwired voting crypto
# unreachable while every other path keeps resolving exactly as before.
#
# Declaring `exports` at ALL disables Node's extension probing, which is how a
# first attempt broke 20 of 21 entry points: with no map, `.../hourly-cron`
# finds `hourly-cron.js`; with one, the target must be exact. The map therefore
# carries TWO patterns per prefix — `./dist/*.js` (explicit, passes through)
# and `./dist/*` (extensionless, appends `.js`) — and Node's most-specific-
# pattern rule picks the right one. A `null` on the narrower `voting/` base
# beats both.
#
# The three blocks below are the gate on that. They must stay together: the
# positive list alone cannot distinguish a working map from no map at all,
# and a map that blocks nothing passes it perfectly.
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

# ---------------------------------------------------------------------------
# Downstream deep specifiers.
#
# The lambda list above is generated from the tarball, so it can only assert
# what the package already contains. These are the specifiers a REAL consumer
# imports, transcribed from the consuming application, and they are the set the
# reverted 2026-08 exports map would have broken. Both spelling forms are
# asserted wherever a consumer uses either, because the map treats them via
# different patterns and only one of them was broken last time.
#
# Keep this list WIDER than the current consumer, not equal to it: its purpose
# is to fail when the map narrows, and a list that tracks the consumer exactly
# stops being an independent check.
# ---------------------------------------------------------------------------
echo "==> requiring downstream deep specifiers (both spellings)"
node --input-type=commonjs -e "
const targets = [
  // package root + manifest
  '@de-otio/trellis',
  '@de-otio/trellis/package.json',
  // the moderation seam — the heaviest downstream dependency
  '@de-otio/trellis/dist/lib/media/ffmpeg-args.js',
  '@de-otio/trellis/dist/lib/media/media-lifecycle.js',
  '@de-otio/trellis/dist/lib/media/media-ports.js',
  '@de-otio/trellis/dist/lib/media/moderation-provider.js',
  '@de-otio/trellis/dist/lib/media/request-moderation.js',
  '@de-otio/trellis/dist/lib/media/request-text-moderation.js',
  '@de-otio/trellis/dist/lib/media/spend-guard.js',
  '@de-otio/trellis/dist/lib/media/text-moderation.js',
  '@de-otio/trellis/dist/lib/media/track-verdict.js',
  // other lib deep imports
  '@de-otio/trellis/dist/lib/cost-accumulator.js',
  '@de-otio/trellis/dist/lib/database-connection-manager.js',
  '@de-otio/trellis/dist/lib/extension-scoped-db.js',
  '@de-otio/trellis/dist/lib/graph/index.js',
  '@de-otio/trellis/dist/lib/lambda-prisma.js',
  '@de-otio/trellis/dist/lib/openai-budget.js',
  '@de-otio/trellis/dist/lib/user-export-handler.js',
  // lambdas, explicit .js (the generated list above covers extensionless)
  '@de-otio/trellis/dist/lambda/media-completion-worker.js',
  '@de-otio/trellis/dist/lambda/media-processing-worker.js',
  // extensionless, and it resolves today — the form the reverted map broke
  '@de-otio/trellis/dist/env',
  '@de-otio/trellis/dist/env.js',
  '@de-otio/trellis/dist/lib/media/media-ports',
  '@de-otio/trellis/dist/lib/graph/index',
  // live crypto seam: startup wiring a deployment calls (Scaleway has no KMS
  // GenerateMac). Deliberately NOT blocked — only voting/ is.
  '@de-otio/trellis/dist/lib/crypto/software-hmac-mac.js',
  '@de-otio/trellis/dist/lib/crypto/software-hmac-mac',
];

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
  console.error(failed + ' downstream specifier(s) failed to resolve.');
  console.error('An exports map that does not list a path a consumer imports');
  console.error('breaks that consumer at runtime with ERR_PACKAGE_PATH_NOT_EXPORTED,');
  console.error('or ERR_MODULE_NOT_FOUND if the pattern resolved to a missing file.');
  process.exit(1);
}
console.log('');
console.log('All ' + targets.length + ' downstream specifier(s) resolved.');
"

# ---------------------------------------------------------------------------
# NEGATIVE assertions — the private interior must be refused.
#
# Without these the gate cannot tell a working map from no map at all: every
# positive assertion above passes just as happily with no `exports` field.
# Same discipline as the @ts-expect-error cases in the extension-api type
# tests — the check has to be able to fail for the right reason.
#
# The error code is asserted, not just the throw. ERR_PACKAGE_PATH_NOT_EXPORTED
# means the map refused the path; ERR_MODULE_NOT_FOUND would mean the map let
# it through to a file that happens not to exist, which is a different (and
# fragile) reason to pass.
# ---------------------------------------------------------------------------
echo "==> asserting the private interior is refused"
node --input-type=commonjs -e "
const blocked = [
  '@de-otio/trellis/dist/lib/crypto/voting/elgamal-encryption.js',
  '@de-otio/trellis/dist/lib/crypto/voting/hybrid-encryption.js',
  '@de-otio/trellis/dist/lib/crypto/voting/post-quantum-encryption.js',
  '@de-otio/trellis/dist/lib/crypto/voting/encryption-scheme.js',
  '@de-otio/trellis/dist/lib/crypto/voting/hash-utils.js',
  '@de-otio/trellis/dist/lib/crypto/voting/index.js',
  // extensionless spelling must be refused too, or the block is bypassable
  '@de-otio/trellis/dist/lib/crypto/voting/elgamal-encryption',
  '@de-otio/trellis/dist/lib/crypto/voting/index',
];

let failed = 0;
for (const t of blocked) {
  let code = null;
  try {
    require(t);
  } catch (err) {
    code = err.code || err.name;
  }
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    console.log('  ✓ refused', t);
  } else if (code === null) {
    failed++;
    console.error('  ✗ LOADED (should be unreachable):', t);
  } else {
    failed++;
    console.error('  ✗ wrong failure mode for', t);
    console.error('    expected ERR_PACKAGE_PATH_NOT_EXPORTED, got', code);
  }
}
if (failed > 0) {
  console.error('');
  console.error(failed + ' path(s) that must be private are not.');
  console.error('The exports map is missing its null exclusion, or a broader');
  console.error('pattern is out-ranking it. Node picks the MOST SPECIFIC');
  console.error('pattern: a null on a narrower base must win over ./dist/*.');
  process.exit(1);
}
console.log('');
console.log('All ' + blocked.length + ' private path(s) refused.');
"

# ---------------------------------------------------------------------------
# TYPE resolution.
#
# An `exports` map governs TypeScript's resolution too, under moduleResolution
# node16/nodenext — which is what the consuming application uses. A map can
# therefore resolve perfectly at runtime and still break the consumer's BUILD,
# and every check above would stay green. That is the failure this block
# exists for; it is not covered by loading modules.
#
# Asserts three things at once: deep specifiers still carry types, the blocked
# path is refused by tsc as well as by Node, and the root still resolves.
# ---------------------------------------------------------------------------
echo "==> asserting TypeScript still resolves the same specifiers"
mkdir -p "${CONSUMER_DIR}/tscheck"
cat > "${CONSUMER_DIR}/tscheck/tsconfig.json" <<'TSCONFIG'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["probe.ts"]
}
TSCONFIG
cat > "${CONSUMER_DIR}/tscheck/probe.ts" <<'PROBE'
// Deep specifiers a consumer imports must still carry types under the map.
import type * as ports from "@de-otio/trellis/dist/lib/media/media-ports.js";
import type * as verdict from "@de-otio/trellis/dist/lib/media/track-verdict.js";
import type * as scoped from "@de-otio/trellis/dist/lib/extension-scoped-db.js";
import type * as mac from "@de-otio/trellis/dist/lib/crypto/software-hmac-mac.js";

export type Keep = [typeof ports, typeof verdict, typeof scoped, typeof mac];

// And the private interior must be refused by tsc, not only by Node.
// @ts-expect-error — dist/lib/crypto/voting/* is not an exported path
import type * as blocked from "@de-otio/trellis/dist/lib/crypto/voting/elgamal-encryption.js";
export type Blocked = typeof blocked;
PROBE
( cd "${CONSUMER_DIR}/tscheck" && npx -y -p typescript@7 tsc -p tsconfig.json )
echo "  OK: deep specifiers type-resolve, and voting/* is refused by tsc"

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
