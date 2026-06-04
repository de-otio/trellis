/**
 * Unit Tests: slug-validator.ts
 *
 * Covers positive cases, negative format cases, reserved-list cases,
 * shell-escape attempts, and URL-injection attempts.
 */

import { describe, expect, it } from "vitest";
import { validateTenantSlug } from "../../../src/lib/tenant/slug-validator.js";

describe("validateTenantSlug — valid slugs", () => {
  it.each([
    "abc",
    "a1b",
    "my-org",
    "acme-corp-123",
    "x99",
    "a".repeat(32),
    "a".repeat(40), // max allowed (personal-{userId} JIT slugs)
  ])("accepts %s", (slug) => {
    expect(validateTenantSlug(slug)).toEqual({ ok: true });
  });
});

describe("validateTenantSlug — INVALID_FORMAT", () => {
  it.each([
    ["too short (2)", "ab"],
    ["too long (41)", "a".repeat(41)],
    ["leading hyphen", "-abc"],
    ["trailing hyphen", "abc-"],
    ["double hyphen", "foo--bar"],
    ["uppercase letters", "UPPER"],
    ["space", "foo bar"],
    ["dot", "foo.bar"],
    ["underscore", "foo_bar"],
    // Shell-escape attempts
    ["semicolon", "foo;bar"],
    ["dollar sign", "$evil"],
    ["backtick", "`cmd`"],
    ["parentheses", "foo(bar)"],
    ["exclamation", "foo!"],
    // URL-injection attempts
    ["slash", "foo/bar"],
    ["double-slash", "//evil"],
    ["dotdot", "../admin"],
    ["percent", "%2F"],
    ["at-sign", "foo@bar"],
  ])("rejects %s: %s", (_, slug) => {
    const result = validateTenantSlug(slug);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_FORMAT");
    }
  });
});

describe("validateTenantSlug — RESERVED", () => {
  it.each([
    "admin",
    "api",
    "app",
    "auth",
    "system",
    "trellis",
    "de-otio",
    "trellis",
    "www",
    "support",
    "console",
    "dashboard",
    "help",
  ])("rejects reserved slug: %s", (slug) => {
    const result = validateTenantSlug(slug);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RESERVED");
    }
  });
});
