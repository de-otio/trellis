import { describe, expect, it } from "vitest";
import { deriveEmailDomain } from "../../../src/lib/tenant/derive-domain.js";

describe("deriveEmailDomain", () => {
  it.each([
    ["alice@example.com", "example.com"],
    ["Alice@Example.COM", "example.com"],
    ["user.name+tag@sub.domain.example", "sub.domain.example"],
    ["  trim@example.com  ", "example.com"],
  ])("extracts and lowercases the domain (%s)", (input, expected) => {
    expect(deriveEmailDomain(input)).toBe(expected);
  });

  it.each([
    [null, "null"],
    [undefined, "undefined"],
    ["", "empty string"],
    ["   ", "all whitespace"],
    ["no-at-sign", "missing @"],
    ["alice@", "trailing @, no domain"],
    ["@example.com", "leading @, no local"],
    ["alice@no-dot", "domain with no dot"],
    ["alice@@double.com", "double @"],
    ["alice@.example.com", "leading dot in domain"],
    ["alice@example.com.", "trailing dot in domain"],
    ["alice with space@example.com", "space in local"],
  ])("returns null for invalid input (%s, %s)", (input) => {
    expect(deriveEmailDomain(input as any)).toBeNull();
  });
});
