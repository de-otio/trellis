/**
 * Unit Tests: tenant/domain-verifier.ts
 *
 * Security contract: `verifyDomainToken(domain, token)` resolves the TXT record
 * at `_trellis-verify.{domain}` and checks whether any record equals
 * `trellis-verify={token}` exactly. The function is fail-closed — any DNS
 * error that is not ENODATA / ENOTFOUND must resolve to a failure outcome, never
 * throw.
 *
 * Return shape (DnsVerifyOutcome discriminated union):
 *   { verified: true }
 *   { verified: false, reason: "TOKEN_MISMATCH" | "NO_RECORDS" | "DNS_ERROR" }
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock setup ───────────────────────────────────────────────────────────────

// vi.hoisted is required so the mock factory can reference the hoisted variable
// before the module is evaluated.
const { resolveTxtMock } = vi.hoisted(() => ({
  resolveTxtMock: vi.fn<() => Promise<string[][]>>(),
}));

vi.mock("node:dns", () => ({
  promises: { resolveTxt: resolveTxtMock },
}));

// ─── Subject under test ───────────────────────────────────────────────────────

import { verifyDomainToken } from "../../../src/lib/tenant/domain-verifier.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dnsError(code: string): Error {
  const err = new Error(`DNS error: ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyDomainToken — success", () => {
  it("returns { verified: true } when the exact TXT record is present", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=tok123"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: true });
  });

  it("calls resolveTxt with the correct lookup name _trellis-verify.{domain}", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=tok123"]]);

    await verifyDomainToken("example.org", "tok123");

    expect(resolveTxtMock).toHaveBeenCalledOnce();
    expect(resolveTxtMock).toHaveBeenCalledWith("_trellis-verify.example.org");
  });
});

describe("verifyDomainToken — TXT record chunk joining", () => {
  it("joins chunks within a single record before comparing (TXT 255-byte split)", async () => {
    // DNS TXT records may be split into 255-byte chunks. The module must join
    // them before comparing.
    resolveTxtMock.mockResolvedValue([["trellis-verify=", "tok123"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: true });
  });

  it("joins multiple chunks correctly (three parts)", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=", "tok", "123"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: true });
  });
});

describe("verifyDomainToken — multiple records", () => {
  it("returns verified:true when the matching record is not the first one", async () => {
    resolveTxtMock.mockResolvedValue([
      ["other=value"],
      ["trellis-verify=tok123"],
    ]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: true });
  });

  it("returns verified:true when the matching record is last among several", async () => {
    resolveTxtMock.mockResolvedValue([
      ["google-site-verification=abc"],
      ["v=spf1 include:example.net ~all"],
      ["trellis-verify=tok123"],
    ]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: true });
  });
});

describe("verifyDomainToken — TOKEN_MISMATCH", () => {
  it("returns TOKEN_MISMATCH when records exist but none match the token", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=wrong-token"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "TOKEN_MISMATCH" });
  });

  it("does not allow prefix/substring match — trellis-verify=tok123extra must not verify tok123", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=tok123extra"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "TOKEN_MISMATCH" });
  });

  it("does not allow suffix/substring match — trellis-verify=xxtok123 must not verify tok123", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=xxtok123"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "TOKEN_MISMATCH" });
  });

  it("does not match without the trellis-verify= prefix (bare token only)", async () => {
    resolveTxtMock.mockResolvedValue([["tok123"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "TOKEN_MISMATCH" });
  });

  it("is case-sensitive — uppercase token must not verify a lowercase record", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=TOK123"]]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "TOKEN_MISMATCH" });
  });
});

describe("verifyDomainToken — NO_RECORDS (empty response)", () => {
  it("returns NO_RECORDS when resolveTxt resolves with an empty array", async () => {
    resolveTxtMock.mockResolvedValue([]);

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "NO_RECORDS" });
  });
});

describe("verifyDomainToken — NO_RECORDS (DNS error codes)", () => {
  it("returns NO_RECORDS when resolveTxt rejects with ENODATA", async () => {
    resolveTxtMock.mockRejectedValue(dnsError("ENODATA"));

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "NO_RECORDS" });
  });

  it("returns NO_RECORDS when resolveTxt rejects with ENOTFOUND", async () => {
    resolveTxtMock.mockRejectedValue(dnsError("ENOTFOUND"));

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "NO_RECORDS" });
  });
});

describe("verifyDomainToken — DNS_ERROR (fail-closed)", () => {
  it("returns DNS_ERROR when resolveTxt rejects with ETIMEOUT (generic DNS failure)", async () => {
    resolveTxtMock.mockRejectedValue(dnsError("ETIMEOUT"));

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "DNS_ERROR" });
  });

  it("returns DNS_ERROR when resolveTxt rejects with an error that has no code", async () => {
    resolveTxtMock.mockRejectedValue(new Error("network unreachable"));

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "DNS_ERROR" });
  });

  it("returns DNS_ERROR for ESERVFAIL (server failure)", async () => {
    resolveTxtMock.mockRejectedValue(dnsError("ESERVFAIL"));

    const result = await verifyDomainToken("example.org", "tok123");

    expect(result).toEqual({ verified: false, reason: "DNS_ERROR" });
  });

  it("never throws — resolves to a failure outcome even on unexpected errors", async () => {
    resolveTxtMock.mockRejectedValue(new TypeError("unexpected internal error"));

    await expect(verifyDomainToken("example.org", "tok123")).resolves.toMatchObject({
      verified: false,
    });
  });
});

describe("verifyDomainToken — lookup name construction", () => {
  it("prepends _trellis-verify. to the domain for the DNS query", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=abc"]]);

    await verifyDomainToken("acme.io", "abc");

    expect(resolveTxtMock).toHaveBeenCalledWith("_trellis-verify.acme.io");
  });

  it("handles subdomains correctly — lookup name includes the full subdomain", async () => {
    resolveTxtMock.mockResolvedValue([["trellis-verify=abc"]]);

    await verifyDomainToken("sub.acme.io", "abc");

    expect(resolveTxtMock).toHaveBeenCalledWith("_trellis-verify.sub.acme.io");
  });
});
