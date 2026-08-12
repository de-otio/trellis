#!/usr/bin/env node
/**
 * CI gate: fail the build unless all THREE statements of the extension-API
 * version agree — the `EXTENSION_API_VERSION` const in
 * `packages/extension-api/src/extension.ts`, the `version` field in
 * `packages/extension-api/package.json`, and the "Current version" callout in
 * `docs/reference/extension-api.md`.
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
} from "./lib/extension-version-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const EXTENSION_TS_PATH = join(
  REPO_ROOT,
  "packages/extension-api/src/extension.ts",
);
const PACKAGE_JSON_PATH = join(
  REPO_ROOT,
  "packages/extension-api/package.json",
);
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
  console.log(result.message);
  process.exit(0);
}

main();
