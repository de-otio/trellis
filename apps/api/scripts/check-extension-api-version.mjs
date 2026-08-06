#!/usr/bin/env node
/**
 * CI gate (plan §2.3 / §4-T4): fail the build if
 * `packages/extension-api/src/extension.ts`'s `EXTENSION_API_VERSION` const
 * and `packages/extension-api/package.json`'s `version` field disagree.
 *
 * WHY THIS EXISTS
 * ----------------
 * `EXTENSION_API_VERSION` is a runtime value (T5's startup validator, and any
 * consuming app) that must always describe the version actually published to
 * npm. There is no compiler check tying a string literal to a package.json
 * field, so without this gate the two can drift silently — a bump to one
 * without the other ships a runtime version string that lies about what's on
 * the registry.
 *
 * This script compares the two sources TO EACH OTHER, never to a hardcoded
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
  compareVersions,
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

  let constVersion;
  let packageVersion;
  try {
    constVersion = extractVersionConst(source);
    packageVersion = extractPackageVersion(packageJson);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const result = compareVersions(constVersion, packageVersion);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
  process.exit(0);
}

main();
