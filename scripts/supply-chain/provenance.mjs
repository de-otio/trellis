// Packages whose new version dropped npm provenance.
//
// A maintainer who published with provenance (a signed, build-linked
// attestation) and then ships a version without it has changed how the package
// is built or published: the usual shape of a hijacked maintainer token. The
// attestation is advertised in the registry's version metadata as
// `dist.attestations.provenance`.
//
// The core is pure. The registry lookup is a `fetchMeta(name, version)`
// function passed in: it resolves to the version's registry manifest, or null
// when the registry has no such version, and rejects on any other failure.
// Tests pass fixtures; fetch-registry.mjs is the network edge.

import { isPublicRegistryUrl, listPackages } from "./lockfile.mjs";

/** Whether a registry version manifest advertises npm provenance. */
export function hasProvenance(meta) {
  const predicate = meta?.dist?.attestations?.provenance?.predicateType;
  return typeof predicate === "string" && predicate.length > 0;
}

/** name -> Set of versions installed from the public registry. */
function registryVersions(lock) {
  const byName = new Map();
  for (const { name, version, entry, isLink } of listPackages(lock)) {
    if (isLink || version === null || !isPublicRegistryUrl(entry.resolved)) {
      continue;
    }
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(version);
  }
  return byName;
}

/**
 * The version changes between two lockfiles: for each package present in both
 * whose version set changed, the versions that went away and the ones that
 * arrived. A brand-new package, or an extra copy at the same version, is not a
 * version change (install-scripts covers new packages).
 */
export function changedVersions(baseLock, headLock) {
  const base = registryVersions(baseLock);
  const head = registryVersions(headLock);
  const changes = [];
  for (const [name, headSet] of [...head].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const baseSet = base.get(name);
    if (!baseSet) continue;
    const removed = [...baseSet].filter((v) => !headSet.has(v)).sort();
    const added = [...headSet].filter((v) => !baseSet.has(v)).sort();
    if (removed.length > 0 && added.length > 0) {
      changes.push({ name, removed, added });
    }
  }
  return changes;
}

/**
 * `name@version` of every new version without provenance whose replaced
 * version had it. Lookups are sequential and lazy: the new version is only
 * fetched when an old one was attested.
 */
export async function findProvenanceDrops(baseLock, headLock, fetchMeta) {
  const dropped = [];
  for (const { name, removed, added } of changedVersions(baseLock, headLock)) {
    let previouslyAttested = false;
    for (const v of removed) {
      if (hasProvenance(await fetchMeta(name, v))) {
        previouslyAttested = true;
        break;
      }
    }
    if (!previouslyAttested) continue;
    for (const v of added) {
      if (!hasProvenance(await fetchMeta(name, v))) {
        dropped.push({ name, version: v, replaced: removed });
      }
    }
  }
  return dropped;
}
