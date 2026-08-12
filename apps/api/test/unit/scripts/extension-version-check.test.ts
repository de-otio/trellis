import { describe, expect, it } from "vitest";
import {
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
    const doc = [
      "> **Current version: `0.9.0`.**",
      "> **Current version: `0.8.0`.**",
    ].join("\n");
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
