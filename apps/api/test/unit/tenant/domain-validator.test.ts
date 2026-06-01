/**
 * Unit Tests: domain-validator.ts
 *
 * Contract: `validateDomain(raw)` validates and normalises a domain string for
 * tenant domain-claiming. It is security-relevant — it must reject public
 * suffixes (bare TLDs / second-level suffixes like "co.uk") so that a tenant
 * cannot claim a suffix that would encompass other registrable domains, and it
 * must reject the reserved *.example.com namespace used as the platform's own
 * internal domain.
 *
 * Return shape: discriminated union
 *   { ok: true,  domain: string }          — normalised, lower-case, no port
 *   { ok: false, code: string, message: string }
 *
 * Error codes:
 *   "INVALID_DOMAIN"  — not a string, empty, structurally malformed hostname
 *   "PUBLIC_SUFFIX"   — bare TLD or second-level public suffix (PSL)
 *   "RESERVED_DOMAIN" — example.com or any *.example.com subdomain
 */

import { describe, expect, it } from "vitest";
import { validateDomain } from "../../../src/lib/tenant/domain-validator.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expectOk(raw: string, expectedDomain?: string) {
  const result = validateDomain(raw);
  expect(result.ok, `expected ok:true for "${raw}", got ${JSON.stringify(result)}`).toBe(true);
  if (result.ok && expectedDomain !== undefined) {
    expect(result.domain).toBe(expectedDomain);
  }
  return result;
}

function expectError(raw: string, code: string) {
  const result = validateDomain(raw);
  expect(result.ok, `expected ok:false for "${raw}", got ${JSON.stringify(result)}`).toBe(false);
  if (!result.ok) {
    expect(result.code, `expected code "${code}" for "${raw}"`).toBe(code);
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  }
  return result;
}

// ─── Valid / ok:true ─────────────────────────────────────────────────────────

describe("validateDomain — valid registrable domains (ok:true)", () => {
  it("accepts a plain two-label .org domain", () => {
    expectOk("example.org", "example.org");
  });

  it("accepts a registrable .io domain", () => {
    expectOk("acme.io", "acme.io");
  });

  it("accepts a registrable .net domain", () => {
    expectOk("myservice.net", "myservice.net");
  });

  it("accepts a three-label subdomain (foo.example.org)", () => {
    // example.org is registrable, so subdomains of it are fine
    expectOk("foo.example.org", "foo.example.org");
  });

  it("accepts a deep subdomain", () => {
    expectOk("api.staging.acme.io", "api.staging.acme.io");
  });
});

// ─── Normalisation ───────────────────────────────────────────────────────────

describe("validateDomain — normalisation", () => {
  it("lowercases uppercase input", () => {
    expectOk("EXAMPLE.ORG", "example.org");
  });

  it("lowercases mixed-case input", () => {
    expectOk("Acme.IO", "acme.io");
  });

  it("trims leading whitespace", () => {
    expectOk("   example.org", "example.org");
  });

  it("trims trailing whitespace", () => {
    expectOk("example.org   ", "example.org");
  });

  it("trims both sides", () => {
    expectOk("  acme.io  ", "acme.io");
  });
});

// ─── Port stripping ──────────────────────────────────────────────────────────

describe("validateDomain — port stripping", () => {
  it("strips :8080 and returns the bare domain", () => {
    expectOk("example.org:8080", "example.org");
  });

  it("strips :443", () => {
    expectOk("acme.io:443", "acme.io");
  });

  it("strips port on a normalised-case input", () => {
    expectOk("EXAMPLE.ORG:3000", "example.org");
  });
});

// ─── URL-shaped rejection — INVALID_DOMAIN ───────────────────────────────────

