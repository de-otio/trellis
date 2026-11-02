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
import { isPublicRegistryUrl } from "../../../../../scripts/supply-chain/lockfile.mjs";
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
        resolved: "https://registry.example.com/npm/left-pad/-/left-pad-1.3.0.tgz",
      },
    ]);
  });

  it("flags a nested entry, not just top-level ones", () => {
    const nested: [string, Entry] = [
      "node_modules/a/node_modules/b",
      { version: "1.0.0", resolved: "https://registry.example.com/b.tgz" },
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
    const entry: [string, Entry] = ["node_modules/x", { version: "1.0.0", resolved }];
    expect(findRegistryOffenders(lock(entry))).toHaveLength(1);
  });

  it("accepts entries without `resolved` and workspace links", () => {
    const l = lock(
      ["node_modules/@scope/ws", { resolved: "apps/api", link: true }],
      ["apps/api", { name: "@scope/ws", version: "1.0.0" }],
      ["node_modules/bundled", { version: "1.0.0", inBundle: true }],
    );
    expect(findRegistryOffenders(l)).toEqual([]);
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

  it("changedVersions pairs removed with added versions per package", () => {
    const base = lock(pkg("a", "1.0.0"), pkg("b", "1.0.0"));
    const head = lock(pkg("a", "1.2.0"), pkg("b", "1.0.0"));
    expect(changedVersions(base, head)).toEqual([
      { name: "a", removed: ["1.0.0"], added: ["1.2.0"] },
    ]);
  });
});

describe("fetchVersionMeta (the network edge, with fetch injected)", () => {
  const ok = (body: unknown) => ({ status: 200, ok: true, json: async () => body });

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
  it("reports both reasons, sorted, in the contract shape", async () => {
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
      { package: "z@1.1.0", reason: "provenance-dropped" },
    ]);
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
      flags: [{ package: "shiny@2.0.0", reason: "new-install-script" }],
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
        { version: "1.0.0", resolved: "https://registry.example.com/x.tgz" },
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
