/**
 * L3 — federation canonical URIs come from ACTIVITYPUB_BASE_URL only, and a
 * federation route reached under a different Host is refused.
 */

import { describe, expect, it } from "vitest";
import {
  applyFederationHostGuard,
  buildFederationHostGuard,
  getActivityPubBaseUrl,
  isFederationPath,
} from "../../../../src/lib/activitypub/fedify/context.js";

const env = (o: Record<string, string | undefined>) => o as never;

describe("getActivityPubBaseUrl", () => {
  it("ACTIVITYPUB_BASE_URL wins over the request URL (Host / http:// cannot be baked in)", () => {
    expect(
      getActivityPubBaseUrl(
        env({ ACTIVITYPUB_BASE_URL: "https://social.example" }),
        "http://evil.test/users/alice",
      ),
    ).toBe("https://social.example");
  });

  it("ACTIVITYPUB_BASE_URL wins over APP_DOMAIN", () => {
    expect(
      getActivityPubBaseUrl(
        env({ ACTIVITYPUB_BASE_URL: "https://social.example", APP_DOMAIN: "https://other.example" }),
      ),
    ).toBe("https://social.example");
  });

  it("unset base URL keeps the legacy order: requestUrl, APP_DOMAIN, placeholder", () => {
    expect(getActivityPubBaseUrl(env({ APP_DOMAIN: "https://app.example" }), "http://req.test/x")).toBe(
      "http://req.test",
    );
    expect(getActivityPubBaseUrl(env({ APP_DOMAIN: "https://app.example" }))).toBe("https://app.example");
    expect(getActivityPubBaseUrl(env({}))).toBe("https://example.com");
  });

  it("an unparseable base URL falls through to the legacy order", () => {
    expect(getActivityPubBaseUrl(env({ ACTIVITYPUB_BASE_URL: "not a url", APP_DOMAIN: "https://app.example" }))).toBe(
      "https://app.example",
    );
  });
});

describe("isFederationPath", () => {
  it("matches federation prefixes, not the authenticated /api surface", () => {
    for (const p of [
      "/.well-known/webfinger",
      "/.well-known/nodeinfo",
      "/users/alice",
      "/users/alice/inbox",
      "/groups/g1/outbox",
      "/entities/dog/1",
      "/posts/p1",
      "/messages/m1",
      "/audiences/a1",
    ]) {
      expect(isFederationPath(p), p).toBe(true);
    }
    for (const p of ["/", "/health", "/api/messages", "/api/audiences", "/.well-known/webfingerx", "/auth/login"]) {
      expect(isFederationPath(p), p).toBe(false);
    }
  });

  it("is not sidestepped by percent-encoding a prefix character", () => {
    expect(isFederationPath("/%75sers/alice")).toBe(true);
    expect(isFederationPath("/%2e%77ell-known/webfinger")).toBe(true);
    expect(isFederationPath("/users%2Falice")).toBe(false);
  });
});

describe("buildFederationHostGuard", () => {
  it("is a no-op unless federation is enabled AND a valid base URL is configured", () => {
    expect(buildFederationHostGuard("https://social.example", undefined, false)).toBeUndefined();
    expect(buildFederationHostGuard(undefined, undefined, true)).toBeUndefined();
    expect(buildFederationHostGuard("garbage", undefined, true)).toBeUndefined();
    expect(buildFederationHostGuard("ftp://social.example", undefined, true)).toBeUndefined();
  });

  it("allows the base host plus any ACTIVITYPUB_ALLOWED_HOSTS entries", () => {
    const g = buildFederationHostGuard("https://Social.Example:8443", " A.example , ,b.example", true);
    expect(g?.origin).toBe("https://social.example:8443");
    expect([...(g?.allowedHosts ?? [])].sort()).toEqual(["a.example", "b.example", "social.example"]);
  });
});

describe("applyFederationHostGuard", () => {
  const guard = buildFederationHostGuard("https://social.example", undefined, true);

  it("no guard → no opinion (federation off / unset base URL behaves as today)", () => {
    expect(applyFederationHostGuard(undefined, "/users/alice", "evil.test")).toEqual({ ok: true, url: undefined });
  });

  it("non-federation path → no opinion, whatever the Host", () => {
    expect(applyFederationHostGuard(guard, "/health", "anything.test")).toEqual({ ok: true, url: undefined });
    expect(applyFederationHostGuard(guard, "/api/messages", "anything.test")).toEqual({ ok: true, url: undefined });
  });

  it("federation path with the configured Host → URL rebuilt on the canonical https origin", () => {
    for (const host of ["social.example", "SOCIAL.example:443", "social.example."]) {
      const d = applyFederationHostGuard(guard, "/users/alice?x=1", host);
      expect(d.ok).toBe(true);
      expect(d.ok && d.url?.href).toBe("https://social.example/users/alice?x=1");
    }
  });

  it("federation path with a foreign, missing or malformed Host → refused", () => {
    for (const host of [
      "evil.test",
      "social.example.evil.test",
      "evil.test/social.example",
      "social.example@evil.test",
      "",
      undefined,
    ]) {
      expect(applyFederationHostGuard(guard, "/users/alice", host), String(host)).toEqual({
        ok: false,
        reason: "host-mismatch",
      });
    }
  });

  it("encoded federation prefix is still gated", () => {
    expect(applyFederationHostGuard(guard, "/%75sers/alice", "evil.test").ok).toBe(false);
  });

  it("an absolute-form request target cannot smuggle another origin through", () => {
    const d = applyFederationHostGuard(guard, "http://evil.test/users/alice", "social.example");
    expect(d.ok && d.url?.href).toBe("https://social.example/users/alice");
  });

  it("an extra allowed host passes but still canonicalises onto the base origin", () => {
    const g = buildFederationHostGuard("https://social.example", "internal.lb", true);
    const d = applyFederationHostGuard(g, "/.well-known/webfinger?resource=x", "internal.lb");
    expect(d.ok && d.url?.href).toBe("https://social.example/.well-known/webfinger?resource=x");
  });
});
