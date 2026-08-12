#!/usr/bin/env node
/**
 * CI gate: fail the build unless every statement of the extension-API version
 * agrees — the `EXTENSION_API_VERSION` const in
 * `packages/extension-api/src/extension.ts`, the `version` field in
 * `packages/extension-api/package.json`, the "Current version" callout in
 * `docs/reference/extension-api.md`, and the dependency range each consuming
 * workspace declares.
 *
 * WHY THIS EXISTS
 * ----------------
 * `EXTENSION_API_VERSION` is a runtime value (the startup validator, and any
 * consuming app) that must always describe the version actually published to
 * npm. There is no compiler check tying a string literal to a package.json
 * field, so without this gate the two can drift silently — a bump to one
 * without the other ships a runtime version string that lies about what's on
 * the registry.
 *
 * The doc was added as a third source after it was found claiming `0.8.0`
 * against a `0.8.1` package. Prose drift is not cosmetic here: the reference
 * doc is what an extension author — increasingly, an author's coding agent —
 * treats as ground truth, so a stale version line becomes generated code
 * written against a contract that no longer exists.
 *
 * The consumer ranges were added as a fourth source after the 0.9.0 bump moved
 * the first three and left `apps/api` and `apps/worker` declaring `^0.8.0` — a
 * range that excludes 0.9.0, since a caret pins the minor below 1.0.0. Every
 * local gate passed anyway, because an already-installed workspace symlink does
 * not care about the range; only `npm ci` on a clean checkout noticed.
 *
 * This script compares the sources TO EACH OTHER, never to a hardcoded
 * expected value, so it is correct no matter which one was bumped most
 * recently or in what order sibling changes land.
 *
 * Usage: node apps/api/scripts/check-extension-api-version.mjs
 * Exit code 0 = in sync. Exit code 1 = mismatch or unreadable/malformed input.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractVersionConst,
  extractPackageVersion,
  extractDocVersion,
  compareAllVersions,
  checkConsumerRanges,
} from "./lib/extension-version-check.mjs";

const DEPENDENCY_NAME = "@de-otio/trellis-extension-api";

/** Workspaces that depend on the contract package. */
const CONSUMER_MANIFESTS = ["apps/api/package.json", "apps/worker/package.json"];

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const EXTENSION_TS_PATH = join(REPO_ROOT, "packages/extension-api/src/extension.ts");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "packages/extension-api/package.json");
const REFERENCE_DOC_PATH = join(REPO_ROOT, "docs/reference/extension-api.md");

function main() {
  let source;
  try {
    source = readFileSync(EXTENSION_TS_PATH, "utf8");
  } catch (err) {
    console.error(
      `check-extension-api-version: could not read ${EXTENSION_TS_PATH}: ${err.message}`,
    );
    process.exit(1);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  } catch (err) {
    console.error(
      `check-extension-api-version: could not read/parse ${PACKAGE_JSON_PATH}: ${err.message}`,
    );
    process.exit(1);
  }

  let docSource;
  try {
    docSource = readFileSync(REFERENCE_DOC_PATH, "utf8");
  } catch (err) {
    console.error(
      `check-extension-api-version: could not read ${REFERENCE_DOC_PATH}: ${err.message}`,
    );
    process.exit(1);
  }

  let constVersion;
  let packageVersion;
  let docVersion;
  try {
    constVersion = extractVersionConst(source);
    packageVersion = extractPackageVersion(packageJson);
    docVersion = extractDocVersion(docSource);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const result = compareAllVersions(constVersion, packageVersion, docVersion);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }

  // Fourth source: what each consuming workspace says it accepts. Read here
  // rather than from the lockfile, because the manifests are what `npm ci`
  // validates the lockfile against.
  const consumers = [];
  for (const relPath of CONSUMER_MANIFESTS) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8"));
    } catch (err) {
      console.error(`check-extension-api-version: could not read/parse ${relPath}: ${err.message}`);
      process.exit(1);
    }
    const range =
      manifest.dependencies?.[DEPENDENCY_NAME] ??
      manifest.devDependencies?.[DEPENDENCY_NAME] ??
      manifest.peerDependencies?.[DEPENDENCY_NAME];
    if (typeof range !== "string") {
      console.error(
        `check-extension-api-version: ${relPath} does not declare ` +
          `${DEPENDENCY_NAME}. Either it should, or CONSUMER_MANIFESTS in this ` +
          `script is stale — fix whichever is wrong rather than removing the check.`,
      );
      process.exit(1);
    }
    consumers.push({ path: relPath, range });
  }

  let rangeResult;
  try {
    rangeResult = checkConsumerRanges(packageVersion, consumers);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!rangeResult.ok) {
    console.error(rangeResult.message);
    process.exit(1);
  }

  console.log(result.message);
  console.log(rangeResult.message);
  process.exit(0);
}

main();
