/**
 * Unit tests: scripts/supply-chain/*.mjs
 *
 * Each check is asserted from both sides against a few-line lockfile fixture:
 * the old violation it must catch, and the benign neighbour it must leave
 * alone. The violations are the real ones the checks exist for (a private
 * registry host baked into a lockfile, a dependency that grows an install
 * script, a package that stops publishing provenance), reduced to the entries
 * that carry the shape. The network is never touched: the provenance core takes
 * its registry lookup as an argument and the CLI tests use inputs that need no
 * lookup.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error — .mjs scripts, deliberately untyped (same pattern as check-gate-polarity.test.ts).
import { fetchVersionMeta } from "../../../../../scripts/supply-chain/fetch-registry.mjs";
// @ts-expect-error — .mjs script
import { computeFlags } from "../../../../../scripts/supply-chain/flags.mjs";
// @ts-expect-error — .mjs script
import { findNewInstallScripts } from "../../../../../scripts/supply-chain/install-scripts.mjs";
// @ts-expect-error — .mjs script
import {
  isPublicRegistryUrl,
  listPackages,
} from "../../../../../scripts/supply-chain/lockfile.mjs";
// @ts-expect-error — .mjs script
import { findNewPackages } from "../../../../../scripts/supply-chain/new-packages.mjs";
// @ts-expect-error — .mjs script
import { findForbiddenNpmConfig } from "../../../../../scripts/supply-chain/npm-config.mjs";
// @ts-expect-error — .mjs script
import * as provenance from "../../../../../scripts/supply-chain/provenance.mjs";
// @ts-expect-error — .mjs script
import { findRegistryOffenders } from "../../../../../scripts/supply-chain/registry-host.mjs";

const { changedVersions, findProvenanceDrops, hasProvenance } = provenance;

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../..");
const SCRIPTS = resolve(REPO_ROOT, "scripts/supply-chain");

type Entry = Record<string, unknown>;
type Lock = { lockfileVersion: number; packages: Record<string, Entry> };

const NPM = "https://registry.npmjs.org";
const tarball = (name: string, version: string) =>
  `${NPM}/${name}/-/${name.split("/").pop()}-${version}.tgz`;

/** A registry-sourced entry; `extra` adds fields such as hasInstallScript. */
const pkg = (name: string, version: string, extra: Entry = {}): [string, Entry] => [
  `node_modules/${name}`,
  { version, resolved: tarball(name, version), integrity: "sha512-x", ...extra },
];

const lock = (...entries: [string, Entry][]): Lock => ({
  lockfileVersion: 3,
  packages: { "": { name: "root", workspaces: ["apps/*"] }, ...Object.fromEntries(entries) },
});

