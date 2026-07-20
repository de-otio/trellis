/**
 * WS-3.3 verifier live-wiring tests.
 *
 * What WS-3.1 deliberately left for WS-3.3 (EXECUTION-COORDINATION X7):
 *  - the D8 (draft) OIDC_ISSUER_URL / OIDC_APP_CLIENT_ID config spelling
 *    feeding the issuer-aware verifier (AUTH_* wins, COGNITO_* derivation
 *    byte-identical when neither is set);
 *  - the generic-issuer (Keycloak) claim mapping in normalizeClaims — G2
 *    C-10/E-3 proved KC protocol mappers emit the LITERAL `custom:*` names;
 *  - the boot-schema relaxation: a fully configured non-Cognito issuer lifts
 *    the hard COGNITO_* requirement (a Keycloak-profile deployment can boot),
 *    while a deployment configuring neither still fails closed.
 */

import { describe, expect, it } from "vitest";

import { resolveAuthConfig } from "../../../src/lib/auth/auth-config.js";
import { normalizeClaims } from "../../../src/lib/auth/cognito-jwt.js";
import { validateBootEnv } from "../../../src/env-schema.js";

const KC_ISSUER = "https://id.example.test/realms/skybber-dev";
const COGNITO_ENV = {
  COGNITO_USER_POOL_ID: "eu-central-1_Pool1",
  COGNITO_APP_CLIENT_ID: "cognito-client-1",
  COGNITO_REGION: "eu-central-1",
};

describe("resolveAuthConfig — D8 (draft) OIDC_* wiring", () => {
  it("keeps the Cognito derivation byte-identical when no new var is set", () => {
    const cfg = resolveAuthConfig({ ...COGNITO_ENV });
    expect(cfg).toEqual({
      issuer: "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_Pool1",
      audience: "cognito-client-1",
      issuerKind: "cognito",
    });
  });

  it("accepts OIDC_ISSUER_URL + OIDC_APP_CLIENT_ID as the full generic config", () => {
    const cfg = resolveAuthConfig({
      OIDC_ISSUER_URL: KC_ISSUER,
      OIDC_APP_CLIENT_ID: "trellis-app",
    });
    expect(cfg).toEqual({
      issuer: KC_ISSUER,
      audience: "trellis-app",
      issuerKind: "generic",
    });
  });

  it("lets the WS-3.1 AUTH_* spelling win over OIDC_* when both are set", () => {
    const cfg = resolveAuthConfig({
      AUTH_ISSUER_URL: "https://other.example.test/realms/r2",
      AUTH_AUDIENCE: "aud-a",
      OIDC_ISSUER_URL: KC_ISSUER,
      OIDC_APP_CLIENT_ID: "aud-b",
    });
    expect(cfg.issuer).toBe("https://other.example.test/realms/r2");
    expect(cfg.audience).toBe("aud-a");
  });

  it("[SEC-6] still fails closed on a generic issuer without ANY explicit audience", () => {
    expect(() =>
      resolveAuthConfig({ OIDC_ISSUER_URL: KC_ISSUER, ...COGNITO_ENV }),
    ).toThrowError(/explicit audience/);
  });

  it("treats OIDC_APP_CLIENT_ID as the explicit audience satisfying [SEC-6]", () => {
    const cfg = resolveAuthConfig({
      OIDC_ISSUER_URL: KC_ISSUER,
      OIDC_APP_CLIENT_ID: "trellis-app",
      ...COGNITO_ENV,
    });
    expect(cfg.audience).toBe("trellis-app");
    expect(cfg.issuerKind).toBe("generic");
  });
});

