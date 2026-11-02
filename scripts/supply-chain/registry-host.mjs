#!/usr/bin/env node
// Fail when package-lock.json resolves anything from somewhere other than the
// public npm registry, or when an installable entry is not pinned the way npm
// pins a registry package.
//
// WHY THIS EXISTS
// ---------------
// 1. `npm install` through a private registry (a corporate artifact proxy, a
//    company mirror) bakes that registry's host into every `resolved` field of
//    the lockfile. The lockfile is committed, so a private hostname leaks into a
//    public repo and every consumer's `npm ci` starts talking to a host that is
//    not theirs. Nothing else in CI looks at those fields.
// 2. The lockfile is attacker-controlled input to every other supply-chain
//    check. An entry with no `resolved` or no `integrity` is skipped by
//    `npm audit signatures`, and an entry whose `name` field disagrees with its
//    path can pass as another package. One canonical rule closes both: an
//    installable entry carries exactly the `resolved` and `integrity` npm would
//    have written for its own path.
//
// THE RULE
// --------
// Link entries (`link: true`, whose `resolved` is a workspace path) and
// workspace source directories (a path with no `node_modules/` segment) are
// exempt. Every other entry must have:
//   - `resolved` that is a public-registry URL (`https://registry.npmjs.org/…`),
//     and, unless the entry is `inBundle`, exactly
//     `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz`, where
//     <name> comes from the node_modules PATH (the last `node_modules/`
//     segment, scoped names included). An `npm:` alias is the one case where
//     `entry.name` differs from the path; there <name> is `entry.name`, and it
//     is `resolved` that has to agree, so a lone spoofed `name` never passes;
//   - `integrity`, a non-empty string.
// An `inBundle` entry is extracted from its parent's tarball and has no
// `resolved`; it is accepted only if the parent entry declares bundled
// dependencies that include it.
//
// A git or file dependency fails here, before `npm ci` could run its `prepare`.
//
// Usage: node scripts/supply-chain/registry-host.mjs [package-lock.json]
// Exit:  0 clean, 1 offenders found, 2 could not read or parse the lockfile.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expectedTarballUrl, isPublicRegistryUrl, listPackages } from "./lockfile.mjs";

function declaresBundled(lock, path, pathName) {
  const parentPath = path
    .slice(0, path.length - "node_modules/".length - pathName.length)
    .replace(/\/$/, "");
  if (!Object.hasOwn(lock.packages, parentPath)) return false;
  const parent = lock.packages[parentPath];
  const declared = parent.bundleDependencies ?? parent.bundledDependencies;
  return declared === true || (Array.isArray(declared) && declared.includes(pathName));
}

/**
 * Entries that break the rule above, as `{ path, reason, resolved }[]` with
 * `reason` one of: `resolved-not-public-registry`, `missing-resolved`,
 * `missing-integrity`, `missing-version`, `resolved-mismatch`,
 * `unbundled-inbundle`. Pure: takes the parsed lockfile.
 */
export function findRegistryOffenders(lock) {
  const offenders = [];
  const add = (path, reason, entry) => offenders.push({ path, reason, resolved: entry.resolved });

  for (const { path, pathName, version, entry, isLink } of listPackages(lock)) {
    if (isLink) continue;
    const hasResolved = "resolved" in entry;

    if (hasResolved && !isPublicRegistryUrl(entry.resolved)) {
      add(path, "resolved-not-public-registry", entry);
      continue;
    }
    if (pathName === null) continue; // workspace source directory

    if (entry.inBundle === true) {
      if (!declaresBundled(lock, path, pathName)) add(path, "unbundled-inbundle", entry);
      continue;
    }
    if (!hasResolved) {
      add(path, "missing-resolved", entry);
      continue;
    }
    if (typeof entry.integrity !== "string" || entry.integrity === "") {
      add(path, "missing-integrity", entry);
    }
    if (version === null) {
      add(path, "missing-version", entry);
      continue;
    }
    const tarballName = typeof entry.name === "string" ? entry.name : pathName;
    if (entry.resolved !== expectedTarballUrl(tarballName, version)) {
      add(path, "resolved-mismatch", entry);
    }
  }
  return offenders;
}

function main(argv) {
  const file = argv[0] ?? "package-lock.json";
  let offenders;
  try {
    offenders = findRegistryOffenders(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    console.error(`registry-host: cannot check ${file}: ${err.message}`);
    return 2;
  }
  for (const o of offenders) {
    console.log(`${o.path}  ${o.reason}  resolved=${JSON.stringify(o.resolved)}`);
  }
  if (offenders.length > 0) {
    console.log(
      `\nregistry-host: ${offenders.length} lockfile entr${offenders.length === 1 ? "y breaks" : "ies break"} the registry rule (see header of scripts/supply-chain/registry-host.mjs).\n` +
        "If the host is wrong, regenerate against the public registry:\n" +
        "  npm install --registry=https://registry.npmjs.org/ --package-lock-only",
    );
    return 1;
  }
  console.log(`registry-host: ${file}: every installable entry resolves from registry.npmjs.org.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