// ───────────────────────────────────────────────────────────────────────────
// registry-host
// ───────────────────────────────────────────────────────────────────────────
describe("registry-host", () => {
  it("passes a lockfile that resolves only from the public registry", () => {
    expect(findRegistryOffenders(lock(pkg("left-pad", "1.3.0"), pkg("@s/a", "2.0.0")))).toEqual([]);
  });

  it("flags a private registry host baked into one entry (the CodeArtifact leak)", () => {
    const bad: [string, Entry] = [
      "node_modules/left-pad",
      {
        version: "1.3.0",
        resolved: "https://registry.example.com/npm/left-pad/-/left-pad-1.3.0.tgz",
        integrity: "sha512-x",
      },
    ];
    expect(findRegistryOffenders(lock(pkg("ok", "1.0.0"), bad))).toEqual([
      {
        path: "node_modules/left-pad",
        reason: "resolved-not-public-registry",
        resolved: "https://registry.example.com/npm/left-pad/-/left-pad-1.3.0.tgz",
      },
    ]);
  });

  it("flags a nested entry, not just top-level ones", () => {
    const nested: [string, Entry] = [
      "node_modules/a/node_modules/b",
      { version: "1.0.0", resolved: "https://registry.example.com/b.tgz", integrity: "sha512-x" },
    ];
    expect(
      findRegistryOffenders(lock(pkg("a", "1.0.0"), nested)).map((o: { path: string }) => o.path),
    ).toEqual(["node_modules/a/node_modules/b"]);
  });

  it.each([
    ["plain http", "http://registry.npmjs.org/x/-/x-1.0.0.tgz"],
    ["lookalike host sharing the prefix text", "https://registry.npmjs.org.evil.example/x.tgz"],
    [
      "embedded credentials",
      "https://registry.npmjs.org/@evil.example/x.tgz".replace("https://", "https://user:pw@"),
    ],
    ["explicit port", "https://registry.npmjs.org:8443/x.tgz"],
    ["git url", "git+ssh://git@example.com/x.git#abc"],
    ["file url", "file:../x"],
    ["empty string", ""],
    ["non-string", 42],
  ])("flags %s", (_label, resolved) => {
    const entry: [string, Entry] = [
      "node_modules/x",
      { version: "1.0.0", resolved, integrity: "sha512-x" },
    ];
    expect(findRegistryOffenders(lock(entry))).toHaveLength(1);
  });

  it("accepts workspace links and workspace source directories", () => {
    const l = lock(
      ["node_modules/@scope/ws", { resolved: "apps/api", link: true }],
      ["apps/api", { name: "@scope/ws", version: "1.0.0" }],
    );
    expect(findRegistryOffenders(l)).toEqual([]);
  });

  it("flags an installable entry with no `resolved` (npm audit signatures would skip it)", () => {
    const l = lock(["node_modules/evil", { version: "6.6.6", integrity: "sha512-x" }]);
    expect(findRegistryOffenders(l)).toEqual([
      { path: "node_modules/evil", reason: "missing-resolved", resolved: undefined },
    ]);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a string", 7],
  ])("flags an entry whose `integrity` is %s", (_label, integrity) => {
    const e = pkg("a", "1.0.0")[1];
    const l = lock(["node_modules/a", { ...e, integrity }]);
    expect(findRegistryOffenders(l).map((o: { reason: string }) => o.reason)).toEqual([
      "missing-integrity",
    ]);
  });

  it("flags a `name` that spoofs another package's identity (path vs name)", () => {
    // Path says evil, `name` says esbuild, tarball is evil's: identity theft.
    const spoof: [string, Entry] = [
      "node_modules/evil",
      {
        name: "esbuild",
        version: "6.6.6",
        resolved: tarball("evil", "6.6.6"),
        integrity: "sha512-x",
      },
    ];
    expect(findRegistryOffenders(lock(spoof)).map((o: { reason: string }) => o.reason)).toEqual([
      "resolved-mismatch",
    ]);
  });

  it("flags a path that points at a different package's tarball, and a wrong version", () => {
    const wrongPackage: [string, Entry] = [
      "node_modules/esbuild",
      { version: "0.28.2", resolved: tarball("evil", "0.28.2"), integrity: "sha512-x" },
    ];
    const wrongVersion: [string, Entry] = [
      "node_modules/@s/a",
      { version: "2.0.0", resolved: tarball("@s/a", "2.0.1"), integrity: "sha512-x" },
    ];
    expect(findRegistryOffenders(lock(wrongPackage, wrongVersion))).toHaveLength(2);
  });

  it("derives the expected name from the LAST node_modules segment, scoped names included", () => {
    const l = lock(
      pkg("a", "1.0.0"),
      ["node_modules/a/node_modules/@s/b", pkg("@s/b", "2.0.0")[1]],
      ["node_modules/a/node_modules/c", pkg("c", "3.0.0")[1]],
    );
    expect(findRegistryOffenders(l)).toEqual([]);
  });

  it("accepts a real `npm:` alias (resolved agrees with entry.name) but not a half-spoofed one", () => {
    const alias: [string, Entry] = [
      "node_modules/alias",
      {
        name: "real-pkg",
        version: "1.0.0",
        resolved: tarball("real-pkg", "1.0.0"),
        integrity: "sha512-x",
      },
    ];
    expect(findRegistryOffenders(lock(alias))).toEqual([]);
    const halfSpoofed: [string, Entry] = [
      "node_modules/alias",
      {
        name: "real-pkg",
        version: "1.0.0",
        resolved: tarball("alias", "1.0.0"),
        integrity: "sha512-x",
      },
    ];
    expect(findRegistryOffenders(lock(halfSpoofed))).toHaveLength(1);
  });

  it("accepts an inBundle entry only when its parent declares it bundled", () => {
    const bundled: [string, Entry] = [
      "node_modules/host/node_modules/inner",
      { version: "1.0.0", inBundle: true },
    ];
    const declared = lock(
      ["node_modules/host", { ...pkg("host", "1.0.0")[1], bundleDependencies: ["inner"] }],
      bundled,
    );
    expect(findRegistryOffenders(declared)).toEqual([]);
    const undeclared = lock(pkg("host", "1.0.0"), bundled);
    expect(findRegistryOffenders(undeclared).map((o: { reason: string }) => o.reason)).toEqual([
      "unbundled-inbundle",
    ]);
    const forged = lock(["node_modules/evil", { version: "6.6.6", inBundle: true }]);
    expect(findRegistryOffenders(forged)).toHaveLength(1);
  });

  // npm also marks as inBundle the dependencies OF a bundled dependency: aws-cdk-lib
  // bundles `minimatch`, whose own dependency is hoisted next to it as
  // node_modules/aws-cdk-lib/node_modules/balanced-match with inBundle and no resolved,
  // although aws-cdk-lib's list does not name it.
  describe("transitive inBundle entries of a registry-pinned bundler", () => {
    const bundlerLock = (...extra: [string, Entry][]): Lock =>
      lock(
        [
          "node_modules/aws-cdk-lib",
          { ...pkg("aws-cdk-lib", "2.0.0")[1], bundleDependencies: ["minimatch"] },
        ],
        ["node_modules/aws-cdk-lib/node_modules/minimatch", { version: "9.0.0", inBundle: true }],
        [
          "node_modules/aws-cdk-lib/node_modules/balanced-match",
          { version: "4.0.4", inBundle: true },
        ],
        [
          "node_modules/aws-cdk-lib/node_modules/minimatch/node_modules/brace-expansion",
          { version: "2.0.0", inBundle: true },
        ],
        ...extra,
      );
    const reasons = (l: Lock) => findRegistryOffenders(l).map((o: { reason: string }) => o.reason);

    it("accepts them (the aws-cdk-lib shape)", () => {
      expect(findRegistryOffenders(bundlerLock())).toEqual([]);
    });

    it("rejects them when the bundle root declares no bundled dependencies", () => {
      const l = lock(
        pkg("aws-cdk-lib", "2.0.0"),
        [
          "node_modules/aws-cdk-lib/node_modules/balanced-match",
          { version: "4.0.4", inBundle: true },
        ],
        [
          "node_modules/aws-cdk-lib/node_modules/minimatch/node_modules/brace-expansion",
          { version: "2.0.0", inBundle: true },
        ],
      );
      expect(reasons(l)).toEqual(["unbundled-inbundle", "unbundled-inbundle"]);
    });

    it("still gives a top-level inBundle entry the full rule", () => {
      const l = bundlerLock(["node_modules/sneaky", { version: "1.0.0", inBundle: true }]);
      expect(reasons(l)).toEqual(["missing-resolved"]);
    });

    it("still rejects a bundler that is not on the public registry", () => {
      const l = lock(
        [
          "node_modules/aws-cdk-lib",
          {
            ...pkg("aws-cdk-lib", "2.0.0")[1],
            bundleDependencies: ["minimatch"],
            resolved: "https://registry.example.com/aws-cdk-lib/-/aws-cdk-lib-2.0.0.tgz",
          },
        ],
        [
          "node_modules/aws-cdk-lib/node_modules/balanced-match",
          { version: "4.0.4", inBundle: true },
        ],
      );
      expect(reasons(l)).toContain("resolved-not-public-registry");
    });

    it("still rejects a non-bundled entry without resolved next to a bundler", () => {
      const l = bundlerLock(["node_modules/plain", { version: "1.0.0", integrity: "sha512-x" }]);
      expect(reasons(l)).toEqual(["missing-resolved"]);
    });

    it("computeFlags accepts the aws-cdk-lib shape instead of failing closed", async () => {
      const head = bundlerLock();
      await expect(computeFlags(head, head, vi.fn())).resolves.toEqual({ flags: [], notes: [] });
    });
  });

  it("does not let the root's bundleDependencies excuse a top-level entry from the rule", () => {
    const rootBundles = (inner: Entry): Lock => ({
      lockfileVersion: 3,
      packages: {
        "": { name: "root", bundleDependencies: ["inner"] },
        "node_modules/inner": inner,
      },
    });
    // npm writes inBundle for a root-bundled dependency but still pins it to the registry.
    expect(
      findRegistryOffenders(rootBundles({ ...pkg("inner", "1.0.0")[1], inBundle: true })),
    ).toEqual([]);
    expect(
      findRegistryOffenders(rootBundles({ version: "1.0.0", inBundle: true })).map(
        (o: { reason: string }) => o.reason,
      ),
    ).toEqual(["missing-resolved"]);
  });

  it("flags a path that names no package", () => {
    const empty = { version: "1.0.0", resolved: `${NPM}//-/-1.0.0.tgz`, integrity: "sha512-x" };
    const offenders = findRegistryOffenders(
      lock(pkg("a", "1.0.0"), ["node_modules/", empty], ["node_modules/a/node_modules/", empty]),
    );
    expect(offenders.map((o: { path: string; reason: string }) => [o.path, o.reason])).toEqual([
      ["node_modules/", "empty-path-name"],
      ["node_modules/a/node_modules/", "empty-path-name"],
    ]);
  });

  it("refuses a lockfile shape it cannot read instead of passing it", () => {
    expect(() => findRegistryOffenders({ lockfileVersion: 1, dependencies: {} })).toThrow(
      /packages/,
    );
    expect(() => findRegistryOffenders(null)).toThrow();
  });

  it("isPublicRegistryUrl is exact about the origin", () => {
    expect(isPublicRegistryUrl(tarball("x", "1.0.0"))).toBe(true);
    expect(isPublicRegistryUrl("https://registry.npmjs.org")).toBe(false);
  });
});

