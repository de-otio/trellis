/**
 * Cognito authentication helper for e2e tests.
 *
 * Obtains a JWT for a pre-provisioned test user via the USER_PASSWORD_AUTH flow.
 * The token is cached for the duration of the test run.
 *
 * Prerequisites:
 *   - A Cognito test user must exist in the dev user pool
 *   - Credentials stored in SSM:
 *       /trellis/{stage}/test/user-email
 *       /trellis/{stage}/test/user-password
 *   - Or set via env vars: TEST_USER_EMAIL, TEST_USER_PASSWORD
 *   - COGNITO_USER_POOL_CLIENT_ID must be set (or read from SSM)
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const region = process.env.AWS_REGION || "eu-central-1";
const stage = process.env.STAGE || process.env.ENVIRONMENT || "dev";

let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

async function ssmGet(name: string): Promise<string> {
  const ssm = new SSMClient({ region });
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  if (!res.Parameter?.Value) throw new Error(`SSM parameter ${name} not found`);
  return res.Parameter.Value;
}

async function getTestCredentials(): Promise<{ email: string; password: string; clientId: string }> {
  const email = process.env.TEST_USER_EMAIL || await ssmGet(`/trellis/${stage}/test/user-email`);
  const password = process.env.TEST_USER_PASSWORD || await ssmGet(`/trellis/${stage}/test/user-password`);
  const clientId = process.env.COGNITO_USER_POOL_CLIENT_ID || await ssmGet(`/trellis/${stage}/cognito-app-client-id`);
  return { email, password, clientId };
}

/**
 * Get a valid Cognito access token for the test user.
 * Caches the token and refreshes when near expiry.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const { email, password, clientId } = await getTestCredentials();
  const cognito = new CognitoIdentityProviderClient({ region });

  const res = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    }),
  );

  const idToken = res.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw new Error(
      "Cognito auth failed — no IdToken returned. " +
      "Ensure the test user exists, is confirmed, and USER_PASSWORD_AUTH is enabled on the app client.",
    );
  }

  cachedToken = idToken;
  // Refresh 5 minutes before expiry (tokens last 1 hour)
  cachedTokenExpiry = Date.now() + 55 * 60 * 1000;

  return idToken;
}

/**
 * Get Authorization headers for authenticated requests.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Make an authenticated fetch request.
 */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = await getAuthHeaders();
  return fetch(url, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
}
