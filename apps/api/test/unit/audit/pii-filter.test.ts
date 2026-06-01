/**
 * Unit suite for `pii-filter.ts` — allowlist-based PII redaction for audit logs.
 *
 * CONTRACT this suite locks:
 *  1. Claim *names* (keys) are safe to store; claim *values* must never reach
 *     durable audit storage unless their key is on PII_ALLOWED_FIELDS.
 *  2. Non-allowlisted keys are replaced with the literal "<redacted>" and
 *     counted; they are NOT deleted — the key itself is preserved as evidence.
 *  3. Custom allowedFields sets override the default set completely.
 *  4. `deviceCodeHash` stays OFF the allowlist permanently — re-adding it
 *     would create a confirmation-oracle security regression (G4 MEDIUM-6/N2).
 *  5. anonymizeIp truncates IPv4 to /24 and IPv6 to /64 for GDPR compliance;
 *     non-IP strings and the sentinel "unknown" pass through unchanged.
 *
 * A failure in any assertion here is a potential PII leak to durable storage.
 */

import { describe, expect, it } from "vitest";
import {
  filterPayload,
  anonymizeIp,
  PII_ALLOWED_FIELDS,
} from "../../../src/lib/audit/pii-filter.js";

// ─── PII_ALLOWED_FIELDS membership ───────────────────────────────────────────

describe("PII_ALLOWED_FIELDS", () => {
  it("contains expected safe structural keys", () => {
    const requiredKeys = [
      "tenantId",
      "actorUserId",
      "targetUserId",
      "role",
      "region",
      "dataRegion",
      "requestedRegion",
      "actualDataRegion",
      "source",
      "reason",
      "type",
      "slug",
    ];
    for (const key of requiredKeys) {
      expect(PII_ALLOWED_FIELDS.has(key), `expected "${key}" to be allowed`).toBe(true);
    }
  });

  it("does NOT contain deviceCodeHash (confirmation-oracle regression guard)", () => {
    // G4 MEDIUM-6/N2: deviceCodeHash must remain off the allowlist.
    // If this fails, a security regression has been introduced.
    expect(PII_ALLOWED_FIELDS.has("deviceCodeHash")).toBe(false);
  });
});

// ─── filterPayload: basic pass-through ───────────────────────────────────────

describe("filterPayload — allowlisted keys pass through unchanged", () => {
  it("passes tenantId value through unchanged", () => {
    const { filtered, droppedCount } = filterPayload({ tenantId: "t-123" });
    expect(filtered.tenantId).toBe("t-123");
    expect(droppedCount).toBe(0);
  });

  it("passes actorUserId value through unchanged", () => {
    const { filtered, droppedCount } = filterPayload({ actorUserId: "u-456" });
    expect(filtered.actorUserId).toBe("u-456");
    expect(droppedCount).toBe(0);
  });

  it("passes role value through unchanged", () => {
    const { filtered, droppedCount } = filterPayload({ role: "ADMIN" });
    expect(filtered.role).toBe("ADMIN");
    expect(droppedCount).toBe(0);
  });

  it("passes region value through unchanged", () => {
    const { filtered, droppedCount } = filterPayload({ region: "EU" });
    expect(filtered.region).toBe("EU");
    expect(droppedCount).toBe(0);
  });

  it("passes multiple allowlisted keys through with droppedCount 0", () => {
    const payload = {
      tenantId: "t-abc",
      actorUserId: "u-def",
      role: "MEMBER",
      region: "US",
      source: "web",
    };
    const { filtered, droppedCount } = filterPayload(payload);
    expect(droppedCount).toBe(0);
    expect(filtered).toEqual(payload);
  });
});

// ─── filterPayload: non-allowlisted keys are redacted ────────────────────────

