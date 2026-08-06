#!/usr/bin/env node
/**
 * CI gate (plan §2.3 / §4-T4): regenerate both packages' public-type
 * snapshots in-memory and fail if either differs from the committed
 * `etc/public-api.snapshot.d.ts`. Prints the diff on failure so the author
 * can see exactly what changed before running
 * `node apps/api/scripts/update-api-snapshot.mjs` to regenerate it.
 *
 * Usage: node apps/api/scripts/check-api-snapshot.mjs
 * Exit code 0 = both snapshots match. Exit code 1 = a diff (or generation
 * failure) was found.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageSpecs, generateSnapshotForPackage } from "./lib/generate-snapshots.mjs";
import { diffSnapshots } from "./lib/snapshot-concat.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");

function main() {
  const specs = packageSpecs(REPO_ROOT);
  let failed = false;

  for (const spec of specs) {
    let actual;
    try {
      actual = generateSnapshotForPackage(TSC_BIN, spec);
    } catch (err) {
      failed = true;
      console.error(`Failed to generate snapshot for ${spec.name}: ${err.message}`);
      continue;
    }

    const expected = existsSync(spec.snapshotPath)
      ? readFileSync(spec.snapshotPath, "utf8")
      : "";

    const diff = diffSnapshots(expected, actual);
    if (diff !== null) {
      failed = true;
      console.error(
        `\nPublic API snapshot out of date for ${spec.name} (${spec.snapshotPath}):\n` +
          `${diff}\n\n` +
          `Run: node apps/api/scripts/update-api-snapshot.mjs\n`,
      );
    } else {
      console.log(`${spec.name}: snapshot up to date.`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main();
