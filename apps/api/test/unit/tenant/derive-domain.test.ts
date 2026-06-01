/**
 * Unit tests for `deriveEmailDomain`.
 *
 * CONTRACT: given a raw email string (possibly dirty), return the lowercased
 * domain part, or null for any input that cannot be parsed unambiguously as
 * `local@domain.tld`.
 *
 * WHY THIS MATTERS — CROSS-TENANT ISOLATION:
 * Callers perform an exact SQL lookup `tenant_domains.domain = result`. If
 * this function is too permissive — accepting substrings, wildcards, inputs
 * with multiple `@` signs, or domains without a dot — a malicious or
 * malformed address could resolve to a different tenant's domain row, granting
 * access to the wrong organisation. The implementation must be conservative:
 * when in doubt, return null and let the caller fall back to personal-tenant
 * resolution.
 */

import { describe, expect, it } from "vitest";
import { deriveEmailDomain } from "../../../src/lib/tenant/derive-domain.js";

describe("deriveEmailDomain", () => {
  // ── VALID inputs ──────────────────────────────────────────────────────────

  describe("valid email addresses", () => {
    it("extracts a simple domain", () => {
      expect(deriveEmailDomain("user@example.org")).toBe("example.org");
    });

    it("preserves subdomain structure", () => {
      expect(deriveEmailDomain("user@mail.example.org")).toBe("mail.example.org");
    });

    it("preserves deeper subdomain chains", () => {
      expect(deriveEmailDomain("alice@a.b.example.org")).toBe("a.b.example.org");
    });

    it("handles a numeric local part", () => {
      expect(deriveEmailDomain("42@example.org")).toBe("example.org");
    });
  });

  // ── LOWERCASING ───────────────────────────────────────────────────────────

  describe("case normalisation", () => {
    it("lowercases an uppercase domain", () => {
      expect(deriveEmailDomain("User@Example.ORG")).toBe("example.org");
    });

    it("lowercases a mixed-case local+domain", () => {
      expect(deriveEmailDomain("USER@MAIL.EXAMPLE.COM")).toBe("mail.example.com");
    });
  });

  // ── TRIMMING ──────────────────────────────────────────────────────────────

  describe("surrounding whitespace trimming", () => {
    it("strips leading and trailing spaces", () => {
      expect(deriveEmailDomain("  user@example.org  ")).toBe("example.org");
    });

    it("strips leading tab and trailing newline", () => {
      expect(deriveEmailDomain("\tuser@example.org\n")).toBe("example.org");
    });
  });

  // ── NULL-ISH / EMPTY inputs ───────────────────────────────────────────────

  describe("null-ish and empty inputs", () => {
    it("returns null for null", () => {
      expect(deriveEmailDomain(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(deriveEmailDomain(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(deriveEmailDomain("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(deriveEmailDomain("   ")).toBeNull();
    });

    it("returns null for tab-only string", () => {
      expect(deriveEmailDomain("\t")).toBeNull();
    });
  });

  // ── MISSING @ ─────────────────────────────────────────────────────────────

  describe("no @ sign", () => {
    it("returns null when there is no @ at all", () => {
      expect(deriveEmailDomain("userexample.org")).toBeNull();
    });

    it("returns null for a bare domain with no local part", () => {
      expect(deriveEmailDomain("example.org")).toBeNull();
    });
  });

  // ── MULTIPLE @ signs (SECURITY-CRITICAL) ──────────────────────────────────

  describe("multiple @ signs — must not guess (isolation-critical)", () => {
    it("returns null for a@b@example.org", () => {
      // The regex [^\s@]+@([^\s@]+\.[^\s@]+) excludes @ from both capture
      // groups, so this cannot match. Even if it did, the domain.includes('@')
      // guard is the last line of defence.
      expect(deriveEmailDomain("a@b@example.org")).toBeNull();
    });

    it("returns null for @@example.org", () => {
      expect(deriveEmailDomain("@@example.org")).toBeNull();
    });

    it("returns null for user@host@example.org", () => {
      expect(deriveEmailDomain("user@host@example.org")).toBeNull();
    });
  });

  // ── NO DOT IN DOMAIN ─────────────────────────────────────────────────────

  describe("domain without a dot", () => {
    it("returns null for user@localhost", () => {
      expect(deriveEmailDomain("user@localhost")).toBeNull();
    });

    it("returns null for user@intranet", () => {
      expect(deriveEmailDomain("user@intranet")).toBeNull();
    });
  });

  // ── LEADING / TRAILING DOT IN DOMAIN ─────────────────────────────────────

  describe("leading or trailing dot in domain", () => {
    it("returns null when domain starts with a dot", () => {
      expect(deriveEmailDomain("user@.example.org")).toBeNull();
    });

    it("returns null when domain ends with a dot", () => {
      expect(deriveEmailDomain("user@example.org.")).toBeNull();
    });

    it("returns null when domain is just a dot", () => {
      expect(deriveEmailDomain("user@.")).toBeNull();
    });
  });

  // ── WHITESPACE INSIDE THE ADDRESS ────────────────────────────────────────

  describe("internal whitespace", () => {
    it("returns null for a space in the local part", () => {
      expect(deriveEmailDomain("user name@example.org")).toBeNull();
    });

    it("returns null for a space in the domain", () => {
      expect(deriveEmailDomain("user@ex ample.org")).toBeNull();
    });

    it("returns null for a tab inside the domain", () => {
      expect(deriveEmailDomain("user@ex\tample.org")).toBeNull();
    });

    it("returns null for trailing space before @", () => {
      // "user @example.org" — after trim the internal space remains
      expect(deriveEmailDomain("user @example.org")).toBeNull();
    });
  });

  // ── EMPTY LOCAL PART ─────────────────────────────────────────────────────

  describe("empty local part", () => {
    it("returns null for @example.org (no local part)", () => {
      // [^\s@]+ requires ≥1 character before @
      expect(deriveEmailDomain("@example.org")).toBeNull();
    });
  });

  // ── PLUS-ADDRESSING ──────────────────────────────────────────────────────

  describe("plus-addressed local part", () => {
    it("treats + as a normal local-part character and returns the domain", () => {
      // RFC 5321 allows '+' in the local part; callers must not strip tags
      // before passing the address here, but the domain extraction is the
      // same regardless.
      expect(deriveEmailDomain("user+tag@example.org")).toBe("example.org");
    });

    it("handles multiple plus tags", () => {
      expect(deriveEmailDomain("user+tag1+tag2@example.org")).toBe("example.org");
    });
  });
});
