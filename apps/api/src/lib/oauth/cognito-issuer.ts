/**
 * Token issuance wrapper for the device-auth approval step.
 *
 * The device-auth flow needs to produce a fresh access+refresh token set
 * scoped to the admin's identity but bound to the agent client id (so
 * audit logs can attribute later API calls to the agent session).
 *
 * Cognito's `AdminInitiateAuth` is the lowest-friction call that fits.
 * This wrapper hides the SDK shape so the route handler stays clean and
 * unit tests can mock a single function.
 */

import {
  AdminInitiateAuthCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { TokenSet } from "./device-authorization.js";

export interface CognitoIssuerInput {
  userPoolId: string;
  /** Public agent client id (no client secret). */
  clientId: string;
  /** Admin's Cognito username (sub). */
  username: string;
  /** Admin's current refresh token (from the active web session). */
  refreshToken: string;
}

export interface CognitoIssuer {
  issueForAgent(input: CognitoIssuerInput): Promise<TokenSet>;
}

/** Default implementation backed by AWS SDK. */
export class AwsCognitoIssuer implements CognitoIssuer {
  constructor(private readonly client: CognitoIdentityProviderClient) {}

  async issueForAgent(input: CognitoIssuerInput): Promise<TokenSet> {
    const out = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: input.userPoolId,
        ClientId: input.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: {
          REFRESH_TOKEN: input.refreshToken,
        },
      }),
    );
    const r = out.AuthenticationResult;
    if (!r?.AccessToken || !r?.ExpiresIn) {
      throw new Error("Cognito AdminInitiateAuth returned no tokens");
    }
    return {
      access_token: r.AccessToken,
      refresh_token: r.RefreshToken ?? input.refreshToken,
      id_token: r.IdToken,
      token_type: "Bearer",
      expires_in: r.ExpiresIn,
    };
  }
}

/** Build the default issuer using the global Cognito SDK client. */
export function createDefaultIssuer(): CognitoIssuer {
  const client = new CognitoIdentityProviderClient({
    region: process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-1",
  });
  return new AwsCognitoIssuer(client);
}
