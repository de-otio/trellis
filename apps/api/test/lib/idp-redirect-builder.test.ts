/**
 * Unit Tests: idp-redirect-builder
 */

import { describe, expect, it } from "vitest";
import {
  buildIdpRedirectUrl,
  cognitoIdpName,
  getIdpRedirectConfig,
} from "../../src/lib/auth/idp-redirect-builder.js";

describe("cognitoIdpName", () => {
  it("returns tenant- prefix with the full cuid (cuid v1 is 25 chars)", () => {
    expect(cognitoIdpName("clxabcdef1234567890qrstuv")).toBe(
      "tenant-clxabcdef1234567890qrstuv",
    );
  });

  it("handles short IDs without throwing", () => {
    expect(cognitoIdpName("abc")).toBe("tenant-abc");
  });

  it("truncates to 25 chars when the tenantId is longer", () => {
    const id = "123456789012345678901234567890"; // 30 chars
    expect(cognitoIdpName(id)).toBe("tenant-1234567890123456789012345");
  });

  it("returns distinct names for tenants sharing the legacy 12-char prefix", () => {
    const a = cognitoIdpName("clx111aaaaaa1111aaaaaaaaa");
    const b = cognitoIdpName("clx111aaaaaa2222bbbbbbbbb");
    expect(a).not.toBe(b);
  });
});

describe("buildIdpRedirectUrl", () => {
  const config = {
    hostedUiDomain: "auth.example.com",
    clientId: "client123",
    redirectUri: "https://app.example.com/auth/callback",
  };

  it("builds a valid https URL targeting the Cognito Hosted UI", () => {
    const url = buildIdpRedirectUrl(config, {
      cognitoIdpName: "tenant-abc12345678",
      tenantSlug: "acme",
    });
    expect(url).toMatch(/^https:\/\/auth\.example\.com\/oauth2\/authorize\?/);
  });

  it("includes identity_provider param from cognitoIdpName", () => {
    const url = buildIdpRedirectUrl(config, {
      cognitoIdpName: "tenant-abc12345678",
      tenantSlug: "acme",
    });
    const qs = new URL(url).searchParams;
    expect(qs.get("identity_provider")).toBe("tenant-abc12345678");
  });

  it("includes client_id, redirect_uri, response_type=code", () => {
    const url = buildIdpRedirectUrl(config, {
      cognitoIdpName: "tenant-xyz",
      tenantSlug: "xyz",
    });
    const qs = new URL(url).searchParams;
    expect(qs.get("client_id")).toBe("client123");
    expect(qs.get("redirect_uri")).toBe("https://app.example.com/auth/callback");
    expect(qs.get("response_type")).toBe("code");
  });

  it("scope is always openid email profile (not caller-injected)", () => {
    const url = buildIdpRedirectUrl(config, {
      cognitoIdpName: "tenant-xyz",
      tenantSlug: "xyz",
    });
    const qs = new URL(url).searchParams;
    expect(qs.get("scope")).toBe("openid email profile");
  });

  it("does not include tenantSlug in the query string (server-side only)", () => {
    const url = buildIdpRedirectUrl(config, {
      cognitoIdpName: "tenant-xyz",
      tenantSlug: "acme-corp",
    });
    expect(url).not.toContain("acme-corp");
  });
});

describe("getIdpRedirectConfig", () => {
  it("uses provided env values", () => {
    const config = getIdpRedirectConfig({
      COGNITO_HOSTED_UI_DOMAIN: "custom.auth.example.com",
      COGNITO_APP_CLIENT_ID: "my-client",
      COGNITO_REDIRECT_URI: "https://myapp.example.com/callback",
    });
    expect(config.hostedUiDomain).toBe("custom.auth.example.com");
    expect(config.clientId).toBe("my-client");
    expect(config.redirectUri).toBe("https://myapp.example.com/callback");
  });

  it("falls back to auth.example.com when COGNITO_HOSTED_UI_DOMAIN is absent", () => {
    const config = getIdpRedirectConfig({});
    expect(config.hostedUiDomain).toBe("auth.example.com");
  });

  it("returns empty strings for clientId/redirectUri when absent", () => {
    const config = getIdpRedirectConfig({});
    expect(config.clientId).toBe("");
    expect(config.redirectUri).toBe("");
  });
});