describe("validateDomain — URL-shaped inputs → INVALID_DOMAIN", () => {
  it("rejects input with a protocol (https://)", () => {
    expectError("https://example.org", "INVALID_DOMAIN");
  });

  it("rejects input with http://", () => {
    expectError("http://example.org", "INVALID_DOMAIN");
  });

  it("rejects input containing a path (/path)", () => {
    expectError("example.org/path", "INVALID_DOMAIN");
  });

  it("rejects input containing a query string (?x=1)", () => {
    expectError("example.org?x=1", "INVALID_DOMAIN");
  });

  it("rejects a full URL with protocol + path", () => {
    expectError("https://example.org/some/path?q=1", "INVALID_DOMAIN");
  });
});

// ─── Public suffix rejection — PUBLIC_SUFFIX ─────────────────────────────────

describe("validateDomain — public suffixes → PUBLIC_SUFFIX", () => {
  it("rejects bare TLD 'com'", () => {
    expectError("com", "PUBLIC_SUFFIX");
  });

  it("rejects bare TLD 'net'", () => {
    expectError("net", "PUBLIC_SUFFIX");
  });

  it("rejects bare TLD 'org'", () => {
    expectError("org", "PUBLIC_SUFFIX");
  });

  it("rejects bare TLD 'io'", () => {
    expectError("io", "PUBLIC_SUFFIX");
  });

  it("rejects second-level public suffix 'co.uk'", () => {
    expectError("co.uk", "PUBLIC_SUFFIX");
  });
});

// ─── Reserved domain rejection — RESERVED_DOMAIN ────────────────────────────

describe("validateDomain — reserved example.com namespace → RESERVED_DOMAIN", () => {
  it("rejects example.com itself", () => {
    expectError("example.com", "RESERVED_DOMAIN");
  });

  it("rejects a direct subdomain foo.example.com", () => {
    expectError("foo.example.com", "RESERVED_DOMAIN");
  });

  it("rejects a deeper subdomain api.tenant.example.com", () => {
    expectError("api.tenant.example.com", "RESERVED_DOMAIN");
  });

  it("rejects uppercase EXAMPLE.COM (normalised before check)", () => {
    expectError("EXAMPLE.COM", "RESERVED_DOMAIN");
  });
});

// ─── INVALID_DOMAIN — structural invalidity ───────────────────────────────────

describe("validateDomain — structurally invalid inputs → INVALID_DOMAIN", () => {
  it("rejects empty string", () => {
    expectError("", "INVALID_DOMAIN");
  });

  it("rejects non-string (number) via any cast", () => {
    expectError(42 as any, "INVALID_DOMAIN");
  });

  it("rejects non-string (null) via any cast", () => {
    expectError(null as any, "INVALID_DOMAIN");
  });

  it("rejects non-string (undefined) via any cast", () => {
    expectError(undefined as any, "INVALID_DOMAIN");
  });

  it("rejects single-label 'localhost'", () => {
    expectError("localhost", "INVALID_DOMAIN");
  });

  it("rejects domain with trailing dot 'example.org.'", () => {
    expectError("example.org.", "INVALID_DOMAIN");
  });

  it("rejects label containing underscore 'ex_ample.org'", () => {
    expectError("ex_ample.org", "INVALID_DOMAIN");
  });

  it("rejects numeric TLD 'example.123'", () => {
    expectError("example.123", "INVALID_DOMAIN");
  });

  it("rejects over-long domain (254 chars)", () => {
    // 254-char domain: 'a' repeated 250 times + '.org' (4) = 254, exceeds 253-char limit
    const long = "a".repeat(250) + ".org";
    expect(long.length).toBe(254);
    expectError(long, "INVALID_DOMAIN");
  });

  it("rejects label with space", () => {
    expectError("my domain.org", "INVALID_DOMAIN");
  });

  it("rejects label starting with hyphen '-example.org'", () => {
    expectError("-example.org", "INVALID_DOMAIN");
  });

  it("rejects label ending with hyphen 'example-.org'", () => {
    expectError("example-.org", "INVALID_DOMAIN");
  });
});