describe("filterPayload — non-allowlisted keys are replaced with <redacted>", () => {
  it("replaces a single non-allowlisted key with the literal <redacted>", () => {
    const { filtered, droppedCount } = filterPayload({ email: "alice@example.com" });
    expect(filtered.email).toBe("<redacted>");
    expect(droppedCount).toBe(1);
  });

  it("increments droppedCount by 1 per dropped key", () => {
    const payload = {
      username: "alice",
      phoneNumber: "+1-555-0100",
      ssn: "000-00-0000",
    };
    const { droppedCount } = filterPayload(payload);
    expect(droppedCount).toBe(3);
  });

  it("keeps the key present with value <redacted> (does NOT delete it)", () => {
    const { filtered } = filterPayload({ secretToken: "tok_live_abc123" });
    expect(Object.prototype.hasOwnProperty.call(filtered, "secretToken")).toBe(true);
    expect(filtered.secretToken).toBe("<redacted>");
  });

  it("does not include the original value when redacting", () => {
    const sensitiveValue = "very-secret-password-123";
    const { filtered } = filterPayload({ password: sensitiveValue });
    // Value must never appear in filtered output — not even as a substring
    const outputStr = JSON.stringify(filtered);
    expect(outputStr).not.toContain(sensitiveValue);
    expect(filtered.password).toBe("<redacted>");
  });
});

// ─── filterPayload: mixed payloads ───────────────────────────────────────────

describe("filterPayload — mixed allowed + non-allowlisted keys", () => {
  it("2 allowed + 3 dropped → droppedCount 3, correct masking", () => {
    const payload = {
      tenantId: "t-001",          // allowed
      actorUserId: "u-002",       // allowed
      email: "user@example.com",  // NOT allowed
      name: "Jane Doe",           // NOT allowed
      phoneNumber: "+1-555-0100", // NOT allowed
    };
    const { filtered, droppedCount } = filterPayload(payload);

    expect(droppedCount).toBe(3);

    // Allowed keys preserved
    expect(filtered.tenantId).toBe("t-001");
    expect(filtered.actorUserId).toBe("u-002");

    // Non-allowed keys present but masked
    expect(filtered.email).toBe("<redacted>");
    expect(filtered.name).toBe("<redacted>");
    expect(filtered.phoneNumber).toBe("<redacted>");
  });

  it("returns all 5 keys in the output (none deleted)", () => {
    const payload = {
      tenantId: "t-001",
      actorUserId: "u-002",
      email: "user@example.com",
      name: "Jane Doe",
      phoneNumber: "+1-555-0100",
    };
    const { filtered } = filterPayload(payload);
    expect(Object.keys(filtered)).toHaveLength(5);
  });
});

// ─── filterPayload: empty payload ─────────────────────────────────────────────

describe("filterPayload — empty payload", () => {
  it("returns { filtered: {}, droppedCount: 0 } for an empty object", () => {
    const { filtered, droppedCount } = filterPayload({});
    expect(filtered).toEqual({});
    expect(droppedCount).toBe(0);
  });
});

// ─── filterPayload: custom allowedFields ──────────────────────────────────────

describe("filterPayload — custom allowedFields override", () => {
  it("uses the supplied set instead of PII_ALLOWED_FIELDS", () => {
    const customAllowed = new Set(["customKey", "anotherKey"]);
    const payload = {
      customKey: "safe-value",
      anotherKey: "also-safe",
      tenantId: "t-001", // would be allowed by default but not by customAllowed
    };
    const { filtered, droppedCount } = filterPayload(payload, customAllowed);

    expect(filtered.customKey).toBe("safe-value");
    expect(filtered.anotherKey).toBe("also-safe");
    expect(filtered.tenantId).toBe("<redacted>"); // NOT in customAllowed
    expect(droppedCount).toBe(1);
  });

  it("an empty custom allowedFields set redacts everything", () => {
    const payload = { tenantId: "t-001", role: "ADMIN", source: "api" };
    const { filtered, droppedCount } = filterPayload(payload, new Set());
    expect(droppedCount).toBe(3);
    for (const val of Object.values(filtered)) {
      expect(val).toBe("<redacted>");
    }
  });
});

// ─── filterPayload: falsy/typed allowed values ────────────────────────────────

