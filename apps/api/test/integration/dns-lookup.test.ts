/**
 * DNS Integration Test — real DNS lookup against a controlled record.
 *
 * This test performs a live DNS lookup and must be opted-in explicitly:
 *   DNS_INTEGRATION=true npx vitest run test/integration/dns-lookup.test.ts
 *
 * Skipped by default (and in CI) unless DNS_INTEGRATION=true is set.
 * The test fixture record `_trellis-test.example.com` is a TXT record
 * maintained by the project team with a known stable value.
 */

import { describe, expect, it } from "vitest";
import { verifyDomainToken } from "../../src/lib/tenant/domain-verifier.js";

const DNS_INTEGRATION = process.env.DNS_INTEGRATION === "true";

describe.skipIf(!DNS_INTEGRATION)(
  "DNS integration: real lookup against _trellis-test.example.com",
  () => {
    it("verifies a known good TXT record (DNS_INTEGRATION=true)", async () => {
      // The test fixture TXT record at _trellis-test.example.com must contain:
      // trellis-verify=integration-test-token-do-not-remove
      const result = await verifyDomainToken(
        "trellis-test.example.com",
        "integration-test-token-do-not-remove",
      );
      expect(result.verified).toBe(true);
    }, 10_000);

    it("returns TOKEN_MISMATCH for wrong token on a known domain", async () => {
      const result = await verifyDomainToken(
        "trellis-test.example.com",
        "definitely-wrong-token",
      );
      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(["TOKEN_MISMATCH", "NO_RECORDS"]).toContain(result.reason);
      }
    }, 10_000);

    it("returns NO_RECORDS or DNS_ERROR for a nonexistent subdomain", async () => {
      const result = await verifyDomainToken(
        "does-not-exist-nxdomain-12345.example.com",
        "anytoken",
      );
      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(["NO_RECORDS", "DNS_ERROR"]).toContain(result.reason);
      }
    }, 10_000);
  },
);

describe.skipIf(DNS_INTEGRATION)("DNS integration (skipped — set DNS_INTEGRATION=true to run)", () => {
  it("is skipped unless DNS_INTEGRATION=true", () => {
    expect(true).toBe(true);
  });
});
