/**
 * Unit tests: software HMAC-SHA256 MAC fallback (WS-5, redesign 02 §5).
 *
 * Fixed vectors from RFC 4231 (HMAC-SHA-256 test cases) pin the
 * primitive; the pseudonym integration is checked end-to-end through
 * `computeAnonymousId` with the software provider wired.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configurePseudonymMacFromEnv,
  createSoftwareMacComputer,
  macEqual,
  MIN_HMAC_KEY_BYTES,
  softwareHmacSha256,
} from "../../../src/lib/crypto/software-hmac-mac.js";
import {
  computeAnonymousId,
  PSEUDONYM_DOMAIN,
  _resetMacComputerForTest,
} from "../../../src/lib/pseudonym.js";

afterEach(() => {
  _resetMacComputerForTest();
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("softwareHmacSha256 — RFC 4231 fixed vectors", () => {
  it("test case 1 (20-byte 0x0b key, 'Hi There')", () => {
    const key = Buffer.alloc(20, 0x0b);
    const mac = softwareHmacSha256(key, Buffer.from("Hi There", "utf8"));
    expect(hex(mac)).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("test case 2 ('Jefe' key)", () => {
    const mac = softwareHmacSha256(
      Buffer.from("Jefe", "utf8"),
      Buffer.from("what do ya want for nothing?", "utf8"),
    );
    expect(hex(mac)).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("test case 6 (131-byte 0xaa key, larger-than-block-size)", () => {
    const key = Buffer.alloc(131, 0xaa);
    const mac = softwareHmacSha256(
      key,
      Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First", "utf8"),
    );
    expect(hex(mac)).toBe(
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    );
  });
});

describe("macEqual — constant-time compare", () => {
  const mac = softwareHmacSha256(Buffer.alloc(32, 1), Buffer.from("m"));

  it("equal MACs compare true", () => {
    expect(macEqual(mac, Uint8Array.from(mac))).toBe(true);
  });

  it("a single flipped bit compares false", () => {
    const tampered = Uint8Array.from(mac);
    tampered[0] ^= 0x01;
    expect(macEqual(mac, tampered)).toBe(false);
  });

  it("length mismatch compares false (no throw)", () => {
    expect(macEqual(mac, mac.slice(0, 16))).toBe(false);
  });
});

describe("createSoftwareMacComputer", () => {
  it("ignores kmsKeyId/region and keys from the resolver", async () => {
    const key = Buffer.alloc(32, 7);
    const computer = createSoftwareMacComputer(async () => key);
    const message = Buffer.from("payload");
    const mac = await computer("ignored-key-id", "ignored-region", message);
    expect(hex(mac)).toBe(
      createHmac("sha256", key).update(message).digest("hex"),
    );
  });

  it("re-resolves the key per call (rotation within the secret-port TTL)", async () => {
    const keys = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    let call = 0;
    const computer = createSoftwareMacComputer(async () => keys[call++]);
    const m = Buffer.from("m");
    const mac1 = await computer("", "", m);
    const mac2 = await computer("", "", m);
    expect(hex(mac1)).not.toBe(hex(mac2));
  });

  it("fails closed on a short key", async () => {
    const computer = createSoftwareMacComputer(async () =>
      Buffer.alloc(MIN_HMAC_KEY_BYTES - 1, 1),
    );
    await expect(computer("", "", Buffer.from("m"))).rejects.toThrow(/too short/);
  });
});

describe("configurePseudonymMacFromEnv", () => {
  it("leaves the KMS default in place when unset or kms", () => {
    expect(configurePseudonymMacFromEnv({})).toBe(false);
    expect(configurePseudonymMacFromEnv({ PSEUDONYM_MAC_PROVIDER: "kms" })).toBe(false);
  });

  it("wires the B64 key path end-to-end through computeAnonymousId", async () => {
    const key = Buffer.alloc(32, 0x42);
    const installed = configurePseudonymMacFromEnv({
      PSEUDONYM_MAC_PROVIDER: "software",
      PSEUDONYM_HMAC_SECRET_B64: key.toString("base64"),
    });
    expect(installed).toBe(true);

    const anonymousId = await computeAnonymousId("user-cuid-1", {
      PSEUDONYM_MAC_PROVIDER: "software",
    });
    const expected = createHmac("sha256", key)
      .update(`${PSEUDONYM_DOMAIN}user-cuid-1`)
      .digest("base64");
    expect(anonymousId).toBe(expected);
  });

  it("wires the Secret Manager name path with the documented ref fields", async () => {
    const key = Buffer.alloc(32, 0x99);
    const resolveSecretBytes = vi.fn(async () => key);
    configurePseudonymMacFromEnv(
      {
        PSEUDONYM_MAC_PROVIDER: "software",
        PSEUDONYM_HMAC_SECRET_NAME: "pseudonym-hmac-key",
        PSEUDONYM_HMAC_SECRET_PATH: "/trellis/dev",
        SCW_DEFAULT_PROJECT_ID: "proj-1",
        SCW_REGION: "nl-ams",
      },
      { resolveSecretBytes },
    );

    const anonymousId = await computeAnonymousId("user-cuid-2", {
      PSEUDONYM_MAC_PROVIDER: "software",
    });
    expect(resolveSecretBytes).toHaveBeenCalledWith({
      name: "pseudonym-hmac-key",
      path: "/trellis/dev",
      projectId: "proj-1",
      region: "nl-ams",
    });
    expect(anonymousId).toBe(
      createHmac("sha256", key)
        .update(`${PSEUDONYM_DOMAIN}user-cuid-2`)
        .digest("base64"),
    );
  });

  it("fails closed: software mode with no key source throws", () => {
    expect(() =>
      configurePseudonymMacFromEnv({ PSEUDONYM_MAC_PROVIDER: "software" }),
    ).toThrow(/no key source/);
  });

  it("fails closed: short B64 key throws", () => {
    expect(() =>
      configurePseudonymMacFromEnv({
        PSEUDONYM_MAC_PROVIDER: "software",
        PSEUDONYM_HMAC_SECRET_B64: Buffer.alloc(16, 1).toString("base64"),
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("computeAnonymousId fail-safe gate (unchanged for KMS deployments)", () => {
  it("still throws without a KMS key when software mode is not selected", async () => {
    await expect(computeAnonymousId("user-1", {})).rejects.toThrow(
      /PSEUDONYM_HMAC_KMS_KEY_ID not configured/,
    );
  });
});
