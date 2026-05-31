import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDomainToken } from "../../src/lib/tenant/domain-verifier.js";

const { mockResolveTxt } = vi.hoisted(() => ({
  mockResolveTxt: vi.fn(),
}));

vi.mock("node:dns", () => ({
  promises: {
    resolveTxt: mockResolveTxt,
  },
}));

describe("verifyDomainToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("verified: true", () => {
    it("returns verified when TXT record matches exactly", async () => {
      const token = "abc123def456abc1";
      mockResolveTxt.mockResolvedValue([[`trellis-verify=${token}`]]);

      const result = await verifyDomainToken("example.com", token);
      expect(result.verified).toBe(true);
    });

    it("resolves the correct hostname _trellis-verify.{domain}", async () => {
      const token = "tok";
      mockResolveTxt.mockResolvedValue([[`trellis-verify=${token}`]]);

      await verifyDomainToken("mycompany.io", token);
      expect(mockResolveTxt).toHaveBeenCalledWith("_trellis-verify.mycompany.io");
    });

    it("matches when the TXT record has chunked strings joined", async () => {
      const token = "chunkedtoken";
      // DNS chunks a single record into multiple strings
      mockResolveTxt.mockResolvedValue([["trellis-verify=", token]]);

      const result = await verifyDomainToken("example.com", token);
      expect(result.verified).toBe(true);
    });

    it("matches across multiple TXT records (finds the correct one)", async () => {
      const token = "correcttoken";
      mockResolveTxt.mockResolvedValue([
        ["v=spf1 include:sendgrid.com ~all"],
        [`trellis-verify=${token}`],
      ]);

      const result = await verifyDomainToken("example.com", token);
      expect(result.verified).toBe(true);
    });
  });

  describe("verified: false — TOKEN_MISMATCH", () => {
    it("returns TOKEN_MISMATCH when no record matches the token", async () => {
      mockResolveTxt.mockResolvedValue([["trellis-verify=wrongtoken"]]);

      const result = await verifyDomainToken("example.com", "correcttoken");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("TOKEN_MISMATCH");
    });

    it("returns TOKEN_MISMATCH when record has extra whitespace", async () => {
      const token = "exacttoken";
      mockResolveTxt.mockResolvedValue([[` trellis-verify=${token}`]]);

      const result = await verifyDomainToken("example.com", token);
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("TOKEN_MISMATCH");
    });

    it("returns TOKEN_MISMATCH for partial token match", async () => {
      mockResolveTxt.mockResolvedValue([["trellis-verify=abc"]]);

      const result = await verifyDomainToken("example.com", "abcdef");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("TOKEN_MISMATCH");
    });

    it("returns TOKEN_MISMATCH when records exist but none match", async () => {
      mockResolveTxt.mockResolvedValue([
        ["v=spf1 -all"],
        ["google-site-verification=xyz"],
      ]);

      const result = await verifyDomainToken("example.com", "mytoken");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("TOKEN_MISMATCH");
    });
  });

  describe("verified: false — NO_RECORDS", () => {
    it("returns NO_RECORDS when resolveTxt throws ENODATA", async () => {
      const err = Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      mockResolveTxt.mockRejectedValue(err);

      const result = await verifyDomainToken("example.com", "tok");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("NO_RECORDS");
    });

    it("returns NO_RECORDS when resolveTxt throws ENOTFOUND (NXDOMAIN)", async () => {
      const err = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      mockResolveTxt.mockRejectedValue(err);

      const result = await verifyDomainToken("nxdomain.example.com", "tok");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("NO_RECORDS");
    });

    it("returns NO_RECORDS when resolveTxt returns empty array", async () => {
      mockResolveTxt.mockResolvedValue([]);

      const result = await verifyDomainToken("example.com", "tok");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("NO_RECORDS");
    });
  });

  describe("verified: false — DNS_ERROR", () => {
    it("returns DNS_ERROR on generic network error", async () => {
      mockResolveTxt.mockRejectedValue(new Error("Network timeout"));

      const result = await verifyDomainToken("example.com", "tok");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("DNS_ERROR");
    });

    it("returns DNS_ERROR on ETIMEOUT", async () => {
      const err = Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
      mockResolveTxt.mockRejectedValue(err);

      const result = await verifyDomainToken("example.com", "tok");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("DNS_ERROR");
    });

    it("returns DNS_ERROR on ECONNREFUSED", async () => {
      const err = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      mockResolveTxt.mockRejectedValue(err);

      const result = await verifyDomainToken("example.com", "tok");
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("DNS_ERROR");
    });
  });
});
