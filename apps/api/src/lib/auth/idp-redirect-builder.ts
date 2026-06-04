/**
 * Builds the Cognito Hosted UI OAuth2 authorization URL for federated sign-in.
 *
 * The IdP name in Cognito follows the convention `tenant-{cuid}` (using the
 * full tenant cuid, truncated to 25 chars to fit Cognito's 32-char provider-
 * name quota). Sign-in discovery routes by the same convention, so the value
 * passed in is what T5 provisioned.
 *
 * All URL parameters are server-derived; callers supply only the Prisma-loaded
 * cognitoIdpName — no arbitrary IdP names accepted from request input.
 */

export { cognitoIdpName } from "../tenant/idp-name.js";

export interface IdpRedirectConfig {
  hostedUiDomain: string;
  clientId: string;
  redirectUri: string;
}

export interface IdpRedirectParams {
  cognitoIdpName: string;
  tenantSlug: string;
}

export interface IdpRedirectResult {
  idpRedirect: string;
  tenantSlug: string;
}

/**
 * Builds the Cognito Hosted UI authorization URL.
 *
 * Scope is always `openid email profile` — no caller-supplied scope to prevent
 * privilege escalation via scope injection.
 */
export function buildIdpRedirectUrl(
  config: IdpRedirectConfig,
  params: IdpRedirectParams,
): string {
  const base = `https://${config.hostedUiDomain}/oauth2/authorize`;
  const qs = new URLSearchParams({
    identity_provider: params.cognitoIdpName,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
  });
  return `${base}?${qs.toString()}`;
}

/**
 * Reads IdP redirect config from the environment.
 * Env vars read here are defined in src/env.ts and must come from there —
 * no direct process.env access outside buildEnv().
 */
export function getIdpRedirectConfig(env: {
  COGNITO_HOSTED_UI_DOMAIN?: string;
  COGNITO_APP_CLIENT_ID?: string;
  COGNITO_REDIRECT_URI?: string;
}): IdpRedirectConfig {
  return {
    hostedUiDomain: env.COGNITO_HOSTED_UI_DOMAIN ?? "auth.example.com",
    clientId: env.COGNITO_APP_CLIENT_ID ?? "",
    redirectUri: env.COGNITO_REDIRECT_URI ?? "",
  };
}
