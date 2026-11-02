#!/usr/bin/env node
// Fail when the repository tracks a file that changes what npm does.
//
// A pull request that adds `.npmrc` (`registry=…`, `@scope:registry=…`,
// `ignore-scripts=false`) or `npm-shrinkwrap.json` (which npm prefers over
// package-lock.json) changes how `npm ci` and `npm audit signatures` behave in
// the very job that is meant to vet the lockfile. The job pins the registry
// through `NPM_CONFIG_REGISTRY`, which beats a project `.npmrc`, but scoped
// registries and other settings would still get through, so the files are
// refused outright wherever they sit in the tree.
//
// Usage: node scripts/supply-chain/npm-config.mjs
// Exit:  0 none tracked, 1 found, 2 could not list files.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FORBIDDEN = new Set([".npmrc", "npm-shrinkwrap.json"]);

/** Tracked paths whose basename is a forbidden npm config file, at any depth. Pure. */
export function findForbiddenNpmConfig(files) {
  return files.filter((f) => FORBIDDEN.has(f.slice(f.lastIndexOf("/") + 1)));
}

function main() {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  } catch (err) {
    console.error(`npm-config: cannot list tracked files: ${err.message}`);
    return 2;
  }
  const found = findForbiddenNpmConfig(files);
  for (const f of found) console.log(f);
  if (found.length > 0) {
    console.log(
      "\nnpm-config: tracked npm config files are not allowed (.npmrc, npm-shrinkwrap.json): " +
        "they change what `npm ci` and `npm audit signatures` do.",
    );
    return 1;
  }
  console.log("npm-config: no .npmrc or npm-shrinkwrap.json is tracked.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
