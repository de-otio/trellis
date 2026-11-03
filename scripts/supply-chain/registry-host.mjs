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
// An `inBundle` entry is extracted from a bundler's tarball and has no
// `resolved`; it is accepted only if its parent entry declares it in
// `bundleDependencies`, or if its path is in the transitive dependency closure of
// the nearest non-`inBundle` ancestor's declared list (see bundleClosure below).
// The root project never counts as that bundler: npm also writes `inBundle` for
// the root's own bundleDependencies, but those install from the registry
// (Arborist's `inDepBundle` excludes the root), so a top-level `inBundle` entry
// gets the full rule above, `resolved` included.
// A path whose last segment is empty (`node_modules/`) names no package and
// always fails.
//
// A git or file dependency fails here, before `npm ci` could run its `prepare`.
//
// Usage: node scripts/supply-chain/registry-host.mjs [package-lock.json]
// Exit:  0 clean, 1 offenders found, 2 could not read or parse the lockfile.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expectedTarballUrl, isPublicRegistryUrl, listPackages } from "./lockfile.mjs";

function parentPathOf(path, pathName) {
  return path.slice(0, path.length - "node_modules/".length - pathName.length).replace(/\/$/, "");
}

function declaresBundled(lock, parentPath, pathName) {
  if (!Object.hasOwn(lock.packages, parentPath)) return false;
  const parent = lock.packages[parentPath];
  const declared = parent.bundleDependencies ?? parent.bundledDependencies;
  return declared === true || (Array.isArray(declared) && declared.includes(pathName));
}

// npm also marks as `inBundle` the dependencies OF a bundled dependency (aws-cdk-lib
// bundles `minimatch`, whose `brace-expansion` and `balanced-match` land under
// `node_modules/aws-cdk-lib/` with `inBundle: true` although aws-cdk-lib's own
// list does not name them). Every byte under a bundle root comes from that
// root's tarball, which is itself registry-pinned and integrity-checked by the
// rule above, but only for the packages that tarball actually ships. So a
// transitive `inBundle` entry is accepted only if its path is in the dependency
// closure of the bundle root's declared `bundleDependencies`: start at each
// declared name under the root, follow `dependencies` and `optionalDependencies`
// through the lockfile entries nested under the root (Node resolution: the
// requiring package's own `node_modules`, then each ancestor up to and including
// the root's, never above it). An undeclared sibling, an entry under another
// bundler, or a path that climbs out with `..` is not in the closure. The
// bundle root is the nearest ancestor that is not itself `inBundle`; the root
// project never counts. Without the transitive case, every repo that depends on
// aws-cdk-lib fails here and in flags.mjs (fail closed).

function bundleRootOf(lock, parentPath) {
  let p = parentPath;
  while (p !== "") {
    if (!Object.hasOwn(lock.packages, p)) return null;
    if (lock.packages[p].inBundle !== true) return p;
    const idx = p.lastIndexOf("/node_modules/");
    if (idx === -1) return null; // a top-level inBundle entry: the root project is no bundler
    p = p.slice(0, idx);
  }
  return null;
}

// A dependency name as npm allows it: `pkg` or `@scope/pkg`, no `.`/`..` segment.
function isPlainName(name) {
  const parts = name.split("/");
  if (parts.length === 1) return name !== "" && name !== "." && name !== "..";
  return (
    parts.length === 2 &&
    parts[0].startsWith("@") &&
    parts[0].length > 1 &&
    parts[1] !== "" &&
    parts[1] !== "." &&
    parts[1] !== ".."
  );
}

function depNames(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).filter(isPlainName)
    : [];
}

// The lockfile path `name` resolves to when required from the package at `from`,
// looking only inside the bundle root's subtree.
function resolveWithin(lock, root, from, name) {
  let q = from;
  for (;;) {
    const candidate = `${q}/node_modules/${name}`;
    if (Object.hasOwn(lock.packages, candidate)) return candidate;
    if (q === root) return null;
    const idx = q.lastIndexOf("/node_modules/");
    if (idx === -1) return null;
    q = q.slice(0, idx);
  }
}

function bundleClosure(lock, root) {
  const rootEntry = lock.packages[root];
  const declared = rootEntry.bundleDependencies ?? rootEntry.bundledDependencies;
  let seeds = [];
  if (declared === true) seeds = depNames(rootEntry.dependencies);
  else if (Array.isArray(declared)) {
    seeds = declared.filter((n) => typeof n === "string" && isPlainName(n));
  }
  const closure = new Set();
  const queue = [];
  const visit = (path) => {
    if (path !== null && !closure.has(path)) {
      closure.add(path);
      queue.push(path);
    }
  };
  for (const name of seeds) {
    const path = `${root}/node_modules/${name}`;
    if (Object.hasOwn(lock.packages, path)) visit(path);
  }
  while (queue.length > 0) {
    const from = queue.pop();
    const entry = lock.packages[from];
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of depNames(entry[field])) visit(resolveWithin(lock, root, from, name));
    }
  }
  return closure;
}

function inBundleClosure(lock, cache, path, parentPath) {
  const root = bundleRootOf(lock, parentPath);
  if (root === null) return false;
  let closure = cache.get(root);
  if (closure === undefined) {
    closure = bundleClosure(lock, root);
    cache.set(root, closure);
  }
  return closure.has(path);
}

/**
 * Entries that break the rule above, as `{ path, reason, resolved }[]` with
 * `reason` one of: `resolved-not-public-registry`, `missing-resolved`,
 * `missing-integrity`, `missing-version`, `resolved-mismatch`,
 * `unbundled-inbundle`, `empty-path-name`. Pure: takes the parsed lockfile.
 */
export function findRegistryOffenders(lock) {
  const offenders = [];
  const closures = new Map(); // bundle root path -> Set of paths in its declared closure
  const add = (path, reason, entry) => offenders.push({ path, reason, resolved: entry.resolved });

  for (const { path, pathName, version, entry, isLink } of listPackages(lock)) {
    if (isLink) continue;
    const hasResolved = "resolved" in entry;

    if (hasResolved && !isPublicRegistryUrl(entry.resolved)) {
      add(path, "resolved-not-public-registry", entry);
      continue;
    }
    if (pathName === null) continue; // workspace source directory
    if (pathName === "") {
      add(path, "empty-path-name", entry);
      continue;
    }

    const parentPath = parentPathOf(path, pathName);
    if (entry.inBundle === true && parentPath !== "") {
      if (
        !declaresBundled(lock, parentPath, pathName) &&
        !inBundleClosure(lock, closures, path, parentPath)
      ) {
        add(path, "unbundled-inbundle", entry);
      }
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
