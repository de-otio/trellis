import { describe, expect, it } from "vitest";
import {
  caretRangeAdmits,
  checkConsumerRanges,
  compareAllVersions,
  compareVersions,
  extractDocVersion,
  extractPackageVersion,
  extractVersionConst,
} from "../../../scripts/lib/extension-version-check.mjs";

describe("extractVersionConst", () => {
  it("extracts the version from the canonical declaration shape", () => {
    const source = `
      export interface Foo {}
      export const EXTENSION_API_VERSION = "0.8.0" as const;
    `;
    expect(extractVersionConst(source)).toBe("0.8.0");
  });

  it("accepts single quotes and no trailing 'as const'", () => {
    const source = `export const EXTENSION_API_VERSION = '1.2.3';`;
    expect(extractVersionConst(source)).toBe("1.2.3");
  });

  it("throws when the declaration is absent", () => {
    const source = `export const SOMETHING_ELSE = "0.8.0";`;
    expect(() => extractVersionConst(source)).toThrow(/no.*declaration found/i);
  });

  it("throws when there is more than one declaration (ambiguity)", () => {
    const source = `
      export const EXTENSION_API_VERSION = "0.8.0";
      export const EXTENSION_API_VERSION = "0.9.0";
    `;
    expect(() => extractVersionConst(source)).toThrow(/found 2/i);
  });

  it("does not match a similarly-named but different const (anchored)", () => {
    const source = `export const MY_EXTENSION_API_VERSION_TWO = "0.8.0";`;
    expect(() => extractVersionConst(source)).toThrow(/no.*declaration found/i);
  });
});

describe("extractPackageVersion", () => {
  it("extracts version from a parsed package.json object", () => {
    expect(extractPackageVersion({ version: "0.8.0", name: "x" })).toBe("0.8.0");
  });

  it("throws when version is missing", () => {
    expect(() => extractPackageVersion({ name: "x" })).toThrow(/no string/i);
  });

  it("throws when version is not a string", () => {
    expect(() => extractPackageVersion({ version: 8 })).toThrow(/no string/i);
  });

  it("throws for null input", () => {
    expect(() => extractPackageVersion(null)).toThrow(/no string/i);
  });
});

describe("compareVersions", () => {
  it("reports ok when versions match", () => {
    const result = compareVersions("0.8.0", "0.8.0");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/matches/);
  });

  it("reports mismatch with both values named", () => {
    const result = compareVersions("0.8.0", "0.7.0");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("0.8.0");
    expect(result.message).toContain("0.7.0");
  });
});

describe("extractDocVersion", () => {
  it("extracts the version from the canonical callout shape", () => {
    const doc = [
      "# Extension API",
      "",
      "> **Current version: `0.9.0`.** This line is checked in CI.",
      "",
      "## Install",
    ].join("\n");
    expect(extractDocVersion(doc)).toBe("0.9.0");
  });

  it("ignores other backticked versions elsewhere in the doc", () => {
    const doc = [
      "The `0.7.0 → 0.8.0` bump added a field.",
      "> **Current version: `1.0.0`.**",
      "Format: `<major>.<minor>.<patch>`, e.g. `0.8.0-alpha.1`.",
    ].join("\n");
    expect(extractDocVersion(doc)).toBe("1.0.0");
  });

  it("throws when the callout is absent", () => {
    const doc = "# Extension API\n\nCurrent version is 0.9.0 somewhere.\n";
    expect(() => extractDocVersion(doc)).toThrow(/no.*Current version/i);
  });

  it("throws when there is more than one callout (ambiguity)", () => {
    const doc = ["> **Current version: `0.9.0`.**", "> **Current version: `0.8.0`.**"].join("\n");
    expect(() => extractDocVersion(doc)).toThrow(/found 2/i);
  });
});

describe("compareAllVersions", () => {
  it("reports ok when all three agree", () => {
    const result = compareAllVersions("0.9.0", "0.9.0", "0.9.0");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/all agree/);
  });

  it("reports the const/package mismatch first, before looking at the doc", () => {
    const result = compareAllVersions("0.9.0", "0.8.1", "0.9.0");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/lockstep broken/i);
  });

  it("fails a stale doc even when const and package agree", () => {
    const result = compareAllVersions("0.9.0", "0.9.0", "0.8.0");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/stale/i);
    expect(result.message).toContain("0.8.0");
    expect(result.message).toContain("0.9.0");
  });
});

describe("caretRangeAdmits", () => {
  it("pins the minor below 1.0.0", () => {
    // The case that broke CI: a 0.8 range does not admit a 0.9 release.
    expect(caretRangeAdmits("^0.8.0", "0.9.0")).toBe(false);
    expect(caretRangeAdmits("^0.9.0", "0.9.0")).toBe(true);
    expect(caretRangeAdmits("^0.9.0", "0.9.3")).toBe(true);
    expect(caretRangeAdmits("^0.9.0", "0.10.0")).toBe(false);
  });

  it("does not admit a version below the range floor", () => {
    expect(caretRangeAdmits("^0.9.2", "0.9.1")).toBe(false);
    expect(caretRangeAdmits("^1.2.0", "1.1.9")).toBe(false);
  });

  it("pins only the major at or above 1.0.0", () => {
    expect(caretRangeAdmits("^1.2.0", "1.3.0")).toBe(true);
    expect(caretRangeAdmits("^1.2.0", "2.0.0")).toBe(false);
    expect(caretRangeAdmits("^1.0.0", "0.9.0")).toBe(false);
  });

  it("throws on a range shape it does not understand rather than guessing", () => {
    // A wrong "yes" here would re-open the hole the gate closes, so anything
    // outside the plain caret form must fail loudly.
    for (const range of ["~0.9.0", ">=0.9.0", "0.9.0", "*", "^0.9", "workspace:*"]) {
      expect(() => caretRangeAdmits(range, "0.9.0")).toThrow(/unsupported/i);
    }
  });

  it("throws on a pre-release target version", () => {
    expect(() => caretRangeAdmits("^0.9.0", "0.9.0-alpha.1")).toThrow(/pre-release/i);
  });
});

describe("checkConsumerRanges", () => {
  it("passes when every consumer range admits the version", () => {
    const result = checkConsumerRanges("0.9.0", [
      { path: "apps/api/package.json", range: "^0.9.0" },
      { path: "apps/worker/package.json", range: "^0.9.0" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("2");
  });

  it("fails and names every stale consumer, not just the first", () => {
    const result = checkConsumerRanges("0.9.0", [
      { path: "apps/api/package.json", range: "^0.8.0" },
      { path: "apps/worker/package.json", range: "^0.8.0" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("apps/api/package.json");
    expect(result.message).toContain("apps/worker/package.json");
  });

  it("fails when only one consumer was forgotten", () => {
    const result = checkConsumerRanges("0.9.0", [
      { path: "apps/api/package.json", range: "^0.9.0" },
      { path: "apps/worker/package.json", range: "^0.8.0" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("apps/worker/package.json");
    expect(result.message).not.toContain("apps/api/package.json");
  });

  it("throws when no consumer was found at all", () => {
    // An empty list means the manifest paths or the dependency name went stale;
    // vacuously passing would make the gate useless exactly when it broke.
    expect(() => checkConsumerRanges("0.9.0", [])).toThrow(/no in-repo consumer/i);
  });
});
