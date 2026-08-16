/**
 * Unit Tests: auth-config (WS-3.1 §4)
 *
 * Proves:
 *   (a) only COGNITO_* set → resolved issuer + audience equal today's values
 *   (b) direct OIDC_ISSUER_URL set → validated + wins
 *   (c) neither issuer source → resolve fails closed
 *   (d) [SEC-6] non-Cognito issuer without OIDC_APP_CLIENT_ID → fails closed
 *   (e) [SEC-4] OIDC_JWKS_URL at a private/IMDS/non-https/credentialed address
 *       → fails closed; loopback refused unless the test gate is set
 */

import { describe, expect, it } from "vitest";
import {
  assertJwksUrlSafe,
  derivedCognitoIssuer,
  resolveAuthConfig,
} from "../../../src/lib/auth/auth-config.js";

const COGNITO_ENV = {
  COGNITO_USER_POOL_ID: "us-east-1_TestPool123",
  COGNITO_APP_CLIENT_ID: "test-client-id-abc",
  COGNITO_REGION: "us-east-1",
};

describe("resolveAuthConfig — (a) Cognito-derived defaults", () => {
  it("derives the classic Cognito issuer + audience from COGNITO_* only", () => {
    const cfg = resolveAuthConfig(COGNITO_ENV);
    expect(cfg.issuer).toBe("https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool123");
    expect(cfg.audience).toBe("test-client-id-abc");
    expect(cfg.issuerKind).toBe("cognito");
    expect(cfg.jwksUri).toBeUndefined();
  });

  it("resolves region from AWS_REGION when COGNITO_REGION unset", () => {
    const cfg = resolveAuthConfig({
      COGNITO_USER_POOL_ID: "eu-central-1_Pool",
      COGNITO_APP_CLIENT_ID: "c",
      AWS_REGION: "eu-central-1",
    });
    expect(cfg.issuer).toBe("https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_Pool");
  });

  it("derivedCognitoIssuer matches the pre-WS-3.1 canonicalIssuer shape", () => {
    expect(derivedCognitoIssuer(COGNITO_ENV)).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool123",
    );
    expect(derivedCognitoIssuer({})).toBeUndefined();
  });
});

describe("resolveAuthConfig — (b) explicit OIDC_* wins and is equivalent", () => {
  it("an explicit OIDC_ISSUER_URL/OIDC_APP_CLIENT_ID set to the derived values is equivalent", () => {
    const derived = resolveAuthConfig(COGNITO_ENV);
    const explicit = resolveAuthConfig({
      ...COGNITO_ENV,
      OIDC_ISSUER_URL: derived.issuer,
      OIDC_APP_CLIENT_ID: derived.audience,
    });
    expect(explicit.issuer).toBe(derived.issuer);
    expect(explicit.audience).toBe(derived.audience);
    expect(explicit.issuerKind).toBe("cognito");
  });

  it("carries an explicit OIDC_JWKS_URL through", () => {
    const cfg = resolveAuthConfig({
      ...COGNITO_ENV,
      OIDC_JWKS_URL: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool123/.well-known/jwks.json",
    });
    expect(cfg.jwksUri).toContain("/.well-known/jwks.json");
  });
});

describe("resolveAuthConfig — (c) fail-closed when unresolvable", () => {
  it("throws when neither OIDC_ISSUER_URL nor COGNITO_USER_POOL_ID is set", () => {
    expect(() => resolveAuthConfig({ COGNITO_APP_CLIENT_ID: "c" })).toThrow(/issuer could not be resolved/);
  });

  it("throws when no audience source is present for a Cognito issuer", () => {
    expect(() => resolveAuthConfig({ COGNITO_USER_POOL_ID: "us-east-1_P", COGNITO_REGION: "us-east-1" })).toThrow(
      /audience could not be resolved/,
    );
  });
});

describe("resolveAuthConfig — (d) [SEC-6] non-Cognito issuer requires OIDC_APP_CLIENT_ID", () => {
  it("throws for a Keycloak issuer without OIDC_APP_CLIENT_ID", () => {
    expect(() =>
      resolveAuthConfig({
        ...COGNITO_ENV,
        OIDC_ISSUER_URL: "https://keycloak.example.com/realms/trellis",
      }),
    ).toThrow(/explicit audience \(OIDC_APP_CLIENT_ID\) is required/);
  });

  it("accepts a Keycloak issuer WITH an explicit OIDC_APP_CLIENT_ID", () => {
    const cfg = resolveAuthConfig({
      ...COGNITO_ENV,
      OIDC_ISSUER_URL: "https://keycloak.example.com/realms/trellis",
      OIDC_APP_CLIENT_ID: "trellis-api",
      // [SEC-6b] now also required for a generic issuer — see the block below.
      OIDC_JWKS_URL: "https://keycloak.example.com/realms/trellis/protocol/openid-connect/certs",
    });
    expect(cfg.issuerKind).toBe("generic");
    expect(cfg.audience).toBe("trellis-api");
    expect(cfg.jwksUri).toBe(
      "https://keycloak.example.com/realms/trellis/protocol/openid-connect/certs",
    );
  });
});

