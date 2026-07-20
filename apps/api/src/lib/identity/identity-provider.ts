/**
 * Central identity-provider selection (WS-3.3) — the WS-1 `KV_PROVIDER`
 * pattern applied to identity.
 *
 * `IDENTITY_PROVIDER` (env, default `"cognito"`) selects the adapter:
 *   - unset / "cognito" → `CognitoIdentityProvider` over the existing
 *     CUSTOM_AUTH + AdminDeleteUser surfaces. **Existing AWS deployments set
 *     nothing and see ZERO change.**
 *   - "keycloak" → `KeycloakIdentityProvider` (`@de-otio/saas-foundation/identity`),
 *     the p2 REST contract G2 proved live.
 *
 * ## Keycloak config surface
 *
 * The Keycloak path derives base URL + realm from `OIDC_ISSUER_URL`
 * (`…/realms/<realm>`) and takes the app client from `OIDC_APP_CLIENT_ID` —
 * per manifest D8 (draft). The service-account (client_credentials,
 * manage-users) credentials come from `IDENTITY_ADMIN_CLIENT_ID` /
 * `IDENTITY_ADMIN_CLIENT_SECRET` — NOT in the D8 table yet; proposed
 * additions, flagged for the manifest freeze. Everything fails closed when
 * missing (the foundation adapter double-checks).
 */

import {
  KeycloakIdentityProvider,
  IdentityProviderError,
  type IdentityProviderPort,
} from "@de-otio/saas-foundation/identity";

import { CognitoIdentityProvider } from "./cognito-identity-provider.js";
import type { IdentityAdminPort } from "../workers/identity-admin-port.js";

export type IdentityProviderKind = "cognito" | "keycloak";

/** Default cognito — zero AWS change (the WS-1 `KV_PROVIDER` default rule). */
export function resolveIdentityProviderKind(): IdentityProviderKind {
  return process.env.IDENTITY_PROVIDER === "keycloak" ? "keycloak" : "cognito";
}

let cached: IdentityProviderPort | null = null;
let cachedKind: IdentityProviderKind | null = null;

/** Test seam: inject an `IdentityProviderPort` (pass null to reset). */
export function __setIdentityProviderForTest(p: IdentityProviderPort | null): void {
  cached = p;
  cachedKind = p === null ? null : resolveIdentityProviderKind();
}

/**
 * Split `OIDC_ISSUER_URL` (per manifest D8 (draft)) into the Keycloak base URL
 * and realm. Fails closed on any other shape.
 */
export function splitKeycloakIssuer(issuerUrl: string): { baseUrl: string; realm: string } {
  const match = /^(https?:\/\/.+?)\/realms\/([^/]+)\/?$/.exec(issuerUrl);
  if (!match) {
    throw new IdentityProviderError(
      "config_missing",
      "OIDC_ISSUER_URL is not a Keycloak issuer URL (expected …/realms/<realm>)",
    );
  }
  return { baseUrl: match[1]!, realm: match[2]! };
}

function buildProvider(kind: IdentityProviderKind): IdentityProviderPort {
  if (kind === "keycloak") {
    const issuerUrl = process.env.OIDC_ISSUER_URL; // per manifest D8 (draft)
    const appClientId = process.env.OIDC_APP_CLIENT_ID; // per manifest D8 (draft)
    const serviceClientId = process.env.IDENTITY_ADMIN_CLIENT_ID; // proposed D8 addition
    const serviceClientSecret = process.env.IDENTITY_ADMIN_CLIENT_SECRET; // proposed D8 addition
    if (!issuerUrl || !appClientId || !serviceClientId || !serviceClientSecret) {
      throw new IdentityProviderError(
        "config_missing",
        "IDENTITY_PROVIDER=keycloak requires OIDC_ISSUER_URL, OIDC_APP_CLIENT_ID, " +
          "IDENTITY_ADMIN_CLIENT_ID and IDENTITY_ADMIN_CLIENT_SECRET",
      );
    }
    const { baseUrl, realm } = splitKeycloakIssuer(issuerUrl);
    return new KeycloakIdentityProvider({
      baseUrl,
      realm,
      serviceClientId,
      serviceClientSecret,
      appClientId,
    });
  }
  // Cognito (default). Only the pool is required — the X6 admin slice
  // (deleteUser) has always worked from `COGNITO_USER_POOL_ID` alone;
  // initiateMagicLink fails closed at call time without an app client.
  // App-client naming: D8 renames COGNITO_APP_CLIENT_ID → OIDC_APP_CLIENT_ID;
  // accept both, existing name last so current deployments are byte-identical.
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const appClientId =
    process.env.OIDC_APP_CLIENT_ID /* per manifest D8 (draft) */ ??
    process.env.COGNITO_APP_CLIENT_ID;
  if (!userPoolId) {
    throw new IdentityProviderError(
      "config_missing",
      "IDENTITY_PROVIDER=cognito requires COGNITO_USER_POOL_ID",
    );
  }
  const region = process.env.COGNITO_REGION ?? process.env.AWS_REGION;
  return new CognitoIdentityProvider({
    userPoolId,
    ...(appClientId !== undefined ? { appClientId } : {}),
    ...(region !== undefined ? { region } : {}),
  });
}

/** Resolve the deployment's `IdentityProviderPort`, honoring `IDENTITY_PROVIDER`. */
export function getIdentityProvider(): IdentityProviderPort {
  const kind = resolveIdentityProviderKind();
  if (cached !== null && cachedKind === kind) return cached;
  cached = buildProvider(kind);
  cachedKind = kind;
  return cached;
}

/**
 * The narrow X6 admin slice for the WS-2 worker contexts, or `undefined` when
 * the selected provider is unconfigured — preserving the old per-Lambda
 * `if (COGNITO_USER_POOL_ID) …` skip exactly (the worker cores treat an
 * absent identity port as "nothing to delete externally").
 *
 * `IdentityProviderPort` is a structural superset of `IdentityAdminPort`, so
 * the full port satisfies the slice unchanged.
 */
export function makeIdentityAdminPort(): IdentityAdminPort | undefined {
  if (resolveIdentityProviderKind() === "cognito" && !process.env.COGNITO_USER_POOL_ID) {
    return undefined;
  }
  try {
    return getIdentityProvider();
  } catch (err) {
    if (err instanceof IdentityProviderError && err.reason === "config_missing") {
      return undefined;
    }
    throw err;
  }
}
