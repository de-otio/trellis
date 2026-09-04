#!/usr/bin/env node
/**
 * CI gate helper (plan §2.3 / §4-T4): regenerate the public-type snapshots
 * for both `packages/extension-api` and `apps/api` and write them to their
 * committed `etc/public-api.snapshot.d.ts` files.
 *
 * NOTE (plan §2.3 race rule / fea-2): a snapshot committed by a fan-out
 * build agent is PROVISIONAL — a unit-test fixture, not the canonical
 * commit. T-INT regenerates both snapshots at the integration barrier, once
 * all sibling code (T7's route, T5's type change) is in place, and that
 * regeneration is what actually gets committed as canonical.
 *
 * Usage: node apps/api/scripts/update-api-snapshot.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageSpecs, generateSnapshotForPackage } from "./lib/generate-snapshots.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");

function main() {
  const specs = packageSpecs(REPO_ROOT);
  let failed = false;
  for (const spec of specs) {
    try {
      const content = generateSnapshotForPackage(TSC_BIN, spec);
      mkdirSync(dirname(spec.snapshotPath), { recursive: true });
      writeFileSync(spec.snapshotPath, content, "utf8");
      console.log(`Wrote ${spec.snapshotPath} (${spec.name})`);
    } catch (err) {
      failed = true;
      console.error(`Failed to generate snapshot for ${spec.name}: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
