import { describe, expect, it } from "vitest";
import {
  isReservedSlug,
  RESERVED_SLUGS,
  SLUG_REGEX,
  validateSlug,
} from "../../../src/lib/tenant/reserved-slugs.js";

describe("SLUG_REGEX", () => {
  it.each([
    ["acme", true, "min length"],
    ["acme-co", true, "with hyphen"],
    ["abc", true, "exactly 3 chars"],
    ["a".repeat(32), true, "32 chars"],
    ["a".repeat(40), true, "exactly 40 chars (personal-tenant ceiling)"],
    ["personal-clxxx7uq2l0000l1j23af3r8bo", true, "personal-tenant slug shape"],
    ["acme123", true, "with digits"],
    ["a1-b2-c3", true, "alphanumeric with multiple hyphens"],
  ])("accepts %s", (slug, expected) => {
    expect(SLUG_REGEX.test(slug)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["a", "1 char"],
    ["ab", "2 chars"],
    ["a".repeat(41), "41 chars"],
    ["-acme", "leading hyphen"],
    ["acme-", "trailing hyphen"],
    ["acme--co", "consecutive hyphens"],
    ["xn--abc", "punycode-like (consecutive hyphens)"],
    ["Acme", "uppercase"],
    ["acme.co", "dot"],
    ["acme co", "space"],
    ["acme/co", "slash"],
    ["acme_co", "underscore"],
    ["acme\\co", "backslash"],
    ["acme$co", "special char"],
    ["acme;DROP", "shell-escape attempt"],
    ["../etc", "path traversal attempt"],
  ])("rejects %s (%s)", (slug) => {
    expect(SLUG_REGEX.test(slug)).toBe(false);
  });
});

describe("isReservedSlug", () => {
  it("identifies platform terms", () => {
    expect(isReservedSlug("admin")).toBe(true);
    expect(isReservedSlug("api")).toBe(true);
    expect(isReservedSlug("auth")).toBe(true);
    expect(isReservedSlug("system")).toBe(true);
  });

  it("identifies trellis/de-otio/trellis terms", () => {
    expect(isReservedSlug("trellis")).toBe(true);
    expect(isReservedSlug("de-otio")).toBe(true);
    expect(isReservedSlug("deotio")).toBe(true);
    expect(isReservedSlug("trellis")).toBe(true);
  });

  it("identifies major brand terms", () => {
    expect(isReservedSlug("google")).toBe(true);
    expect(isReservedSlug("microsoft")).toBe(true);
    expect(isReservedSlug("apple")).toBe(true);
    expect(isReservedSlug("meta")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isReservedSlug("ADMIN")).toBe(true);
    expect(isReservedSlug("Trellis")).toBe(true);
    expect(isReservedSlug("Google")).toBe(true);
  });

  it("does not flag non-reserved slugs", () => {
    expect(isReservedSlug("acme")).toBe(false);
    expect(isReservedSlug("my-business")).toBe(false);
    expect(isReservedSlug("dog-cafe")).toBe(false);
  });
});

describe("validateSlug", () => {
  it("returns null for a valid, non-reserved slug", () => {
    expect(validateSlug("acme")).toBeNull();
    expect(validateSlug("my-business")).toBeNull();
    expect(validateSlug("hotel-pawprint")).toBeNull();
  });

  it("returns INVALID_FORMAT before checking reservation", () => {
    expect(validateSlug("Acme")).toBe("INVALID_FORMAT");
    expect(validateSlug("acme--co")).toBe("INVALID_FORMAT");
    expect(validateSlug("a")).toBe("INVALID_FORMAT");
    expect(validateSlug("../escape")).toBe("INVALID_FORMAT");
  });

  it("returns RESERVED for a format-valid but reserved slug", () => {
    expect(validateSlug("admin")).toBe("RESERVED");
    expect(validateSlug("trellis")).toBe("RESERVED");
    expect(validateSlug("api")).toBe("RESERVED");
  });

  it("RESERVED takes precedence only after INVALID_FORMAT clears", () => {
    // "Admin" is uppercase — INVALID_FORMAT wins over RESERVED-after-lowercase.
    expect(validateSlug("Admin")).toBe("INVALID_FORMAT");
  });
});

describe("RESERVED_SLUGS set", () => {
  it("is non-empty", () => {
    expect(RESERVED_SLUGS.size).toBeGreaterThan(0);
  });

  it("contains lowercase entries only", () => {
    for (const entry of RESERVED_SLUGS) {
      expect(entry).toBe(entry.toLowerCase());
    }
  });

  it("entries themselves all pass SLUG_REGEX (sanity check — every reserved entry could otherwise have been claimed)", () => {
    for (const entry of RESERVED_SLUGS) {
      expect(SLUG_REGEX.test(entry)).toBe(true);
    }
  });
});
