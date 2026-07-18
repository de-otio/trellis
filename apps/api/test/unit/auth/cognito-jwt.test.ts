/**
 * Unit Tests: jwt wrapper — extractBearerToken + normalizeClaims (WS-3.1).
 *
 * The end-to-end verify path (real crypto, both config modes, golden outcomes)
 * lives in `behavior-comparison.test.ts`. This file covers the pure pieces:
 *   - extractBearerToken
 *   - normalizeClaims: Cognito custom:* → neutral mapping, generic mapping,
 *     and [SEC-8] throw on a missing / empty / non-string sub (never coerce).
 */

import { describe, expect, it } from "vitest";
import { extractBearerToken, normalizeClaims } from "../../../src/lib/auth/cognito-jwt.js";

describe("extractBearerToken", () => {
  it("returns null for null / empty / non-Bearer headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("Token abc")).toBeNull();
  });

  it("extracts the token after 'Bearer '", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("Bearer ")).toBe("");
  });
});

describe("normalizeClaims — Cognito mapping", () => {
  const cognito = (o: Record<string, unknown>) => normalizeClaims("cognito", o);

  it("maps custom:* claims onto neutral fields", () => {
    const c = cognito({
      sub: "abc-123",
      "cognito:username": "alice",
      email: "a@example.com",
      "custom:userId": "cuid-1",
      "custom:globalRole": "B2B_PARTNER",
      "custom:activeTenantId": "tenant-1",
      "custom:tenantSlug": "acme",
      "custom:tenantRole": "ADMIN",
      "custom:handle": "@alice",
      "custom:dataRegion": "eu-central-1",
    });
    expect(c).toEqual({
      sub: "abc-123",
      username: "alice",
      email: "a@example.com",
      userId: "cuid-1",
      globalRole: "B2B_PARTNER",
      activeTenantId: "tenant-1",
      tenantSlug: "acme",
      tenantRole: "ADMIN",
      handle: "@alice",
      dataRegion: "eu-central-1",
    });
  });

  it("folds legacy custom:role into globalRole when custom:globalRole absent", () => {
    expect(cognito({ sub: "s", "custom:role": "END_USER" }).globalRole).toBe("END_USER");
  });

  it("prefers custom:globalRole over legacy custom:role", () => {
    expect(cognito({ sub: "s", "custom:globalRole": "SUPER_ADMIN", "custom:role": "END_USER" }).globalRole).toBe(
      "SUPER_ADMIN",
    );
  });

  it("prefers cognito:username, falls back to username, else ''", () => {
    expect(cognito({ sub: "s", "cognito:username": "x", username: "y" }).username).toBe("x");
    expect(cognito({ sub: "s", username: "y" }).username).toBe("y");
    expect(cognito({ sub: "s" }).username).toBe("");
  });

  it("drops non-string optional claims (leaves them undefined)", () => {
    const c = cognito({ sub: "s", email: 42, "custom:userId": { bad: 1 } });
    expect("email" in c).toBe(false);
    expect("userId" in c).toBe(false);
  });

  it("round-trips a non-UUID (Keycloak-style) sub unharmed", () => {
    expect(cognito({ sub: "f:1e3a:9ab" }).sub).toBe("f:1e3a:9ab");
  });
});

describe("normalizeClaims — [SEC-8] sub is never coerced", () => {
  it("throws when sub is absent", () => {
    expect(() => normalizeClaims("cognito", { "cognito:username": "x" })).toThrow(/sub/);
  });
  it("throws when sub is an empty string", () => {
    expect(() => normalizeClaims("cognito", { sub: "" })).toThrow(/sub/);
  });
  it("throws when sub is a non-string", () => {
    expect(() => normalizeClaims("cognito", { sub: 12345 })).toThrow(/sub/);
    expect(() => normalizeClaims("cognito", { sub: null })).toThrow(/sub/);
  });
});

describe("normalizeClaims — generic (Keycloak) mapping", () => {
  it("carries sub + preferred_username/email through", () => {
    const g = normalizeClaims("generic", {
      sub: "f:realm:u1",
      preferred_username: "bob",
      email: "b@example.com",
    });
    expect(g.sub).toBe("f:realm:u1");
    expect(g.username).toBe("bob");
    expect(g.email).toBe("b@example.com");
  });

  it("still throws on missing sub on the generic branch", () => {
    expect(() => normalizeClaims("generic", { preferred_username: "bob" })).toThrow(/sub/);
  });
});
