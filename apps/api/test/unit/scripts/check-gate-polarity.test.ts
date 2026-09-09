/**
 * Unit tests: scripts/check-gate-polarity.mjs
 *
 * A checker nobody has watched fail is not a checker. Each rule is asserted
 * from both sides against an inline fixture: the shape it must flag, and the
 * fixed shape it must leave alone. The fixtures are the nine real instances the
 * sweep found, reduced to the few lines that carry the pattern — so if a rule
 * is ever loosened, the assertion that goes red names the gate it stops
 * catching.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs check script, deliberately untyped (see
// scripts/migration-lint-scope.mjs and its test for the same pattern).
import { analyzeSource, scanTree, VOCABULARIES } from "../../../../../scripts/check-gate-polarity.mjs";

// The repo root, derived from this file rather than from `process.cwd()` — the
// scan roots have to resolve the same way whichever directory vitest ran from.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../..");
const SCAN_ROOTS = [
  resolve(REPO_ROOT, "apps/api/src"),
  resolve(REPO_ROOT, "apps/worker/src"),
];

interface Finding {
  rule: string;
  file: string;
  line: number;
  text: string;
  why: string;
}

const rulesFor = (src: string): string[] =>
  (analyzeSource("fixture.ts", src) as Finding[]).map((f) => f.rule);

const clean = (src: string) => expect(rulesFor(src)).toEqual([]);

describe("R1 — permissive default", () => {
  it("flags an age tier defaulting to ADULT", () => {
    expect(rulesFor(`  return sessionAgeTier ?? "ADULT";`)).toEqual(["R1"]);
  });

  it("flags it through a cast, which is how the session-cookie instance read", () => {
    expect(
      rulesFor(`  ageTier: (claimsRecord["custom:ageTier"] as AgeTier) || "ADULT",`),
    ).toEqual(["R1"]);
  });

  it("flags a scope set defaulting to the wildcard", () => {
    expect(rulesFor(`  const granted: ScopeSet = ctx.scopes ?? "*";`)).toEqual(["R1"]);
  });

  it("flags a gate-shaped boolean defaulting to true", () => {
    expect(rulesFor(`  return toggle?.canPost ?? true;`)).toEqual(["R1"]);
  });

  it("passes the fixed forms", () => {
    clean(`  if (isKnownAgeTier(sessionAgeTier)) return sessionAgeTier;`);
    clean(
      `  const granted: ScopeSet = ctx.scopes ?? (ctx.clientId === undefined ? "*" : new Set<string>());`,
    );
  });

  it("does not flag an ordinary nullable field", () => {
    clean(`  const displayName = user.displayName ?? null;`);
    clean(`  const label = input.label ?? "";`);
  });

  it("respects a signed allow marker on the line and on the line above", () => {
    clean(`  return toggle?.enabled ?? true; // gate-polarity-ok: ON is closed`);
    clean(
      [
        `  // gate-polarity-ok: ON means moderate, the restrictive answer`,
        `  return toggle?.enabled ?? true;`,
      ].join("\n"),
    );
  });

  it("rejects a marker with no reason after the colon", () => {
    expect(rulesFor(`  return toggle?.enabled ?? true; // gate-polarity-ok:`)).toEqual([
      "R1",
    ]);
  });

  it("does not accept a marker two lines above the finding", () => {
    // A reason further up is prose about the code, not a signature on the line.
    expect(
      rulesFor(
        [
          `  // gate-polarity-ok: ON means moderate`,
          `  const toggle = await this.getToggle(key);`,
          `  return toggle?.enabled ?? true;`,
        ].join("\n"),
      ),
    ).toEqual(["R1"]);
  });
});

describe("R2 — switch without default", () => {
  const tierSwitch = (withDefault: boolean) =>
    [
      `export function getPaginationConfig(ageTier: AgeTier): PaginationConfig {`,
      `  switch (ageTier) {`,
      `    case "CHILD":`,
      `      return { maxPages: 5 };`,
      `    case "ADULT":`,
      `      return { maxPages: null };`,
      ...(withDefault ? [`    default:`, `      return { maxPages: 5 };`] : []),
      `  }`,
      `}`,
    ].join("\n");

  it("flags a tier switch that falls through to undefined", () => {
    expect(rulesFor(tierSwitch(false))).toEqual(["R2"]);
  });

  it("passes once a default: arm exists", () => {
    clean(tierSwitch(true));
  });

  it("reports the switch line, not the function line", () => {
    const [finding] = analyzeSource("fixture.ts", tierSwitch(false)) as Finding[];
    expect(finding.line).toBe(2);
    expect(finding.text).toContain("switch (ageTier)");
  });

  it("ignores a switch on a discriminant that is not gate-shaped", () => {
    clean(
      [
        `  switch (mediaKind) {`,
        `    case "image":`,
        `      return 1;`,
        `  }`,
      ].join("\n"),
    );
  });
});

describe("R3 — deny-only comparison", () => {
  it("flags a predicate that only refuses the strictest value", () => {
    expect(rulesFor(`  return blockClass !== "illegal-suspected";`)).toEqual(["R3"]);
  });

  it("passes an affirmative comparison", () => {
    clean(`  return blockClass === "lawful-flagged";`);
  });
});

describe("R4 — strict-literal guard on a denial", () => {
  const guard = (comparison: string) =>
    [
      `      if (!session && authLevel ${comparison}) {`,
      `        return securityHeaders.createSecureResponse(`,
      `          JSON.stringify({ error: "Unauthorized" }),`,
      `          { status: 401 },`,
      `        );`,
      `      }`,
    ].join("\n");

  it("flags a 401 keyed on the strictest literal alone", () => {
    expect(rulesFor(guard(`=== "required"`))).toEqual(["R4"]);
  });

  it("passes the inverted guard, which refuses everything not explicitly optional", () => {
    clean(guard(`!== "optional"`));
  });

  it("does not flag a guard whose body restricts rather than denies", () => {
    // Correct polarity: the strictest tier is the one that gets *narrowed*.
    clean(
      [`  if (ageTier === "CHILD") {`, `    hideSentimentCounts();`, `  }`].join("\n"),
    );
  });
});

describe("R5 — gate under a truthiness test", () => {
  it("flags a scope gate that only runs when a declaration is present", () => {
    expect(
      rulesFor(
        [
          `      if (routeDef.scopes && routeDef.scopes.length) {`,
          `        requireScope(session, routeDef.scopes);`,
          `      }`,
        ].join("\n"),
      ),
    ).toEqual(["R5"]);
  });

  it("passes a gate whose branches are all decided by a comparison", () => {
    clean(
      [
        `      if (routeDef.scopes === undefined) {`,
        `        requireFirstParty(session);`,
        `      } else {`,
        `        requireScope(session, routeDef.scopes);`,
        `      }`,
      ].join("\n"),
    );
  });
});

describe("the registry", () => {
  it("orders every vocabulary least-permissive first and marks a permissive set", () => {
    for (const vocab of VOCABULARIES as Array<{
      name: string;
      values: string[];
      permissive: string[];
      strictest: string | null;
    }>) {
      expect(vocab.permissive.length).toBeGreaterThan(0);
      if (vocab.strictest !== null) {
        expect(vocab.values[0]).toBe(vocab.strictest);
        // The strictest value is never itself a permissive one.
        expect(vocab.permissive).not.toContain(vocab.strictest);
      }
    }
  });
});

describe("the tree scan", () => {
  it("finds no fail-open gate anywhere in apps/api/src or apps/worker/src", () => {
    // The repo-wide assertion. It is the same call `npm run lint` makes, so a
    // regression fails here too — under a test name that says what broke.
    const { files, findings } = scanTree(SCAN_ROOTS) as {
      files: string[];
      findings: Finding[];
    };
    expect(files.length).toBeGreaterThan(100);
    expect(
      findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.why}`),
    ).toEqual([]);
  });
});
