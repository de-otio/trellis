/**
 * Unit tests: cognito-issuer.ts (T9b-d).
 *
 * Verifies the AwsCognitoIssuer wraps AdminInitiateAuth correctly and
 * surfaces missing tokens as an error.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  AdminInitiateAuthCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  CognitoIdentityProviderClient: class {
    send: ReturnType<typeof vi.fn> = vi.fn();
  },
}));

import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { AwsCognitoIssuer, createDefaultIssuer } from "../../../src/lib/oauth/cognito-issuer.js";

describe("AwsCognitoIssuer.issueForAgent", () => {
  it("returns the AuthenticationResult mapped to a TokenSet", async () => {
    const client = new CognitoIdentityProviderClient({ region: "us-east-1" });
    (client.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      AuthenticationResult: {
        AccessToken: "AT",
        RefreshToken: "RT-new",
        IdToken: "IT",
        ExpiresIn: 3600,
      },
    });
    const issuer = new AwsCognitoIssuer(client);
    const tokens = await issuer.issueForAgent({
      userPoolId: "us-east-1_pool",
      clientId: "agent-client",
      username: "sub-1",
      refreshToken: "RT-old",
    });
    expect(tokens.access_token).toBe("AT");
    expect(tokens.refresh_token).toBe("RT-new");
    expect(tokens.id_token).toBe("IT");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
  });

  it("falls back to the supplied refresh token when Cognito doesn't issue a new one", async () => {
    const client = new CognitoIdentityProviderClient({ region: "us-east-1" });
    (client.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      AuthenticationResult: { AccessToken: "AT", ExpiresIn: 3600 },
    });
    const issuer = new AwsCognitoIssuer(client);
    const tokens = await issuer.issueForAgent({
      userPoolId: "us-east-1_pool",
      clientId: "agent-client",
      username: "sub-1",
      refreshToken: "RT-old",
    });
    expect(tokens.refresh_token).toBe("RT-old");
  });

  it("throws when AdminInitiateAuth returns no tokens", async () => {
    const client = new CognitoIdentityProviderClient({ region: "us-east-1" });
    (client.send as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const issuer = new AwsCognitoIssuer(client);
    await expect(
      issuer.issueForAgent({
        userPoolId: "us-east-1_pool",
        clientId: "agent-client",
        username: "sub-1",
        refreshToken: "RT-old",
      }),
    ).rejects.toThrow(/no tokens/);
  });
});

describe("createDefaultIssuer", () => {
  it("returns a new AwsCognitoIssuer", () => {
    const issuer = createDefaultIssuer();
    expect(issuer).toBeDefined();
    // Public surface — issueForAgent should be present.
    expect(typeof (issuer as { issueForAgent: unknown }).issueForAgent).toBe("function");
  });
});
