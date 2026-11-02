// Packages the head lockfile has that the base lockfile has never had.
//
// The other two flag checks only see a package that already existed (a version
// change) or one that declares an install script. A dependency bump that pulls
// in a fresh transitive package with a plain runtime payload, no install script
// and no provenance to lose, trips neither: the event-stream shape. A new name
// in the tree is the one signal that is always present, so it is flagged for a
// human regardless of what the package contains.
//
// Keyed by package name. A new version or an extra nested copy of a name the
// base already had is not new here (provenance.mjs covers it). Pure: takes two
// parsed lockfiles.

import { listPackages } from "./lockfile.mjs";

function installable(lock) {
  return listPackages(lock).filter(({ isLink }) => !isLink);
}

/** `name@version` for every head package whose name is absent from base. Sorted, deduplicated. */
export function findNewPackages(baseLock, headLock) {
  const known = new Set(installable(baseLock).map((p) => p.name));
  const flagged = new Set();
  for (const { name, version } of installable(headLock)) {
    if (!known.has(name)) flagged.add(`${name}@${version ?? "unknown"}`);
  }
  return [...flagged].sort();
}