describe("lockfile identity", () => {
  const nameOf = (l: Lock, path: string) =>
    listPackages(l).find((p: { path: string }) => p.path === path).name;

  it("takes the name from the path when `entry.name` is not corroborated by `resolved`", () => {
    const spoof: [string, Entry] = [
      "node_modules/evil",
      {
        name: "esbuild",
        version: "6.6.6",
        resolved: tarball("evil", "6.6.6"),
        integrity: "sha512-x",
      },
    ];
    expect(nameOf(lock(spoof), "node_modules/evil")).toBe("evil");
  });

  it("takes an alias's real name when `resolved` agrees with it", () => {
    const alias: [string, Entry] = [
      "node_modules/alias",
      {
        name: "real-pkg",
        version: "1.0.0",
        resolved: tarball("real-pkg", "1.0.0"),
        integrity: "sha512-x",
      },
    ];
    expect(nameOf(lock(alias), "node_modules/alias")).toBe("real-pkg");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// install-scripts
// ───────────────────────────────────────────────────────────────────────────
describe("install-scripts", () => {
  it("flags a new package that has an install script", () => {
    const base = lock(pkg("a", "1.0.0"));
    const head = lock(pkg("a", "1.0.0"), pkg("shiny", "2.0.0", { hasInstallScript: true }));
    expect(findNewInstallScripts(base, head)).toEqual(["shiny@2.0.0"]);
  });

  it("flags an existing package that gained an install script", () => {
    const base = lock(pkg("a", "1.0.0"));
    const head = lock(pkg("a", "1.0.1", { hasInstallScript: true }));
    expect(findNewInstallScripts(base, head)).toEqual(["a@1.0.1"]);
  });

  it("does not flag a bump of a package that already had an install script", () => {
    const base = lock(pkg("esbuild", "0.28.2", { hasInstallScript: true }));
    const head = lock(pkg("esbuild", "0.28.3", { hasInstallScript: true }));
    expect(findNewInstallScripts(base, head)).toEqual([]);
  });

  it("does not flag when nothing changed or the script went away", () => {
    const withScript = lock(pkg("a", "1.0.0", { hasInstallScript: true }));
    expect(findNewInstallScripts(withScript, withScript)).toEqual([]);
    expect(findNewInstallScripts(withScript, lock(pkg("a", "1.0.1")))).toEqual([]);
  });

  it("ignores hasInstallScript values other than true", () => {
    const head = lock(
      pkg("a", "1.0.0", { hasInstallScript: "yes" }),
      pkg("b", "1.0.0", { hasInstallScript: false }),
    );
    expect(findNewInstallScripts(lock(), head)).toEqual([]);
  });

  it("treats a nested copy of a known package as known, and a new nested one as new", () => {
    const base = lock(pkg("fsevents", "2.3.2", { hasInstallScript: true }));
    const head = lock(pkg("fsevents", "2.3.2", { hasInstallScript: true }), [
      "node_modules/x/node_modules/fsevents",
      { version: "2.3.3", resolved: tarball("fsevents", "2.3.3"), hasInstallScript: true },
    ]);
    expect(findNewInstallScripts(base, head)).toEqual([]);
    const head2 = lock([
      "node_modules/x/node_modules/other",
      { version: "1.0.0", resolved: tarball("other", "1.0.0"), hasInstallScript: true },
    ]);
    expect(findNewInstallScripts(base, head2)).toEqual(["other@1.0.0"]);
  });

  it("names an aliased package by its real name", () => {
    const head = lock([
      "node_modules/alias",
      {
        name: "real-pkg",
        version: "1.0.0",
        resolved: tarball("real-pkg", "1.0.0"),
        hasInstallScript: true,
      },
    ]);
    expect(findNewInstallScripts(lock(), head)).toEqual(["real-pkg@1.0.0"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// new-packages
// ───────────────────────────────────────────────────────────────────────────
describe("new-packages", () => {
  it("flags a name the base never had, whether or not it has an install script", () => {
    const base = lock(pkg("a", "1.0.0"));
    const head = lock(
      pkg("a", "1.0.0"),
      pkg("flatmap-stream", "0.1.1"),
      pkg("b", "2.0.0", { hasInstallScript: true }),
    );
    expect(findNewPackages(base, head)).toEqual(["b@2.0.0", "flatmap-stream@0.1.1"]);
  });

  it("flags a new nested package, scoped names included", () => {
    const head = lock(pkg("a", "1.0.0"), [
      "node_modules/a/node_modules/@s/b",
      pkg("@s/b", "1.0.0")[1],
    ]);
    expect(findNewPackages(lock(pkg("a", "1.0.0")), head)).toEqual(["@s/b@1.0.0"]);
  });

  it("does not flag a bump, a new nested copy of a known name, or a removal", () => {
    const base = lock(pkg("a", "1.0.0"), pkg("gone", "1.0.0"));
    const head = lock(pkg("a", "1.1.0"), ["node_modules/x/node_modules/a", pkg("a", "2.0.0")[1]]);
    expect(findNewPackages(base, head)).toEqual([]);
  });

  it("does not report workspace links", () => {
    const head = lock(["node_modules/@scope/ws", { resolved: "apps/api", link: true }]);
    expect(findNewPackages(lock(), head)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// npm-config
// ───────────────────────────────────────────────────────────────────────────
describe("npm-config", () => {
  it("flags a tracked .npmrc or npm-shrinkwrap.json at any depth", () => {
    expect(
      findForbiddenNpmConfig([
        "package.json",
        ".npmrc",
        "apps/api/.npmrc",
        "packages/x/npm-shrinkwrap.json",
        "apps/api/src/index.ts",
      ]),
    ).toEqual([".npmrc", "apps/api/.npmrc", "packages/x/npm-shrinkwrap.json"]);
  });

  it("leaves lookalikes alone", () => {
    expect(
      findForbiddenNpmConfig([
        "package-lock.json",
        "docs/npmrc.md",
        "x.npmrc",
        "my.npm-shrinkwrap.json",
      ]),
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// provenance
// ───────────────────────────────────────────────────────────────────────────
const attested = {
  dist: {
    attestations: { url: "u", provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
  },
};
const plain = { dist: { tarball: "t", signatures: [] } };
const publishOnly = { dist: { attestations: { url: "u" } } };

/** A fetcher over a fixed table; any lookup not in the table fails the test. */
const table = (rows: Record<string, unknown>) =>
  vi.fn(async (name: string, version: string) => {
    const key = `${name}@${version}`;
    if (!(key in rows)) throw new Error(`unexpected lookup ${key}`);
    return rows[key];
  });

describe("provenance", () => {
  it("hasProvenance needs the provenance predicate, not just an attestations URL", () => {
    expect(hasProvenance(attested)).toBe(true);
    expect(hasProvenance(plain)).toBe(false);
    expect(hasProvenance(publishOnly)).toBe(false);
    expect(hasProvenance(null)).toBe(false);
    expect(hasProvenance({ dist: { attestations: { provenance: {} } } })).toBe(false);
  });

  it("flags a bump from an attested version to an unattested one", async () => {
    const base = lock(pkg("a", "1.0.0"));
    const head = lock(pkg("a", "1.1.0"));
    const fetchMeta = table({ "a@1.0.0": attested, "a@1.1.0": plain });
    expect(await findProvenanceDrops(base, head, fetchMeta)).toEqual([
      { name: "a", version: "1.1.0", replaced: ["1.0.0"] },
    ]);
  });

  it("does not flag when the new version keeps provenance", async () => {
    const fetchMeta = table({ "a@1.0.0": attested, "a@1.1.0": attested });
    expect(
      await findProvenanceDrops(lock(pkg("a", "1.0.0")), lock(pkg("a", "1.1.0")), fetchMeta),
    ).toEqual([]);
  });

  it("does not flag when the old version never had provenance, and skips the second lookup", async () => {
    const fetchMeta = table({ "a@1.0.0": plain });
    expect(
      await findProvenanceDrops(lock(pkg("a", "1.0.0")), lock(pkg("a", "1.1.0")), fetchMeta),
    ).toEqual([]);
    expect(fetchMeta).toHaveBeenCalledTimes(1);
  });

  it("does not flag gaining provenance, and a missing old version is not evidence", async () => {
    expect(
      await findProvenanceDrops(
        lock(pkg("a", "1.0.0")),
        lock(pkg("a", "1.1.0")),
        table({ "a@1.0.0": plain, "a@1.1.0": attested }),
      ),
    ).toEqual([]);
    expect(
      await findProvenanceDrops(
        lock(pkg("a", "1.0.0")),
        lock(pkg("a", "1.1.0")),
        table({ "a@1.0.0": null }),
      ),
    ).toEqual([]);
  });

  it("a new version the registry does not know counts as no provenance", async () => {
    const fetchMeta = table({ "a@1.0.0": attested, "a@1.1.0": null });
    expect(
      await findProvenanceDrops(lock(pkg("a", "1.0.0")), lock(pkg("a", "1.1.0")), fetchMeta),
    ).toHaveLength(1);
  });

  it("makes no lookups for unchanged, brand-new, removed or non-registry packages", async () => {
    const fetchMeta = table({});
    const base = lock(pkg("same", "1.0.0"), pkg("gone", "1.0.0"));
    const head = lock(pkg("same", "1.0.0"), pkg("fresh", "1.0.0"), [
      "node_modules/gone",
      { version: "2.0.0", resolved: "https://registry.example.com/gone.tgz" },
    ]);
    expect(await findProvenanceDrops(base, head, fetchMeta)).toEqual([]);
    expect(fetchMeta).not.toHaveBeenCalled();
  });

  it("propagates a lookup failure instead of reading it as 'no flags'", async () => {
    const fetchMeta = vi.fn(async () => {
      throw new Error("registry down");
    });
    await expect(
      findProvenanceDrops(lock(pkg("a", "1.0.0")), lock(pkg("a", "1.1.0")), fetchMeta),
    ).rejects.toThrow(/registry down/);
  });

  it("changedVersions pairs the base's versions with the added ones per package", () => {
    const base = lock(pkg("a", "1.0.0"), pkg("b", "1.0.0"));
    const head = lock(pkg("a", "1.2.0"), pkg("b", "1.0.0"));
    expect(changedVersions(base, head)).toEqual([
      { name: "a", baseVersions: ["1.0.0"], added: ["1.2.0"] },
    ]);
  });

  it("checks a version ADDED NEXT TO an unchanged one (a new nested copy), against all base versions", async () => {
    // base: foo@1.0.0 attested. head keeps it and adds a nested foo@2.0.0 with no provenance.
    const base = lock(pkg("foo", "1.0.0"));
    const head = lock(pkg("foo", "1.0.0"), [
      "node_modules/bar/node_modules/foo",
      pkg("foo", "2.0.0")[1],
    ]);
    const fetchMeta = table({ "foo@1.0.0": attested, "foo@2.0.0": plain });
    expect(await findProvenanceDrops(base, head, fetchMeta)).toEqual([
      { name: "foo", version: "2.0.0", replaced: ["1.0.0"] },
    ]);
  });

  it("uses ANY base version of the name as the attested reference", async () => {
    const base = lock(pkg("foo", "1.0.0"), [
      "node_modules/x/node_modules/foo",
      pkg("foo", "0.9.0")[1],
    ]);
    const head = lock(
      pkg("foo", "1.0.0"),
      ["node_modules/x/node_modules/foo", pkg("foo", "0.9.0")[1]],
      ["node_modules/y/node_modules/foo", pkg("foo", "3.0.0")[1]],
    );
    const fetchMeta = table({ "foo@0.9.0": plain, "foo@1.0.0": attested, "foo@3.0.0": plain });
    expect(await findProvenanceDrops(base, head, fetchMeta)).toHaveLength(1);
  });

  it("checks a bundled copy of a known name, and leaves an unchanged bundled copy alone", async () => {
    const host = (bundled: string): [string, Entry] => [
      "node_modules/host/node_modules/foo",
      { version: bundled, inBundle: true },
    ];
    const base = lock(pkg("foo", "1.0.0"), pkg("host", "1.0.0"), host("1.0.0"));
    const fetchMeta = table({ "foo@1.0.0": attested, "foo@6.6.6": plain });
    expect(
      await findProvenanceDrops(
        base,
        lock(pkg("foo", "1.0.0"), pkg("host", "1.0.0"), host("6.6.6")),
        fetchMeta,
      ),
    ).toEqual([{ name: "foo", version: "6.6.6", replaced: ["1.0.0"] }]);
    const unchanged = table({});
    expect(await findProvenanceDrops(base, base, unchanged)).toEqual([]);
    expect(unchanged).not.toHaveBeenCalled();
  });
});

describe("fetchVersionMeta (the network edge, with fetch injected)", () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) => ({
    status: 200,
    ok: true,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });

  it("rejects a response whose content-length is over the cap, without retrying", async () => {
    const f = vi.fn(async () => ok({ name: "x" }, { "content-length": String(11 * 1024 * 1024) }));
    await expect(fetchVersionMeta("a", "1.0.0", f)).rejects.toThrow(/too large/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("stops reading a streamed body that grows past the cap, without retrying", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const cancel = vi.fn(async () => undefined);
    const body = {
      getReader: () => ({ read: async () => ({ done: false, value: chunk }), cancel }),
    };
    const f = vi.fn(async () => ({ status: 200, ok: true, headers: { get: () => null }, body }));
    await expect(fetchVersionMeta("a", "1.0.0", f)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("accepts a legacy upper-case package name", async () => {
    const f = vi.fn(async () => ok({ name: "JSONStream" }));
    await expect(fetchVersionMeta("JSONStream", "1.3.5", f)).resolves.toEqual({
      name: "JSONStream",
    });
  });

  it("requests the fixed registry host with an encoded scoped name and refuses redirects", async () => {
    const f = vi.fn(async () => ok({ name: "x" }));
    await fetchVersionMeta("@scope/name", "1.0.0-rc.1+b", f);
    const [url, init] = f.mock.calls[0] as unknown as [string, { redirect: string }];
    expect(url).toBe("https://registry.npmjs.org/@scope%2Fname/1.0.0-rc.1%2Bb");
    expect(init.redirect).toBe("error");
  });

  it("returns null on 404 without retrying", async () => {
    const f = vi.fn(async () => ({ status: 404, ok: false, json: async () => ({}) }));
    expect(await fetchVersionMeta("a", "1.0.0", f)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["path traversal in the name", "../../etc", "1.0.0"],
    ["slash-laden name", "a/b/c", "1.0.0"],
    ["url-ish name", "a?b=c", "1.0.0"],
    ["odd version", "a", "1.0.0/../x"],
  ])("rejects %s before any request", async (_l, name, version) => {
    const f = vi.fn();
    await expect(fetchVersionMeta(name, version, f)).rejects.toThrow(/refusing/);
    expect(f).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// flags (combined)
// ───────────────────────────────────────────────────────────────────────────
describe("computeFlags", () => {
  it("reports all three reasons, sorted, in the contract shape", async () => {
    const base = lock(pkg("z", "1.0.0"), pkg("a", "1.0.0"));
    const head = lock(
      pkg("z", "1.1.0"),
      pkg("a", "1.0.0"),
      pkg("m", "1.0.0", { hasInstallScript: true }),
    );
    const { flags } = await computeFlags(
      base,
      head,
      table({ "z@1.0.0": attested, "z@1.1.0": plain }),
    );
    expect(flags).toEqual([
      { package: "m@1.0.0", reason: "new-install-script" },
      { package: "m@1.0.0", reason: "new-package" },
      { package: "z@1.1.0", reason: "provenance-dropped" },
    ]);
  });

  it("flags a brand-new transitive package with no install script and no provenance (event-stream shape)", async () => {
    const base = lock(pkg("a", "1.0.0"));
    const head = lock(pkg("a", "1.0.1"), pkg("flatmap-stream", "0.1.1"));
    const { flags } = await computeFlags(
      base,
      head,
      table({ "a@1.0.0": plain }), // nothing attested: provenance has nothing to compare
    );
    expect(flags).toEqual([{ package: "flatmap-stream@0.1.1", reason: "new-package" }]);
  });

  it("refuses to compute flags for a head lockfile that breaks the registry rule", async () => {
    const spoof: [string, Entry] = [
      "node_modules/evil",
      {
        name: "esbuild",
        version: "6.6.6",
        resolved: tarball("evil", "6.6.6"),
        integrity: "sha512-x",
      },
    ];
    await expect(
      computeFlags(lock(pkg("a", "1.0.0")), lock(pkg("a", "1.0.0"), spoof), table({})),
    ).rejects.toThrow(/registry-host rule/);
  });

  it("reports nothing for a clean bump", async () => {
    const { flags } = await computeFlags(
      lock(pkg("a", "1.0.0")),
      lock(pkg("a", "1.0.1")),
      table({ "a@1.0.0": attested, "a@1.0.1": attested }),
    );
    expect(flags).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CLI contracts (child processes; no network is reachable from these inputs)
// ───────────────────────────────────────────────────────────────────────────
describe("CLIs", () => {
  const dir = mkdtempSync(join(tmpdir(), "supply-chain-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
    return p;
  };
  const run = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("flags.mjs prints {flags:[...]} on stdout and exits 0 even when it flags", () => {
    const base = write("base.json", lock(pkg("a", "1.0.0")));
    const head = write(
      "head.json",
      lock(pkg("a", "1.0.0"), pkg("shiny", "2.0.0", { hasInstallScript: true })),
    );
    const r = run("flags.mjs", base, head);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      flags: [
        { package: "shiny@2.0.0", reason: "new-install-script" },
        { package: "shiny@2.0.0", reason: "new-package" },
      ],
    });
  });

  it("flags.mjs prints an empty list and exits 0 when clean", () => {
    const same = write("same.json", lock(pkg("a", "1.0.0")));
    const r = run("flags.mjs", same, same);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ flags: [] });
  });

  it("flags.mjs exits non-zero, with nothing on stdout, on its own errors", () => {
    const good = write("good.json", lock(pkg("a", "1.0.0")));
    const junk = write("junk.json", "not json");
    for (const args of [[good], [good, junk], [good, join(dir, "missing.json")]]) {
      const r = run("flags.mjs", ...args);
      expect(r.code).not.toBe(0);
      expect(r.out).toBe("");
    }
  });

  it("registry-host.mjs exits 1 on a wrong host, 0 on a clean lockfile, 2 on unreadable input", () => {
    const bad = write(
      "bad.json",
      lock([
        "node_modules/x",
        { version: "1.0.0", resolved: "https://registry.example.com/x.tgz", integrity: "sha512-x" },
      ]),
    );
    const good = write("clean.json", lock(pkg("x", "1.0.0")));
    const rBad = run("registry-host.mjs", bad);
    expect(rBad.code).toBe(1);
    expect(rBad.out).toContain("node_modules/x");
    expect(run("registry-host.mjs", good).code).toBe(0);
    expect(run("registry-host.mjs", join(dir, "missing.json")).code).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The real lockfile on this checkout
// ───────────────────────────────────────────────────────────────────────────
describe("this repository's package-lock.json", () => {
  it("passes registry-host", () => {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, "registry-host.mjs"), join(REPO_ROOT, "package-lock.json")],
      {
        encoding: "utf8",
      },
    );
    expect(r.stdout).not.toMatch(/resolved=/);
    expect(r.status).toBe(0);
  });
});
