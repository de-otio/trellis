#!/usr/bin/env node
// Fail when any `resolved` URL in package-lock.json is not on the public npm
// registry.
//
// WHY THIS EXISTS
// ---------------
// `npm install` through a private registry (a corporate artifact proxy, a
// company mirror) bakes that registry's host into every `resolved` field of the
// lockfile. The lockfile is committed, so a private hostname leaks into a
// public repo and every consumer's `npm ci` starts talking to a host that is
// not theirs. Nothing else in CI looks at those fields.
//
// Rule: every non-link entry that has a `resolved` must start with
// `https://registry.npmjs.org/`. Entries without `resolved` (the root, bundled
// dependencies, workspace source directories) are fine, and so are `link: true`
// entries, whose `resolved` is a workspace path rather than a URL.
//
// Usage: node scripts/supply-chain/registry-host.mjs [package-lock.json]
// Exit:  0 clean, 1 offenders found, 2 could not read or parse the lockfile.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isPublicRegistryUrl, listPackages } from "./lockfile.mjs";

/**
 * Entries whose `resolved` is present but not a public-registry tarball URL.
 * Pure: takes the parsed lockfile, returns `{ path, resolved }[]`.
 */
export function findRegistryOffenders(lock) {
  const offenders = [];
  for (const { path, entry, isLink } of listPackages(lock)) {
    if (isLink) continue;
    if (!("resolved" in entry)) continue;
    if (!isPublicRegistryUrl(entry.resolved)) {
      offenders.push({ path, resolved: entry.resolved });
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
    console.log(`${o.path}  resolved=${JSON.stringify(o.resolved)}`);
  }
  if (offenders.length > 0) {
    console.log(
      `\nregistry-host: ${offenders.length} lockfile entr${offenders.length === 1 ? "y does" : "ies do"} not resolve from https://registry.npmjs.org/.\n` +
        "Regenerate the lockfile against the public registry:\n" +
        "  npm install --registry=https://registry.npmjs.org/ --package-lock-only",
    );
    return 1;
  }
  console.log(`registry-host: ${file}: every resolved URL is on registry.npmjs.org.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
