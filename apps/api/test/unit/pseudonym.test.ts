import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PSEUDONYM_DOMAIN,
  computeAnonymousId,
  setMacComputer,
  _resetMacComputerForTest,
} from "../../src/lib/pseudonym.js";

afterEach(() => {
  _resetMacComputerForTest();
  vi.restoreAllMocks();
});

describe("computeAnonymousId", () => {
  it("derives base64( HMAC ) over the domain-separated user id", async () => {
    const seen: { keyId?: string; region?: string; message?: string } = {};
    // Deterministic fake MAC: echo the message bytes so we can assert the
    // domain-separated input was used (NOT raw userId, NOT any PII).
    setMacComputer(async (keyId, region, message) => {
      seen.keyId = keyId;
      seen.region = region;
      seen.message = new TextDecoder().decode(message);
      return message;
    });

    const out = await computeAnonymousId("user_cuid_123", {
      PSEUDONYM_HMAC_KMS_KEY_ID: "alias/pseudonym",
      AWS_REGION: "eu-central-1",
    });

    expect(seen.keyId).toBe("alias/pseudonym");
    expect(seen.region).toBe("eu-central-1");
    // Domain separation prefix is applied; PII is never the input.
    expect(seen.message).toBe(`${PSEUDONYM_DOMAIN}user_cuid_123`);
    expect(seen.message).not.toContain("@"); // no email
    // Output is base64 of the MAC bytes.
    expect(out).toBe(
      Buffer.from(`${PSEUDONYM_DOMAIN}user_cuid_123`, "utf8").toString("base64"),
    );
  });

  it("is stable for the same user id (separation-based pseudonym)", async () => {
    setMacComputer(async (_k, _r, message) => message);
    const a = await computeAnonymousId("u1", {
      PSEUDONYM_HMAC_KMS_KEY_ID: "k",
    });
    const b = await computeAnonymousId("u1", {
      PSEUDONYM_HMAC_KMS_KEY_ID: "k",
    });
    expect(a).toBe(b);
  });

  it("fails SAFE (throws) when no KMS HMAC key id is configured", async () => {
    // No fall back to an unkeyed hash.
    await expect(
      computeAnonymousId("u1", { PSEUDONYM_HMAC_KMS_KEY_ID: undefined }),
    ).rejects.toThrow(/PSEUDONYM_HMAC_KMS_KEY_ID not configured/);
  });

  it("rejects an empty user id", async () => {
    setMacComputer(async (_k, _r, m) => m);
    await expect(
      computeAnonymousId("", { PSEUDONYM_HMAC_KMS_KEY_ID: "k" }),
    ).rejects.toThrow(/non-empty string/);
  });
});