describe("normalizeClaims — generic (Keycloak) mapping", () => {
  const kcClaims = {
    sub: "00000000-0000-4000-8000-000000000001",
    preferred_username: "user1@example.test",
    email: "user1@example.test",
    // G2 C-10/E-3: the `:` passes through Keycloak's token JSON literally.
    "custom:userId": "cabc123456789012345678901",
    "custom:globalRole": "END_USER",
    "custom:activeTenantId": "cdef123456789012345678901",
    "custom:tenantSlug": "personal-cabc",
    "custom:tenantRole": "OWNER",
    "custom:handle": "user1",
    "custom:dataRegion": "eu",
  };

  it("maps the literal custom:* claims exactly as the Cognito table does", () => {
    const claims = normalizeClaims("generic", kcClaims);
    expect(claims).toEqual({
      sub: "00000000-0000-4000-8000-000000000001",
      username: "user1@example.test",
      email: "user1@example.test",
      userId: "cabc123456789012345678901",
      globalRole: "END_USER",
      activeTenantId: "cdef123456789012345678901",
      tenantSlug: "personal-cabc",
      tenantRole: "OWNER",
      handle: "user1",
      dataRegion: "eu",
    });
  });

  it("produces IDENTICAL neutral claims for the same custom:* payload under both issuer kinds", () => {
    const generic = normalizeClaims("generic", kcClaims);
    const cognito = normalizeClaims("cognito", {
      ...kcClaims,
      "cognito:username": kcClaims.preferred_username,
    });
    expect(generic).toEqual(cognito);
  });

  it("[SEC-7] injects NO role defaults — unmapped roles stay undefined for the middleware boundary", () => {
    const claims = normalizeClaims("generic", {
      sub: "s-1",
      preferred_username: "u",
    });
    expect(claims.globalRole).toBeUndefined();
    expect(claims.tenantRole).toBeUndefined();
    expect(claims.userId).toBeUndefined();
  });

  it("[SEC-8] still throws on a missing/empty sub on the generic path", () => {
    expect(() => normalizeClaims("generic", { preferred_username: "u" })).toThrow();
    expect(() => normalizeClaims("generic", { sub: "", preferred_username: "u" })).toThrow();
  });

  it("falls back to legacy custom:role for globalRole (parity with the Cognito table)", () => {
    const claims = normalizeClaims("generic", { sub: "s-1", "custom:role": "END_USER" });
    expect(claims.globalRole).toBe("END_USER");
  });
});

describe("boot schema — Keycloak-profile deployment (WS-3.3 relaxation)", () => {
  const baseDev = {
    STAGE: "dev",
    DATABASE_URL: "postgresql://test:test@localhost:5432/testdb",
    SESSION_SECRET: "test-secret-key-32-characters-long!!",
  };

  it("boots with a fully configured non-Cognito issuer and NO Cognito ids", () => {
    const issues = validateBootEnv({
      ...baseDev,
      OIDC_ISSUER_URL: KC_ISSUER,
      OIDC_APP_CLIENT_ID: "trellis-app",
    });
    expect(issues).toEqual([]);
  });

  it("still fails closed when neither Cognito ids nor a generic issuer are configured", () => {
    const issues = validateBootEnv({ ...baseDev });
    expect(issues.some((i) => i.startsWith("COGNITO_USER_POOL_ID"))).toBe(true);
  });

  it("a non-Cognito issuer WITHOUT an explicit audience does not lift the Cognito requirement and trips SEC-6", () => {
    const issues = validateBootEnv({
      ...baseDev,
      OIDC_ISSUER_URL: KC_ISSUER,
    });
    expect(issues.some((i) => i.startsWith("AUTH_AUDIENCE"))).toBe(true);
    expect(issues.some((i) => i.startsWith("COGNITO_USER_POOL_ID"))).toBe(true);
  });

  it("IDENTITY_PROVIDER=keycloak without its full config fails closed, naming each key", () => {
    const issues = validateBootEnv({
      ...baseDev,
      COGNITO_USER_POOL_ID: "pool",
      COGNITO_APP_CLIENT_ID: "client",
      IDENTITY_PROVIDER: "keycloak",
    });
    for (const key of [
      "OIDC_ISSUER_URL",
      "OIDC_APP_CLIENT_ID",
      "IDENTITY_ADMIN_CLIENT_ID",
      "IDENTITY_ADMIN_CLIENT_SECRET",
    ]) {
      expect(issues.some((i) => i.startsWith(key))).toBe(true);
    }
  });

  it("IDENTITY_PROVIDER=keycloak with full config boots", () => {
    const issues = validateBootEnv({
      ...baseDev,
      IDENTITY_PROVIDER: "keycloak",
      OIDC_ISSUER_URL: KC_ISSUER,
      OIDC_APP_CLIENT_ID: "trellis-app",
      IDENTITY_ADMIN_CLIENT_ID: "trellis-api",
      IDENTITY_ADMIN_CLIENT_SECRET: "svc-secret",
    });
    expect(issues).toEqual([]);
  });
});
