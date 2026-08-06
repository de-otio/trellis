import { describe, expect, it } from "vitest";
import {
  compareVersions,
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
