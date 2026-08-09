/**
 * Unit tests: bounded client-version parsing, comparison, policy resolution,
 * gate decisions, and telemetry cardinality (lib/client-version.ts).
 *
 * The properties that matter here are safety properties: the parser must
 * terminate and never throw on hostile input, the comparison must not lock out
 * a client running exactly the minimum, and no caller-controlled string may
 * ever become a metric dimension.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CLIENT_VERSION_METRICS,
  ClientVersionTelemetry,
  MAX_CLIENT_VERSION_LENGTH,
  UPGRADE_REQUIRED_BODY,
  compareClientVersions,
  evaluateClientVersionGate,
  formatClientVersion,
  isAllowedStoreUrl,
  isVersionGateExemptPath,
  normalizeClientPlatform,
  parseClientVersion,
  resolveVersionPolicy,
} from "../../src/lib/client-version.js";
import { CapturingMetrics } from "../../src/lib/workers/metrics-port.js";

describe("parseClientVersion", () => {
  it("parses a plain x.y.z", () => {
    expect(parseClientVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("parses and discards a pre-release or build suffix", () => {
    expect(parseClientVersion("1.2.3-beta.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
    expect(parseClientVersion("1.2.3+build.77")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  it("accepts up to four digits per component", () => {
    expect(parseClientVersion("9999.9999.9999")).toEqual({
      major: 9999,
      minor: 9999,
      patch: 9999,
    });
    expect(parseClientVersion("10000.0.0")).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["1.2", "two components"],
    ["1.2.3.4", "four components"],
    ["v1.2.3", "leading v"],
    ["1.2.3 ", "trailing space"],
    [" 1.2.3", "leading space"],
    ["1.2.3\n", "trailing newline (the $ anchor would otherwise allow it)"],
    ["1.2.x", "non-numeric component"],
    ["-1.2.3", "negative"],
    ["1.2.3_beta", "suffix without a + or - separator"],
  ])("rejects %j (%s)", (raw) => {
    expect(parseClientVersion(raw)).toBeNull();
  });

  it("rejects null/undefined/non-strings without throwing", () => {
    expect(parseClientVersion(null)).toBeNull();
    expect(parseClientVersion(undefined)).toBeNull();
    expect(parseClientVersion(123 as unknown as string)).toBeNull();
  });

  it("rejects anything longer than the cap BEFORE running the regex", () => {
    const overLong = `1.2.3-${"a".repeat(MAX_CLIENT_VERSION_LENGTH)}`;
    expect(overLong.length).toBeGreaterThan(MAX_CLIENT_VERSION_LENGTH);
    expect(parseClientVersion(overLong)).toBeNull();
    // Exactly at the cap still parses.
    const atCap = `1.2.3-${"a".repeat(MAX_CLIENT_VERSION_LENGTH - 6)}`;
    expect(atCap.length).toBe(MAX_CLIENT_VERSION_LENGTH);
    expect(parseClientVersion(atCap)).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  describe("property: hostile input", () => {
    it("never throws and terminates for arbitrary strings", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 512 }), (raw) => {
          const started = Date.now();
          const result = parseClientVersion(raw);
          // Termination: an unbounded/backtracking pattern on a 512-char
          // adversarial input is what this guards against.
          expect(Date.now() - started).toBeLessThan(1000);
          return result === null || typeof result.major === "number";
        }),
        { numRuns: 500 },
      );
    });

    it("returns null for every string that is not a bounded x.y.z", () => {
      const canonical = /^\d{1,4}\.\d{1,4}\.\d{1,4}([+-][\s\S]*)?$/;
      const controlChars = /[\u0000-\u001f\u007f]/;
      fc.assert(
        fc.property(fc.string({ maxLength: 80 }), (raw) => {
          const parsed = parseClientVersion(raw);
          const shouldMatch =
            raw.length > 0 &&
            raw.length <= MAX_CLIENT_VERSION_LENGTH &&
            !controlChars.test(raw) &&
            canonical.test(raw);
          return shouldMatch ? parsed !== null : parsed === null;
        }),
        { numRuns: 1000 },
      );
    });

    it("round-trips: a parsed version re-serializes to a parseable version", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 9999 }),
          fc.integer({ min: 0, max: 9999 }),
          fc.integer({ min: 0, max: 9999 }),
          (major, minor, patch) => {
            const raw = `${major}.${minor}.${patch}`;
            const parsed = parseClientVersion(raw);
            expect(parsed).not.toBeNull();
            return formatClientVersion(parsed!) === raw;
          },
        ),
      );
    });
  });
});

describe("compareClientVersions", () => {
  const v = (s: string) => parseClientVersion(s)!;

  it("orders by major, then minor, then patch", () => {
    expect(compareClientVersions(v("1.0.0"), v("2.0.0"))).toBe(-1);
    expect(compareClientVersions(v("2.0.0"), v("1.9.9"))).toBe(1);
    expect(compareClientVersions(v("1.2.0"), v("1.10.0"))).toBe(-1);
    expect(compareClientVersions(v("1.2.10"), v("1.2.9"))).toBe(1);
  });

  it("treats an equal triple as EQUAL (the boundary that must not lock out)", () => {
    expect(compareClientVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
    expect(compareClientVersions(v("1.2.3-beta"), v("1.2.3"))).toBe(0);
  });

  it("property: antisymmetric and total", () => {
    const version = fc.tuple(
      fc.integer({ min: 0, max: 9999 }),
      fc.integer({ min: 0, max: 9999 }),
      fc.integer({ min: 0, max: 9999 }),
    );
    fc.assert(
      fc.property(version, version, ([aM, am, ap], [bM, bm, bp]) => {
        const a = { major: aM, minor: am, patch: ap };
        const b = { major: bM, minor: bm, patch: bp };
        return compareClientVersions(a, b) === -compareClientVersions(b, a);
      }),
    );
  });
});

describe("normalizeClientPlatform", () => {
  it.each([
    ["android", "android"],
    ["ios", "ios"],
    ["web", "web"],
    ["IOS", "ios"],
    [" Android ", "android"],
  ])("coerces %j to %j", (raw, expected) => {
    expect(normalizeClientPlatform(raw)).toBe(expected);
  });

  it.each([null, undefined, "", "windows", "a".repeat(64)])(
    "collapses %j to other",
    (raw) => {
      expect(normalizeClientPlatform(raw as string | null | undefined)).toBe(
        "other",
      );
    },
  );
});

describe("isAllowedStoreUrl", () => {
  it("accepts https URLs on the two store hosts", () => {
    expect(
      isAllowedStoreUrl("https://play.google.com/store/apps/details?id=org.example.app"),
    ).toBe(true);
    expect(isAllowedStoreUrl("https://apps.apple.com/app/id123456789")).toBe(true);
  });

  it.each([
    ["http://play.google.com/store", "plain http"],
    ["https://play.google.com.evil.example/store", "look-alike host"],
    ["https://example.com/store", "unrelated host"],
    ["market://details?id=org.example.app", "non-https scheme"],
    ["javascript:alert(1)", "script scheme"],
    ["not a url", "not a URL at all"],
    ["", "empty"],
  ])("rejects %j (%s)", (raw) => {
    expect(isAllowedStoreUrl(raw)).toBe(false);
  });
});

describe("resolveVersionPolicy", () => {
  it("returns all nulls when nothing is configured (the shipped default)", () => {
    expect(resolveVersionPolicy({})).toEqual({
      minimumVersion: null,
      recommendedVersion: null,
      storeUrls: { android: null, ios: null },
    });
  });

  it("serves configured values, re-serialized from the parsed triple", () => {
    expect(
      resolveVersionPolicy({
        CLIENT_MIN_SUPPORTED_VERSION: "1.0.0",
        CLIENT_RECOMMENDED_VERSION: "1.2.0-rc.1",
        CLIENT_STORE_URL_ANDROID:
          "https://play.google.com/store/apps/details?id=org.example.app",
        CLIENT_STORE_URL_IOS: "https://apps.apple.com/app/id123456789",
      }),
    ).toEqual({
      minimumVersion: "1.0.0",
      // The suffix is dropped: the served value is the comparable triple.
      recommendedVersion: "1.2.0",
      storeUrls: {
        android: "https://play.google.com/store/apps/details?id=org.example.app",
        ios: "https://apps.apple.com/app/id123456789",
      },
    });
  });

  it("degrades unparseable/disallowed values to null rather than serving them", () => {
    expect(
      resolveVersionPolicy({
        CLIENT_MIN_SUPPORTED_VERSION: "garbage",
        CLIENT_STORE_URL_ANDROID: "https://evil.example/app",
      }),
    ).toEqual({
      minimumVersion: null,
      recommendedVersion: null,
      storeUrls: { android: null, ios: null },
    });
  });
});

describe("isVersionGateExemptPath", () => {
  it.each([
    "/health",
    "/api/app/version-policy",
    "/.well-known/webfinger",
    "/users/alice",
    "/users/alice/inbox",
    "/groups/g1/outbox",
    "/posts/p1",
    "/messages/m1",
    "/audiences/a1",
    "/entities/dog/e1",
  ])("exempts %s", (pathname) => {
    expect(isVersionGateExemptPath(pathname)).toBe(true);
  });

  it.each(["/api/posts", "/api/entities/e1", "/api/feature-flags", "/openapi.json"])(
    "does not exempt %s",
    (pathname) => {
      expect(isVersionGateExemptPath(pathname)).toBe(false);
    },
  );
});

describe("evaluateClientVersionGate", () => {
  const armed = { CLIENT_MIN_SUPPORTED_VERSION: "1.2.0" };
  const base = {
    method: "GET",
    pathname: "/api/posts",
    versionHeader: null as string | null,
    platformHeader: "android" as string | null,
    env: armed,
  };

  it("blocks a strictly older client with 426 semantics", () => {
    const decision = evaluateClientVersionGate({ ...base, versionHeader: "1.1.9" });
    expect(decision).toMatchObject({
      outcome: "upgrade-required",
      version: { major: 1, minor: 1, patch: 9 },
      minimum: { major: 1, minor: 2, patch: 0 },
      platform: "android",
    });
  });

  it("ALLOWS a client running exactly the minimum (boundary)", () => {
    expect(
      evaluateClientVersionGate({ ...base, versionHeader: "1.2.0" }),
    ).toMatchObject({ outcome: "allow", reason: "version-supported" });
  });

  it("allows a newer client", () => {
    expect(
      evaluateClientVersionGate({ ...base, versionHeader: "2.0.0" }),
    ).toMatchObject({ outcome: "allow", reason: "version-supported" });
  });

  it("allows when no policy is configured, even for an ancient client", () => {
    expect(
      evaluateClientVersionGate({
        ...base,
        env: {},
        versionHeader: "0.0.1",
      }),
    ).toMatchObject({ outcome: "allow", reason: "policy-unset" });
  });

  it("allows when the header is absent (curl, federation, probes)", () => {
    expect(evaluateClientVersionGate(base)).toMatchObject({
      outcome: "allow",
      reason: "header-absent",
    });
  });

  it("allows when the header is unparseable", () => {
    expect(
      evaluateClientVersionGate({ ...base, versionHeader: "not-a-version" }),
    ).toMatchObject({ outcome: "allow", reason: "header-invalid" });
  });

  it("never blocks an OPTIONS preflight, however old the client claims to be", () => {
    expect(
      evaluateClientVersionGate({
        ...base,
        method: "OPTIONS",
        versionHeader: "0.0.1",
      }),
    ).toMatchObject({ outcome: "allow", reason: "preflight" });
  });

  it.each(["/api/app/version-policy", "/health", "/.well-known/webfinger", "/users/a"])(
    "never blocks the exempt path %s",
    (pathname) => {
      expect(
        evaluateClientVersionGate({ ...base, pathname, versionHeader: "0.0.1" }),
      ).toMatchObject({ outcome: "allow", reason: "exempt-path" });
    },
  );

  it("only ever returns allow or upgrade-required (never a 2xx of its own)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.string({ maxLength: 20 }),
        fc.constantFrom("GET", "POST", "OPTIONS", "DELETE"),
        (versionHeader, platformHeader, method) => {
          const decision = evaluateClientVersionGate({
            method,
            pathname: "/api/posts",
            versionHeader,
            platformHeader,
            env: armed,
          });
          return (
            decision.outcome === "allow" || decision.outcome === "upgrade-required"
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("UPGRADE_REQUIRED_BODY", () => {
  it("is a StructuredError with no URL anywhere in it", () => {
    expect(UPGRADE_REQUIRED_BODY.error).toBe("UPGRADE_REQUIRED");
    expect(UPGRADE_REQUIRED_BODY.message.length).toBeGreaterThan(0);
    expect(UPGRADE_REQUIRED_BODY.remediation.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(UPGRADE_REQUIRED_BODY);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/market:|itms-apps:/);
  });
});

describe("ClientVersionTelemetry", () => {
  it("emits one blob per observation, dimensioned by the parsed triple", () => {
    const port = new CapturingMetrics();
    const telemetry = new ClientVersionTelemetry(port);

    telemetry.record({ major: 1, minor: 2, patch: 3 }, "ios", false);

    expect(port.emitted).toHaveLength(1);
    expect(port.emitted[0].dimensions).toEqual({
      clientVersion: "1.2.3",
      clientPlatform: "ios",
    });
    expect(port.emitted[0].metrics).toEqual([
      { name: CLIENT_VERSION_METRICS.seen, value: 1 },
    ]);
  });

  it("adds the upgrade-required counter to the same blob when blocked", () => {
    const port = new CapturingMetrics();
    new ClientVersionTelemetry(port).record(
      { major: 1, minor: 0, patch: 0 },
      "android",
      true,
    );
    expect(port.emitted[0].metrics).toEqual([
      { name: CLIENT_VERSION_METRICS.seen, value: 1 },
      { name: CLIENT_VERSION_METRICS.upgradeRequired, value: 1 },
    ]);
  });

  it("caps distinct version dimensions and buckets the overflow to other", () => {
    const port = new CapturingMetrics();
    const cap = 100;
    const telemetry = new ClientVersionTelemetry(port, cap);

    // 100 distinct versions fill the cap exactly...
    for (let i = 0; i < cap; i++) {
      telemetry.record({ major: 1, minor: 0, patch: i }, "android", false);
    }
    expect(telemetry.distinctVersionCount).toBe(cap);
    expect(port.emitted[cap - 1].dimensions.clientVersion).toBe(`1.0.${cap - 1}`);

    // ...the 101st distinct version is bucketed.
    telemetry.record({ major: 9, minor: 9, patch: 9 }, "android", false);
    expect(port.emitted[cap].dimensions.clientVersion).toBe("other");
    expect(telemetry.distinctVersionCount).toBe(cap);

    // An already-seen version keeps its own dimension after the cap is hit.
    telemetry.record({ major: 1, minor: 0, patch: 0 }, "android", false);
    expect(port.emitted[cap + 1].dimensions.clientVersion).toBe("1.0.0");
  });

  it("is fail-open: a throwing metrics port never propagates", () => {
    const throwing = {
      emitCounts: () => {
        throw new Error("metrics backend down");
      },
    };
    expect(() =>
      new ClientVersionTelemetry(throwing).record(
        { major: 1, minor: 0, patch: 0 },
        "web",
        true,
      ),
    ).not.toThrow();
  });
});
