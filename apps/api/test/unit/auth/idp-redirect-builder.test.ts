/**
 * Unit Tests: idp-redirect-builder.ts
 *
 * Contract: builds the Cognito Hosted UI OAuth2 /oauth2/authorize URL for
 * federated sign-in. Security-relevant properties:
 *   - `scope` is always server-fixed to "openid email profile"; no caller-
 *     supplied scope is accepted, preventing privilege escalation via scope
 *     injection.
 *   - `identity_provider` comes from a Prisma-loaded `cognitoIdpName` value,
 *     never raw request input.
 *   - `response_type` is always "code" (authorization-code flow; no implicit).
 *   - All other parameters (client_id, redirect_uri) are read from server-
 *     controlled environment config, not from callers.
 */

import { describe, expect, it } from "vitest";
import {
  buildIdpRedirectUrl,
  getIdpRedirectConfig,
  cognitoIdpName,
} from "../../../src/lib/auth/idp-redirect-builder.js";

// ---------------------------------------------------------------------------
// buildIdpRedirectUrl
// ---------------------------------------------------------------------------

describe("buildIdpRedirectUrl", () => {
  const baseConfig = {
    hostedUiDomain: "auth.example.com",
    clientId: "abc123clientid",
    redirectUri: "https://app.example.com/auth/callback",
  };

  const baseParams = {
    cognitoIdpName: "tenant-cltest0000001",
    tenantSlug: "acme",
  };

  it("returns a URL rooted at https://{hostedUiDomain}/oauth2/authorize", () => {
    const result = buildIdpRedirectUrl(baseConfig, baseParams);
    const url = new URL(result);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("auth.example.com");
    expect(url.pathname).toBe("/oauth2/authorize");
  });

  it("includes identity_provider equal to cognitoIdpName", () => {
    const url = new URL(buildIdpRedirectUrl(baseConfig, baseParams));
    expect(url.searchParams.get("identity_provider")).toBe("tenant-cltest0000001");
  });

  it("includes client_id from config", () => {
    const url = new URL(buildIdpRedirectUrl(baseConfig, baseParams));
    expect(url.searchParams.get("client_id")).toBe("abc123clientid");
  });

  it("includes redirect_uri from config", () => {
    const url = new URL(buildIdpRedirectUrl(baseConfig, baseParams));
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/auth/callback");
  });

  it("always sets response_type to 'code'", () => {
    const url = new URL(buildIdpRedirectUrl(baseConfig, baseParams));
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  // SECURITY: scope is server-fixed; no caller can inject additional scopes.
  it("SECURITY: always sets scope to exactly 'openid email profile'", () => {
    const url = new URL(buildIdpRedirectUrl(baseConfig, baseParams));
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("SECURITY: scope does not change when a different cognitoIdpName is supplied", () => {
    const params = { ...baseParams, cognitoIdpName: "tenant-other9999" };
    const url = new URL(buildIdpRedirectUrl(baseConfig, params));
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("URL-encodes a redirectUri that contains query-string characters", () => {
    const redirectUriWithQuery = "https://app.example.com/cb?x=1&y=2";
    const config = { ...baseConfig, redirectUri: redirectUriWithQuery };
    const result = buildIdpRedirectUrl(config, baseParams);

    // The raw string must not contain the unencoded redirect URI as a bare
    // substring after the first `?` (it must be percent-encoded).
    const afterFirstQ = result.slice(result.indexOf("?") + 1);
    expect(afterFirstQ).not.toContain("https://app.example.com/cb?x=1&y=2");

    // But parsing the outer URL and reading the parameter restores the original.
    const url = new URL(result);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUriWithQuery);
  });

  it("URL-encodes a redirectUri that contains a space", () => {
    const redirectUriWithSpace = "https://app.example.com/auth callback";
    const config = { ...baseConfig, redirectUri: redirectUriWithSpace };
    const url = new URL(buildIdpRedirectUrl(config, baseParams));
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUriWithSpace);
  });

  it("passes identity_provider through verbatim (after URL round-trip)", () => {
    const idpName = "tenant-clspecial0000";
    const params = { ...baseParams, cognitoIdpName: idpName };
    const url = new URL(buildIdpRedirectUrl(baseConfig, params));
    expect(url.searchParams.get("identity_provider")).toBe(idpName);
  });

  it("produces a URL that can be parsed without throwing", () => {
    expect(() => new URL(buildIdpRedirectUrl(baseConfig, baseParams))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getIdpRedirectConfig
// ---------------------------------------------------------------------------

describe("getIdpRedirectConfig", () => {
  it("reads COGNITO_HOSTED_UI_DOMAIN from env", () => {
    const config = getIdpRedirectConfig({ COGNITO_HOSTED_UI_DOMAIN: "login.example.com" });
    expect(config.hostedUiDomain).toBe("login.example.com");
  });

  it("reads COGNITO_APP_CLIENT_ID from env", () => {
    const config = getIdpRedirectConfig({ COGNITO_APP_CLIENT_ID: "myclientid" });
    expect(config.clientId).toBe("myclientid");
  });

  it("reads COGNITO_REDIRECT_URI from env", () => {
    const config = getIdpRedirectConfig({
      COGNITO_REDIRECT_URI: "https://app.example.com/auth/callback",
    });
    expect(config.redirectUri).toBe("https://app.example.com/auth/callback");
  });

  it("defaults hostedUiDomain to 'auth.example.com' when COGNITO_HOSTED_UI_DOMAIN is absent", () => {
    const config = getIdpRedirectConfig({});
    expect(config.hostedUiDomain).toBe("auth.example.com");
  });

  it("defaults clientId to '' when COGNITO_APP_CLIENT_ID is absent", () => {
    const config = getIdpRedirectConfig({});
    expect(config.clientId).toBe("");
  });

  it("defaults redirectUri to '' when COGNITO_REDIRECT_URI is absent", () => {
    const config = getIdpRedirectConfig({});
    expect(config.redirectUri).toBe("");
  });

  it("uses all provided env values together", () => {
    const config = getIdpRedirectConfig({
      COGNITO_HOSTED_UI_DOMAIN: "auth.example.com",
      COGNITO_APP_CLIENT_ID: "full-client-id",
      COGNITO_REDIRECT_URI: "https://app.example.com/callback",
    });
    expect(config).toEqual({
      hostedUiDomain: "auth.example.com",
      clientId: "full-client-id",
      redirectUri: "https://app.example.com/callback",
    });
  });

  it("returns an object with exactly the three expected keys", () => {
    const config = getIdpRedirectConfig({});
    expect(Object.keys(config).sort()).toEqual(["clientId", "hostedUiDomain", "redirectUri"]);
  });
});

// ---------------------------------------------------------------------------
// cognitoIdpName (re-exported from tenant/idp-name)
// ---------------------------------------------------------------------------

describe("cognitoIdpName", () => {
  it("prepends 'tenant-' to the tenant id", () => {
    expect(cognitoIdpName("abc123")).toBe("tenant-abc123");
  });

  it("returns 'tenant-' + full id when id is exactly 25 chars", () => {
    const id25 = "a".repeat(25);
    expect(cognitoIdpName(id25)).toBe(`tenant-${id25}`);
  });

  it("truncates ids longer than 25 chars to first 25 chars", () => {
    const id30 = "b".repeat(30);
    expect(cognitoIdpName(id30)).toBe(`tenant-${"b".repeat(25)}`);
  });

  it("truncated output contains exactly 'tenant-' + 25 chars", () => {
    const id26 = "c".repeat(26);
    const result = cognitoIdpName(id26);
    expect(result).toBe(`tenant-${"c".repeat(25)}`);
    expect(result.length).toBe(7 + 25); // "tenant-" is 7 chars
  });

  it("does not truncate ids shorter than 25 chars", () => {
    const id10 = "d".repeat(10);
    expect(cognitoIdpName(id10)).toBe(`tenant-${id10}`);
  });

  it("handles an empty string id", () => {
    expect(cognitoIdpName("")).toBe("tenant-");
  });

  it("handles a single-character id", () => {
    expect(cognitoIdpName("x")).toBe("tenant-x");
  });

  it("preserves mixed-character ids verbatim when within limit", () => {
    const id = "cltest0001abc"; // 13 chars
    expect(cognitoIdpName(id)).toBe(`tenant-${id}`);
  });

  it("truncates a realistic cuid that is unexpectedly long (>25 chars)", () => {
    // cuid v1 is normally 25 chars, but guard against longer variants
    const longId = "clXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // 34 chars
    const result = cognitoIdpName(longId);
    expect(result).toBe(`tenant-${longId.slice(0, 25)}`);
  });
});