/**
 * REGRESSION (live, dev, 2026-08-02): every Keycloak token was rejected with
 * `invalid_signature`. The signature was fine — OIDC_JWKS_URL was unset, so the
 * verifier derived Cognito's `${issuer}/.well-known/jwks.json`, which 404s on
 * Keycloak; the missing key is reported as a signature failure, pointing at
 * crypto rather than at config. Same failure mode as [SEC-6]: a Cognito-shaped
 * default silently applied to a non-Cognito issuer.
 */
describe("resolveAuthConfig — [SEC-6b] non-Cognito issuer requires OIDC_JWKS_URL", () => {
  const KC = "https://keycloak.example.com/realms/trellis";

  it("throws for a Keycloak issuer without OIDC_JWKS_URL", () => {
    expect(() =>
      resolveAuthConfig({
        ...COGNITO_ENV,
        OIDC_ISSUER_URL: KC,
        OIDC_APP_CLIENT_ID: "trellis-api",
      }),
    ).toThrow(/OIDC_JWKS_URL is required when the issuer is non-Cognito/);
  });

  it("points at the discovery document so the fix is actionable", () => {
    // A plain string is a SUBSTRING match, not a pattern — which is what this
    // assertion always meant. Interpolating a URL into `new RegExp` left every
    // `.` as a wildcard, so a message naming `httpsX//keycloakXexampleXcom/…`
    // would have satisfied it too. CodeQL flags that as
    // js/incomplete-hostname-regexp, and it is right: the check read stricter
    // than it was.
    expect(() =>
      resolveAuthConfig({ ...COGNITO_ENV, OIDC_ISSUER_URL: KC, OIDC_APP_CLIENT_ID: "a" }),
    ).toThrow(`${KC}/.well-known/openid-configuration`);
  });

  it("does NOT require OIDC_JWKS_URL for a Cognito issuer", () => {
    // The derived default is correct there, so requiring it would be noise.
    const cfg = resolveAuthConfig(COGNITO_ENV);
    expect(cfg.issuerKind).toBe("cognito");
    expect(cfg.jwksUri).toBeUndefined();
  });

  it("does not require it for a Cognito issuer named via OIDC_ISSUER_URL", () => {
    // Same pool, spelled with the neutral var — still Cognito, still exempt.
    const cfg = resolveAuthConfig({
      OIDC_ISSUER_URL: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool",
      OIDC_APP_CLIENT_ID: "client-id",
    });
    expect(cfg.issuerKind).toBe("cognito");
  });
});

describe("assertJwksUrlSafe — (e) [SEC-4] SSRF boot guard", () => {
  const publicResolve = async () => ["203.0.113.10" /* not actually resolved */];

  it("rejects a non-https URL", async () => {
    await expect(assertJwksUrlSafe("http://cognito-idp.us-east-1.amazonaws.com/x")).rejects.toThrow(/https/);
  });

  it("rejects credentials in the URL", async () => {
    await expect(
      assertJwksUrlSafe("https://user:pass@example.com/jwks.json", { resolveHostname: publicResolve }),
    ).rejects.toThrow(/credentials/);
  });

  it("rejects an IMDS literal (169.254.169.254)", async () => {
    await expect(assertJwksUrlSafe("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /non-public address/,
    );
  });

  it("rejects a private RFC-1918 literal (10.0.0.5)", async () => {
    await expect(assertJwksUrlSafe("https://10.0.0.5/jwks.json")).rejects.toThrow(/non-public address/);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(
      assertJwksUrlSafe("https://sneaky.example.com/jwks.json", {
        resolveHostname: async () => ["192.168.1.1"],
      }),
    ).rejects.toThrow(/non-public address/);
  });

  it("rejects a loopback host when the test gate is OFF", async () => {
    await expect(assertJwksUrlSafe("http://127.0.0.1:8080/jwks.json")).rejects.toThrow();
  });

  it("permits a loopback fixture host when the test gate is ON", async () => {
    await expect(
      assertJwksUrlSafe("http://127.0.0.1:8080/jwks.json", { allowLoopback: true }),
    ).resolves.toBeUndefined();
  });

  it("accepts a public host", async () => {
    await expect(
      assertJwksUrlSafe("https://cognito-idp.us-east-1.amazonaws.com/us-east-1_P/.well-known/jwks.json", {
        resolveHostname: async () => ["18.155.1.1"],
      }),
    ).resolves.toBeUndefined();
  });
});
