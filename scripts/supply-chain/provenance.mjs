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

/**
 * name -> Set of versions installed from the public registry, plus bundled
 * copies. A bundled copy has no `resolved` (its bytes come from the parent's
 * tarball), but it claims a `name@version` that the registry can vouch for, so
 * a bundle that swaps in an unattested version of a known name is caught too.
 */
function registryVersions(lock) {
  const byName = new Map();
  for (const { name, version, entry, isLink } of listPackages(lock)) {
    if (isLink || version === null) continue;
    if (!isPublicRegistryUrl(entry.resolved) && entry.inBundle !== true) continue;
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(version);
  }
  return byName;
}

/**
 * For each package the base lockfile already had: every version the base had
 * (`baseVersions`) and every version the head has that the base did not
 * (`added`). A version that arrives next to an unchanged one (a new nested
 * copy) counts as much as a replacement: it is a new artifact under a name the
 * base trusted. A brand-new name has nothing to compare with (new-packages.mjs
 * flags it).
 */
export function changedVersions(baseLock, headLock) {
  const base = registryVersions(baseLock);
  const head = registryVersions(headLock);
  const changes = [];
  for (const [name, headSet] of [...head].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const baseSet = base.get(name);
    if (!baseSet) continue;
    const added = [...headSet].filter((v) => !baseSet.has(v)).sort();
    if (added.length > 0) {
      changes.push({ name, baseVersions: [...baseSet].sort(), added });
    }
  }
  return changes;
}

/**
 * `name@version` of every added version without provenance where ANY version
 * the base had of that name was attested. Lookups are sequential and lazy: the
 * added versions are only fetched when a base version was attested.
 */
export async function findProvenanceDrops(baseLock, headLock, fetchMeta) {
  const dropped = [];
  for (const { name, baseVersions, added } of changedVersions(baseLock, headLock)) {
    let previouslyAttested = false;
    for (const v of baseVersions) {
      if (hasProvenance(await fetchMeta(name, v))) {
        previouslyAttested = true;
        break;
      }
    }
    if (!previouslyAttested) continue;
    for (const v of added) {
      if (!hasProvenance(await fetchMeta(name, v))) {
        dropped.push({ name, version: v, replaced: baseVersions });
      }
    }
  }
  return dropped;
}
