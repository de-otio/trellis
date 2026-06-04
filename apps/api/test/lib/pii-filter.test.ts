/**
 * Unit Tests: PII Filter
 */

import { describe, expect, it } from "vitest";
import { filterPayload, anonymizeIp, PII_ALLOWED_FIELDS } from "../../src/lib/audit/pii-filter.js";

describe("filterPayload", () => {
  it("passes through fields that are on the allowlist", () => {
    const { filtered, droppedCount } = filterPayload({
      tenantId: "t1",
      actorUserId: "u1",
      targetUserId: "u2",
      oldRole: "MEMBER",
      newRole: "ADMIN",
    });

    expect(filtered.tenantId).toBe("t1");
    expect(filtered.actorUserId).toBe("u1");
    expect(filtered.targetUserId).toBe("u2");
    expect(filtered.oldRole).toBe("MEMBER");
    expect(filtered.newRole).toBe("ADMIN");
    expect(droppedCount).toBe(0);
  });

  it("redacts fields that are NOT on the allowlist", () => {
    const { filtered, droppedCount } = filterPayload({
      tenantId: "t1",
      email: "alice@example.com",
      password: "hunter2",
      ssn: "123-45-6789",
    });

    expect(filtered.tenantId).toBe("t1");
    expect(filtered.email).toBe("<redacted>");
    expect(filtered.password).toBe("<redacted>");
    expect(filtered.ssn).toBe("<redacted>");
    expect(droppedCount).toBe(3);
  });

  it("returns droppedCount=0 for an empty payload", () => {
    const { filtered, droppedCount } = filterPayload({});
    expect(filtered).toEqual({});
    expect(droppedCount).toBe(0);
  });

  it("redacts claim values while allowing claim names from allowlist", () => {
    const { filtered, droppedCount } = filterPayload({
      domain: "example.com",
      idpStatus: "connected",
      claimValue: "some-sensitive-claim-value",
    });

    expect(filtered.domain).toBe("example.com");
    expect(filtered.idpStatus).toBe("connected");
    expect(filtered.claimValue).toBe("<redacted>");
    expect(droppedCount).toBe(1);
  });

  it("supports a custom allowlist", () => {
    const customAllowlist = new Set(["foo", "bar"]);
    const { filtered, droppedCount } = filterPayload({ foo: "1", bar: "2", baz: "3" }, customAllowlist);

    expect(filtered.foo).toBe("1");
    expect(filtered.bar).toBe("2");
    expect(filtered.baz).toBe("<redacted>");
    expect(droppedCount).toBe(1);
  });

  it("includes all PII_ALLOWED_FIELDS from the catalog", () => {
    const allAllowed = Object.fromEntries(
      [...PII_ALLOWED_FIELDS].map((k) => [k, "test-value"]),
    );
    const { droppedCount } = filterPayload(allAllowed);
    expect(droppedCount).toBe(0);
  });
});

describe("anonymizeIp", () => {
  it("anonymises an IPv4 address to /24", () => {
    expect(anonymizeIp("192.168.1.42")).toBe("192.168.1.0/24");
  });

  it("anonymises a different IPv4 address to /24", () => {
    expect(anonymizeIp("10.0.0.255")).toBe("10.0.0.0/24");
  });

  it("anonymises an IPv6 address to /64", () => {
    expect(anonymizeIp("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3:0::/64");
  });

  it("returns 'unknown' unchanged", () => {
    expect(anonymizeIp("unknown")).toBe("unknown");
  });

  it("returns empty string unchanged", () => {
    expect(anonymizeIp("")).toBe("");
  });

  it("handles a minimal IPv4 address", () => {
    expect(anonymizeIp("1.2.3.4")).toBe("1.2.3.0/24");
  });

  it("returns a malformed IP string unchanged (fallback path)", () => {
    expect(anonymizeIp("not-an-ip")).toBe("not-an-ip");
  });
});
