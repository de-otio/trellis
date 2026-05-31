import { describe, expect, it } from "vitest";
import { validateDomain } from "../../src/lib/tenant/domain-validator.js";

describe("validateDomain — format checks", () => {
  it.each([
    ["example.org", "example.org"],
    ["  Example.ORG  ", "example.org"],
    ["sub.example.org", "sub.example.org"],
    ["my-company.io", "my-company.io"],
    ["xn--nxasmq6b.com", "xn--nxasmq6b.com"],
    ["foo.bar.example.org", "foo.bar.example.org"],
  ])("accepts valid domain %s → %s", (input, expected) => {
    const result = validateDomain(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.domain).toBe(expected);
  });

  it.each([
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["https://example.com", "has protocol"],
    ["example.com/path", "has path"],
    ["example.com?q=1", "has query"],
    ["notadomain", "single label"],
    ["-bad.com", "leading hyphen label"],
    ["bad-.com", "trailing hyphen in label"],
    [".example.com", "leading dot"],
    ["example.com.", "trailing dot"],
    ["exam ple.com", "space in label"],
    ["example.123", "numeric TLD"],
    ["a".repeat(64) + ".com", "label > 63 chars"],
    [null as unknown as string, "null"],
    [42 as unknown as string, "number"],
  ])("rejects invalid format: %s (%s)", (input) => {
    const result = validateDomain(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_DOMAIN");
  });
});

describe("validateDomain — PSL checks", () => {
  it.each([
    "com",
    "net",
    "org",
    "edu",
    "gov",
    "co.uk",
    "org.uk",
    "ac.uk",
    "co.jp",
    "com.au",
    "co.nz",
    "nom.br",
  ])("rejects public suffix %s", (suffix) => {
    const result = validateDomain(suffix);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PUBLIC_SUFFIX");
  });

  it.each([
    "example.org",
    "mycompany.co.uk",
    "acme.co.jp",
    "startup.com.au",
    "university.ac.uk",
    "bigcorp.org",
  ])("accepts registrable domain %s", (domain) => {
    const result = validateDomain(domain);
    expect(result.ok).toBe(true);
  });

  it("rejects wildcard PSL suffix (e.g. one label above *.ck)", () => {
    // Per PSL: *.ck means every second-level under .ck is a public suffix.
    const result = validateDomain("foo.ck");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PUBLIC_SUFFIX");
  });

  it("accepts PSL exception (www.ck is an exception to *.ck)", () => {
    const result = validateDomain("www.ck");
    expect(result.ok).toBe(true);
  });
});

describe("validateDomain — reserved namespace", () => {
  it("rejects example.com itself", () => {
    const result = validateDomain("example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RESERVED_DOMAIN");
  });

  it("rejects subdomains of example.com", () => {
    const result = validateDomain("app.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RESERVED_DOMAIN");
  });

  it("rejects deeper subdomains of example.com", () => {
    const result = validateDomain("api.internal.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RESERVED_DOMAIN");
  });

  it("does not reject domains that merely contain 'trellis'", () => {
    const result = validateDomain("mytrellis.com");
    expect(result.ok).toBe(true);
  });
});

describe("validateDomain — normalisation", () => {
  it("lowercases the domain", () => {
    const result = validateDomain("MyCompany.COM");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.domain).toBe("mycompany.com");
  });

  it("strips leading/trailing whitespace", () => {
    const result = validateDomain("  example.org  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.domain).toBe("example.org");
  });

  it("strips port number", () => {
    const result = validateDomain("example.org:8080");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.domain).toBe("example.org");
  });
});