describe("filterPayload — falsy values for allowed keys pass through unchanged", () => {
  it("passes 0 (number zero) through for an allowed key", () => {
    const { filtered, droppedCount } = filterPayload({ tenantId: 0 as unknown as string });
    expect(filtered.tenantId).toBe(0);
    expect(droppedCount).toBe(0);
  });

  it("passes false (boolean) through for an allowed key", () => {
    const { filtered, droppedCount } = filterPayload({ role: false as unknown as string });
    expect(filtered.role).toBe(false);
    expect(droppedCount).toBe(0);
  });

  it("passes null through for an allowed key", () => {
    const { filtered, droppedCount } = filterPayload({ source: null as unknown as string });
    expect(filtered.source).toBeNull();
    expect(droppedCount).toBe(0);
  });

  it("passes empty string through for an allowed key", () => {
    const { filtered, droppedCount } = filterPayload({ reason: "" });
    expect(filtered.reason).toBe("");
    expect(droppedCount).toBe(0);
  });
});

// ─── REGRESSION GUARD: deviceCodeHash must stay redacted ─────────────────────

describe("REGRESSION GUARD — deviceCodeHash is never allowed through", () => {
  it("redacts deviceCodeHash even if explicitly provided (confirmation-oracle guard)", () => {
    // G4 MEDIUM-6/N2: a raw device_code that leaks elsewhere could be
    // confirmed via audit logs if this key were on the allowlist.
    const hash = "sha256:abcdef1234567890";
    const { filtered, droppedCount } = filterPayload({ deviceCodeHash: hash });

    expect(filtered.deviceCodeHash).toBe("<redacted>");
    expect(droppedCount).toBe(1);
    // The actual hash value must never appear in the output
    expect(JSON.stringify(filtered)).not.toContain(hash);
  });

  it("redacts deviceCodeHash even when mixed with allowed fields", () => {
    const payload = {
      tenantId: "t-001",
      actorUserId: "u-002",
      deviceCodeHash: "sha256:secret",
    };
    const { filtered, droppedCount } = filterPayload(payload);

    expect(filtered.tenantId).toBe("t-001");
    expect(filtered.actorUserId).toBe("u-002");
    expect(filtered.deviceCodeHash).toBe("<redacted>");
    expect(droppedCount).toBe(1);
  });
});

// ─── anonymizeIp ─────────────────────────────────────────────────────────────

describe("anonymizeIp — IPv4", () => {
  it("truncates last octet to 0 and appends /24", () => {
    expect(anonymizeIp("203.0.113.4")).toBe("203.0.113.0/24");
  });

  it("truncates a different IPv4 address correctly", () => {
    expect(anonymizeIp("192.168.1.255")).toBe("192.168.1.0/24");
  });

  it("preserves the first three octets exactly", () => {
    const result = anonymizeIp("10.20.30.40");
    expect(result).toBe("10.20.30.0/24");
  });

  it("handles 0.0.0.0 correctly", () => {
    expect(anonymizeIp("0.0.0.0")).toBe("0.0.0.0/24");
  });
});

describe("anonymizeIp — IPv6", () => {
  it("keeps first 4 groups and appends ::/64", () => {
    expect(anonymizeIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  });

  it("handles a full 8-group IPv6 address", () => {
    expect(anonymizeIp("fe80:0:0:0:1:2:3:4")).toBe("fe80:0:0:0::/64");
  });

  it("retains the first 4 groups only, discarding the rest", () => {
    const result = anonymizeIp("2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff");
    expect(result).toBe("2001:db8:aaaa:bbbb::/64");
  });
});

describe("anonymizeIp — sentinel and non-IP strings", () => {
  it('passes "unknown" through unchanged', () => {
    expect(anonymizeIp("unknown")).toBe("unknown");
  });

  it('passes empty string "" through unchanged', () => {
    expect(anonymizeIp("")).toBe("");
  });

  it("passes a non-IP string through unchanged", () => {
    // Not an IP address — should be returned as-is
    expect(anonymizeIp("not-an-ip-address")).toBe("not-an-ip-address");
  });

  it("passes a plain hostname through unchanged", () => {
    expect(anonymizeIp("localhost")).toBe("localhost");
  });
});
