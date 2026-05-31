/**
 * Gated end-to-end test against a real Entra dev tenant.
 *
 * Set `ENTRA_E2E=true` plus the four env vars below to run; otherwise the
 * suite is skipped. CI runs this only on the integration branch where the
 * Entra credentials are populated.
 *
 *   ENTRA_E2E             — must be "true"
 *   ENTRA_ISSUER_URL      — e.g. https://login.microsoftonline.com/{tenantGuid}/v2.0
 *   ENTRA_CLIENT_ID       — App registration client id
 *   ENTRA_CLIENT_SECRET   — App registration client secret value
 *   COGNITO_USER_POOL_ID  — target user pool
 *   COGNITO_APP_CLIENT_ID — target app client
 *
 * The suite uses real AWS clients; do NOT run locally without an isolated
 * dev account. The IdP is created and immediately deleted as cleanup.
 */
import { describe, it, expect } from "vitest";
import { probeOidcIssuer } from "../../src/lib/cognito/issuer-probe.js";

const enabled =
  process.env.ENTRA_E2E === "true" &&
  !!process.env.ENTRA_ISSUER_URL &&
  !!process.env.ENTRA_CLIENT_ID &&
  !!process.env.ENTRA_CLIENT_SECRET &&
  !!process.env.COGNITO_USER_POOL_ID &&
  !!process.env.COGNITO_APP_CLIENT_ID;

describe.skipIf(!enabled)("Entra OIDC end-to-end", () => {
  it("probes the Entra well-known and creates+deletes a Cognito IdP record", async () => {
    const probe = await probeOidcIssuer(process.env.ENTRA_ISSUER_URL!);
    expect(probe.ok).toBe(true);

    const { CognitoIdpSdk, defaultOidcAttributeMapping } = await import(
      "../../src/lib/cognito/idp-sdk.js"
    );
    const { CognitoIdentityProviderClient } = await import(
      "@aws-sdk/client-cognito-identity-provider"
    );
    const sdk = new CognitoIdpSdk(
      new CognitoIdentityProviderClient({
        region: process.env.AWS_REGION ?? "eu-central-1",
      }),
    );
    const providerName = `tenant-e2e-${Date.now().toString(36).slice(-6)}`;
    try {
      await sdk.createOidcProvider({
        userPoolId: process.env.COGNITO_USER_POOL_ID!,
        providerName,
        details: {
          clientId: process.env.ENTRA_CLIENT_ID!,
          clientSecret: process.env.ENTRA_CLIENT_SECRET!,
          issuerUrl: process.env.ENTRA_ISSUER_URL!,
        },
        attributeMapping: defaultOidcAttributeMapping(),
        idpIdentifiers: [],
      });
      const exists = await sdk.describeProvider(
        process.env.COGNITO_USER_POOL_ID!,
        providerName,
      );
      expect(exists).toBe(true);
    } finally {
      await sdk
        .deleteProvider(process.env.COGNITO_USER_POOL_ID!, providerName)
        .catch(() => undefined);
    }
  }, 30_000);
});
