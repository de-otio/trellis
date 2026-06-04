/**
 * Unit Tests: idp-name.ts
 *
 * Contract: cognitoIdpName(tenantId) derives the Cognito identity-provider
 * name as `tenant-{id}` where id is truncated to 25 chars so the total
 * result fits Cognito's 32-char provider-name quota ("tenant-" is 7 chars,
 * 7 + 25 = 32).
 */

import { describe, expect, it } from "vitest";
import { cognitoIdpName } from "../../../src/lib/tenant/idp-name.js";

describe("cognitoIdpName — prefix", () => {
  it("always starts with 'tenant-'", () => {
    expect(cognitoIdpName("abc")).toMatch(/^tenant-/);
    expect(cognitoIdpName("")).toMatch(/^tenant-/);
    expect(cognitoIdpName("a".repeat(40))).toMatch(/^tenant-/);
  });
});

describe("cognitoIdpName — short ids (< 25 chars)", () => {
  it("preserves a short alphabetic id unchanged", () => {
    expect(cognitoIdpName("abc123")).toBe("tenant-abc123");
  });

  it("preserves a single-character id", () => {
    expect(cognitoIdpName("x")).toBe("tenant-x");
  });

  it("preserves a 10-char id", () => {
    const id = "ab12cd34ef";
    expect(cognitoIdpName(id)).toBe(`tenant-${id}`);
  });
});

describe("cognitoIdpName — realistic 25-char cuid-like id", () => {
  it("keeps the full 25-char id and produces exactly 32 chars total", () => {
    // cuid v1 is 25 chars; construct a representative placeholder
    const id = "c" + "a1b2c3d4e5f6g7h8i9j0k1l2";
    expect(id.length).toBe(25);

    const result = cognitoIdpName(id);

    expect(result).toBe(`tenant-${id}`);
    // This is the load-bearing assertion: the whole point of the 25-char cap
    // is to keep the Cognito provider name within the 32-char quota.
    expect(result.length).toBe(32);
  });
});

describe("cognitoIdpName — truncation (id > 25 chars)", () => {
  it("truncates a 40-char id to its first 25 chars", () => {
    const id = "a".repeat(10) + "b".repeat(15) + "c".repeat(15); // 40 chars
    const result = cognitoIdpName(id);

    expect(result).toBe(`tenant-${id.slice(0, 25)}`);
    expect(result.length).toBe(32);
  });

  it("result is exactly 32 chars for any id longer than 25 (Cognito ceiling)", () => {
    const id = "x".repeat(100);
    const result = cognitoIdpName(id);

    expect(result.length).toBe(32);
  });
});

describe("cognitoIdpName — boundary cases", () => {
  it("id of exactly 25 chars is NOT truncated", () => {
    const id = "z".repeat(25);
    const result = cognitoIdpName(id);

    expect(result).toBe(`tenant-${"z".repeat(25)}`);
    expect(result.length).toBe(32);
  });

  it("id of exactly 26 chars is truncated to 25", () => {
    const id = "z".repeat(26);
    const result = cognitoIdpName(id);

    expect(result).toBe(`tenant-${"z".repeat(25)}`);
    expect(result.length).toBe(32);
  });

  it("id of exactly 24 chars is NOT truncated", () => {
    const id = "m".repeat(24);
    const result = cognitoIdpName(id);

    expect(result).toBe(`tenant-${"m".repeat(24)}`);
    expect(result.length).toBe(31);
  });
});

describe("cognitoIdpName — empty id", () => {
  it("returns 'tenant-' for an empty string", () => {
    expect(cognitoIdpName("")).toBe("tenant-");
  });
});

describe("cognitoIdpName — determinism", () => {
  it("returns the same result on repeated calls with the same input (short id)", () => {
    const id = "abc123";
    expect(cognitoIdpName(id)).toBe(cognitoIdpName(id));
  });

  it("returns the same result on repeated calls with the same input (long id)", () => {
    const id = "q".repeat(50);
    expect(cognitoIdpName(id)).toBe(cognitoIdpName(id));
  });
});
