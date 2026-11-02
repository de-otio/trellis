// Packages that arrive with, or gain, an install script (`hasInstallScript`).
//
// An install script runs arbitrary code on every machine that installs the
// package, so a dependency bump that introduces one deserves a human look. The
// lockfile records the fact as `hasInstallScript: true` on the entry.
//
// Comparison is by package NAME, not name@version: esbuild already has an
// install script, so esbuild 0.28.2 -> 0.28.3 is not news, while a package the
// base lockfile never had with a script is. Pure: takes two parsed lockfiles.

import { listPackages } from "./lockfile.mjs";

function withInstallScript(lock) {
  return listPackages(lock).filter(
    ({ entry, isLink }) => !isLink && entry.hasInstallScript === true,
  );
}

/**
 * `name@version` for every head entry with an install script whose package
 * name had no install-script entry in the base lockfile. Sorted, deduplicated.
 */
export function findNewInstallScripts(baseLock, headLock) {
  const known = new Set(withInstallScript(baseLock).map((p) => p.name));
  const flagged = new Set();
  for (const { name, version } of withInstallScript(headLock)) {
    if (!known.has(name)) flagged.add(`${name}@${version ?? "unknown"}`);
  }
  return [...flagged].sort();
}
