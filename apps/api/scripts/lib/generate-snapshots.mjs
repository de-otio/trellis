// Shared driver for `update-api-snapshot.mjs` and `check-api-snapshot.mjs`
// (plan §2.3 / §4-T4): produces the current (freshly generated) snapshot
// content for both packages. update-api-snapshot.mjs writes this to the
// committed snapshot files; check-api-snapshot.mjs diffs it against them.

import { join } from "node:path";
import { emitDeclarations } from "./tsc-emit.mjs";
import {
  buildSnapshotContent,
  traceReachableDeclarations,
} from "./snapshot-concat.mjs";

/**
 * @typedef {{ name: string, tsconfigPath: string, entryRelPath: string, snapshotPath: string }} PackageSpec
 */

/**
 * @param {string} repoRoot
 * @returns {PackageSpec[]}
 */
export function packageSpecs(repoRoot) {
  return [
    {
      name: "extension-api",
      tsconfigPath: join(repoRoot, "packages/extension-api/tsconfig.json"),
      entryRelPath: "index.d.ts",
      snapshotPath: join(
        repoRoot,
        "packages/extension-api/etc/public-api.snapshot.d.ts",
      ),
    },
    {
      name: "apps/api",
      tsconfigPath: join(repoRoot, "apps/api/tsconfig.json"),
      entryRelPath: "index.d.ts",
      snapshotPath: join(repoRoot, "apps/api/etc/public-api.snapshot.d.ts"),
    },
  ];
}

/**
 * Generate the current snapshot content for one package.
 *
 * @param {string} tscBinPath
 * @param {PackageSpec} spec
 * @returns {string}
 */
export function generateSnapshotForPackage(tscBinPath, spec) {
  const { filesByRelPath } = emitDeclarations(tscBinPath, spec.tsconfigPath);
  const reachable = new Set(
    traceReachableDeclarations(spec.entryRelPath, filesByRelPath),
  );
  const entries = [...reachable].map((relPath) => ({
    relPath,
    content: filesByRelPath[relPath],
  }));
  return buildSnapshotContent(entries);
}
