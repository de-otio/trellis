/**
 * The `full` scrub level is a keyed HMAC, not a re-encoding (DP-9).
 *
 * The defect this guards against: `hashed:` + truncated base64 of the raw
 * address string, which base64-decodes straight back to the address.
 */

import { describe, expect, it } from "vitest";
import {
  deriveIpScrubKey,
  getIPAddressWithEnvScrubbing,
  IP_SCRUB_KEY_INFO,
  scrubIPAddress,
  type IPScrubberConfig,
} from "../../src/lib/ip-scrubber.js";
import { deriveSubKey } from "../../src/lib/field-encryption.js";

const SECRET_A = "ip-scrub-master-secret-A-at-least-32-chars";
const SECRET_B = "ip-scrub-master-secret-B-at-least-32-chars";

function fullConfig(hmacKey?: Buffer): IPScrubberConfig {
  return { enabled: true, level: "full", preserveForRateLimit: false, hmacKey };
}

describe("scrubIPAddress level=full", () => {
  const key = deriveSubKey(SECRET_A, IP_SCRUB_KEY_INFO);

  it("is deterministic for the same IP under the same key", () => {
    expect(scrubIPAddress("203.0.113.7", fullConfig(key))).toBe(
      scrubIPAddress("203.0.113.7", fullConfig(key)),
    );
  });

  it("differs under a different secret", () => {
    const other = deriveSubKey(SECRET_B, IP_SCRUB_KEY_INFO);
    expect(scrubIPAddress("203.0.113.7", fullConfig(key))).not.toBe(
      scrubIPAddress("203.0.113.7", fullConfig(other)),
    );
  });

  it("differs for different IPs", () => {
    expect(scrubIPAddress("203.0.113.7", fullConfig(key))).not.toBe(
      scrubIPAddress("203.0.113.8", fullConfig(key)),
    );
  });

  it("is not reversible: the payload is hex, and decoding it does not yield the address", () => {
    const ip = "203.0.113.7";
    const out = scrubIPAddress(ip, fullConfig(key));
    expect(out).toMatch(/^hashed:[0-9a-f]{32}$/);
    const payload = out.slice("hashed:".length);
    // The old implementation's payload base64-decoded to the address bytes.
    expect(Buffer.from(payload, "base64").toString("utf8")).not.toContain("203.0.113");
    expect(Buffer.from(payload, "hex").toString("utf8")).not.toContain("203.0.113");
    expect(out).not.toContain(ip);
  });

  it("refuses to run without a key rather than degrade (fail closed)", () => {
    expect(() => scrubIPAddress("203.0.113.7", fullConfig(undefined))).toThrow(/requires a 32-byte HMAC key/);
    expect(() => scrubIPAddress("203.0.113.7", fullConfig(Buffer.alloc(8)))).toThrow(/32-byte/);
  });
});

describe("deriveIpScrubKey", () => {
  it("prefers IP_SCRUB_HMAC_SECRET over SESSION_SECRET", () => {
    const dedicated = deriveIpScrubKey({ IP_SCRUB_HMAC_SECRET: SECRET_A, SESSION_SECRET: SECRET_B });
    expect(dedicated.equals(deriveSubKey(SECRET_A, IP_SCRUB_KEY_INFO))).toBe(true);
  });

  it("falls back to SESSION_SECRET through HKDF, never the raw bytes", () => {
    const k = deriveIpScrubKey({ SESSION_SECRET: SECRET_B });
    expect(k.equals(deriveSubKey(SECRET_B, IP_SCRUB_KEY_INFO))).toBe(true);
    expect(k.equals(Buffer.from(SECRET_B, "utf8").subarray(0, 32))).toBe(false);
  });

  it("throws when neither secret is present", () => {
    expect(() => deriveIpScrubKey({})).toThrow(/IP_SCRUB_HMAC_SECRET/);
  });

  it("refuses a short master (field-encryption strength floor)", () => {
    expect(() => deriveIpScrubKey({ SESSION_SECRET: "short" })).toThrow(/at least 32 characters/);
  });
});

describe("getIPAddressWithEnvScrubbing level=full", () => {
  const request = new Request("https://example.com", {
    headers: { "CF-Connecting-IP": "203.0.113.7" },
  });

  it("derives the key from the environment and produces a keyed pseudonym", () => {
    const out = getIPAddressWithEnvScrubbing(request, {
      IP_SCRUBBING_ENABLED: "true",
      IP_SCRUBBING_LEVEL: "full",
      IP_SCRUB_HMAC_SECRET: SECRET_A,
    });
    const expected = scrubIPAddress(
      "203.0.113.7",
      fullConfig(deriveSubKey(SECRET_A, IP_SCRUB_KEY_INFO)),
    );
    expect(out).toBe(expected);
  });

  it("throws when full is selected with no secret available", () => {
    expect(() =>
      getIPAddressWithEnvScrubbing(request, {
        IP_SCRUBBING_ENABLED: "true",
        IP_SCRUBBING_LEVEL: "full",
      }),
    ).toThrow(/IP_SCRUB_HMAC_SECRET/);
  });

  it("does not need a secret for partial or none", () => {
    expect(
      getIPAddressWithEnvScrubbing(request, {
        IP_SCRUBBING_ENABLED: "true",
        IP_SCRUBBING_LEVEL: "partial",
      }),
    ).toBe("203.0.113.x");
  });
});
