import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { KMSClient, GenerateMacCommand } from "@aws-sdk/client-kms";
import {
  PSEUDONYM_DOMAIN,
  computeAnonymousId,
  setMacComputer,
  _resetMacComputerForTest,
} from "../../src/lib/pseudonym.js";

const kms = mockClient(KMSClient);

beforeEach(() => {
  kms.reset();
});

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

describe("computeAnonymousId (default AWS-SDK-backed macComputer)", () => {
  beforeEach(() => {
    _resetMacComputerForTest();
  });

  it("calls KMS GenerateMac with the domain-separated message and returns base64(Mac)", async () => {
    const macBytes = new Uint8Array([1, 2, 3, 4]);
    kms.on(GenerateMacCommand).resolves({ Mac: macBytes });

    const out = await computeAnonymousId("user_cuid_123", {
      PSEUDONYM_HMAC_KMS_KEY_ID: "alias/pseudonym",
      AWS_REGION: "eu-central-1",
    });

    const call = kms.commandCalls(GenerateMacCommand)[0]!;
    expect(call.args[0].input.KeyId).toBe("alias/pseudonym");
    expect(call.args[0].input.MacAlgorithm).toBe("HMAC_SHA_256");
    expect(
      new TextDecoder().decode(call.args[0].input.Message as Uint8Array),
    ).toBe(`${PSEUDONYM_DOMAIN}user_cuid_123`);
    expect(out).toBe(Buffer.from(macBytes).toString("base64"));
  });

  it("defaults region to us-east-1 when AWS_REGION is not set", async () => {
    kms.on(GenerateMacCommand).resolves({ Mac: new Uint8Array([9]) });
    await computeAnonymousId("u1", { PSEUDONYM_HMAC_KMS_KEY_ID: "k" });
    expect(kms.commandCalls(GenerateMacCommand)).toHaveLength(1);
  });

  it("throws when KMS GenerateMac returns no Mac", async () => {
    kms.on(GenerateMacCommand).resolves({});
    await expect(
      computeAnonymousId("u1", { PSEUDONYM_HMAC_KMS_KEY_ID: "k" }),
    ).rejects.toThrow();
  });

  it("propagates KMS errors (e.g. access denied)", async () => {
    kms.on(GenerateMacCommand).rejects(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
    );
    await expect(
      computeAnonymousId("u1", { PSEUDONYM_HMAC_KMS_KEY_ID: "k" }),
    ).rejects.toThrow(/denied/);
  });
});
