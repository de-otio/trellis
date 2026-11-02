#!/usr/bin/env node
// The combined supply-chain verdict for a dependency change.
//
//   node scripts/supply-chain/flags.mjs <base-lockfile> <head-lockfile>
//
// Prints one JSON object to stdout:
//
//   {"flags":[{"package":"name@version","reason":R}]}
//
// where R is one of:
//   "new-package"         the name is in the head lockfile and not in the base
//   "new-install-script"  an install script the base did not have for that name
//   "provenance-dropped"  a version with no npm provenance where the base's had it
//
// and exits 0 whenever it ran to completion, flags or not. A flag is a request
// for a human, not a failure; any flag means "human review". Exit 2 means the
// tool itself could not decide (unreadable lockfile, a head lockfile that
// breaks the registry-host rule, registry unreachable): callers must treat that
// as "not safe to merge unattended", never as "no flags". Diagnostics go to
// stderr so stdout stays machine-readable.
//
// The head lockfile is checked against the registry-host rule first. Its
// identity fields (name, version, resolved) are what every flag is computed
// from, and they are attacker-controlled; the rule is what makes them
// trustworthy. The registry-host and `npm audit signatures` checks are also
// run on their own as hard failures in the `supply-chain` job of ci.yml.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fetchVersionMeta } from "./fetch-registry.mjs";
import { findNewInstallScripts } from "./install-scripts.mjs";
import { findNewPackages } from "./new-packages.mjs";
import { findProvenanceDrops } from "./provenance.mjs";
import { findRegistryOffenders } from "./registry-host.mjs";

/**
 * Pure apart from `fetchMeta`, which is injected. Returns `{ flags, notes }`:
 * `flags` is the contract payload (sorted, so output is deterministic) and
 * `notes` are human-readable explanations for the log. Throws when the head
 * lockfile breaks the registry-host rule.
 */
export async function computeFlags(baseLock, headLock, fetchMeta) {
  const offenders = findRegistryOffenders(headLock);
  if (offenders.length > 0) {
    throw new Error(
      `head lockfile breaks the registry-host rule in ${offenders.length} entr${offenders.length === 1 ? "y" : "ies"} ` +
        `(first: ${offenders[0].path}, ${offenders[0].reason}); run registry-host.mjs`,
    );
  }

  const flags = [];
  const notes = [];

  for (const pkg of findNewPackages(baseLock, headLock)) {
    flags.push({ package: pkg, reason: "new-package" });
    notes.push(`${pkg}: not in the base lockfile`);
  }

  for (const pkg of findNewInstallScripts(baseLock, headLock)) {
    flags.push({ package: pkg, reason: "new-install-script" });
    notes.push(`${pkg}: has an install script the base lockfile did not have`);
  }

  for (const { name, version, replaced } of await findProvenanceDrops(
    baseLock,
    headLock,
    fetchMeta,
  )) {
    flags.push({ package: `${name}@${version}`, reason: "provenance-dropped" });
    notes.push(`${name}@${version}: no npm provenance, but ${replaced.join(", ")} had it`);
  }

  flags.sort((a, b) => a.package.localeCompare(b.package) || a.reason.localeCompare(b.reason));
  return { flags, notes };
}

async function main(argv) {
  if (argv.length !== 2) {
    console.error("usage: node scripts/supply-chain/flags.mjs <base-lockfile> <head-lockfile>");
    return 2;
  }
  try {
    const [base, head] = argv.map((f) => JSON.parse(readFileSync(f, "utf8")));
    const { flags, notes } = await computeFlags(base, head, fetchVersionMeta);
    for (const n of notes) console.error(`flag: ${n}`);
    console.log(JSON.stringify({ flags }));
    return 0;
  } catch (err) {
    console.error(`flags: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
