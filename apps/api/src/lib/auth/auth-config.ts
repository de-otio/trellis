/**
 * Resolved authentication config — the issuer / audience / JWKS a request is
 * verified against (WS-3.1 §4).
 *
 * ## Zero-config for existing Cognito deployments
 *
 * Every new var derives a default from the existing `COGNITO_*` vars, so a
 * deployment that sets none of the new vars verifies **byte-identically** to
 * today:
 *
 *   - `AUTH_ISSUER_URL`  ← `https://cognito-idp.<region>.amazonaws.com/<poolId>`
 *   - `AUTH_AUDIENCE`    ← `COGNITO_APP_CLIENT_ID`
 *   - `AUTH_JWKS_URL`    ← unset (the library derives `${issuer}/.well-known/jwks.json`)
 *
 * where `region = COGNITO_REGION ?? AWS_REGION ?? "us-east-1"`.
 *
 * ## Fail-closed boot guards
 *
 *   - **[SEC-6]** When `AUTH_ISSUER_URL` names a **non-Cognito** issuer, the
 *     `AUTH_AUDIENCE = COGNITO_APP_CLIENT_ID` default is wrong (it would reject
 *     every token — a baffling outage). We require an explicit `AUTH_AUDIENCE`.
 *   - **[SEC-4]** `AUTH_JWKS_URL` is SSRF-guarded at boot: https-only, no
 *     `user:pass@`, and the host must not resolve to any private / link-local /
 *     IMDS / loopback address (reusing vestibulum's `isPrivateAddress`). A
 *     test-only loopback exception is gated behind a non-prod flag so a real
 *     deployment can never point key retrieval at an internal address.
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

import { isPrivateAddress } from "@de-otio/vestibulum";

/** The classic Cognito issuer shape. */
const COGNITO_ISSUER_RE = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[^/]+$/;

/** The subset of env this module reads. */
export interface AuthConfigEnv {
  AUTH_ISSUER_URL?: string;
  AUTH_AUDIENCE?: string;
  AUTH_JWKS_URL?: string;
  /** Issuer URL, per manifest D8 (draft) — alias; AUTH_ISSUER_URL wins. */
  OIDC_ISSUER_URL?: string;
  /** App client id / audience, per manifest D8 (draft); AUTH_AUDIENCE wins. */
  OIDC_APP_CLIENT_ID?: string;
  COGNITO_USER_POOL_ID?: string;
  COGNITO_APP_CLIENT_ID?: string;
  COGNITO_REGION?: string;
  AWS_REGION?: string;
}

export interface ResolvedAuthConfig {
  /** Exact `iss` to pin (and discovery base when `jwksUri` is unset). */
  readonly issuer: string;
  /** Expected `aud`. */
  readonly audience: string;
  /** Explicit JWKS override, or `undefined` to let the library derive it. */
  readonly jwksUri?: string;
  /** `"cognito"` → enforce `token_use`; `"generic"` → OIDC (Keycloak/Zitadel). */
  readonly issuerKind: "cognito" | "generic";
}

function regionOf(env: AuthConfigEnv): string {
  return env.COGNITO_REGION ?? env.AWS_REGION ?? "us-east-1";
}

/** Derive the Cognito issuer URL from `COGNITO_*`, or `undefined` if no pool. */
export function derivedCognitoIssuer(env: AuthConfigEnv): string | undefined {
  if (!env.COGNITO_USER_POOL_ID) return undefined;
  return `https://cognito-idp.${regionOf(env)}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;
}

/**
 * Resolve the effective auth config. `AUTH_*` wins when set; otherwise derived
 * from `COGNITO_*`. Throws (fail closed) if issuer or audience cannot be
 * resolved, or if [SEC-6] is violated.
 */
export function resolveAuthConfig(env: AuthConfigEnv): ResolvedAuthConfig {
  // WS-3.3: the D8 (draft) OIDC_ISSUER_URL is accepted as an issuer source;
  // the WS-3.1-landed AUTH_ISSUER_URL wins when both are set. A deployment
  // that sets only COGNITO_* still derives the byte-identical Cognito issuer.
  const issuer =
    env.AUTH_ISSUER_URL ??
    env.OIDC_ISSUER_URL /* per manifest D8 (draft) */ ??
    derivedCognitoIssuer(env);
  if (!issuer) {
    throw new Error(
      "auth issuer could not be resolved — set AUTH_ISSUER_URL, OIDC_ISSUER_URL or COGNITO_USER_POOL_ID",
    );
  }
  const issuerKind: "cognito" | "generic" = COGNITO_ISSUER_RE.test(issuer)
    ? "cognito"
    : "generic";

  // [SEC-6] the COGNITO_APP_CLIENT_ID audience default is only correct for a
  // Cognito issuer. A non-Cognito issuer must name its audience explicitly —
  // AUTH_AUDIENCE or the D8 (draft) OIDC_APP_CLIENT_ID both count.
  const explicitAudience =
    env.AUTH_AUDIENCE ?? env.OIDC_APP_CLIENT_ID; /* per manifest D8 (draft) */
  if (issuerKind === "generic" && explicitAudience === undefined) {
    throw new Error(
      "an explicit audience (AUTH_AUDIENCE or OIDC_APP_CLIENT_ID) is required when the issuer is non-Cognito",
    );
  }

  const audience = explicitAudience ?? env.COGNITO_APP_CLIENT_ID;
  if (!audience) {
    throw new Error(
      "auth audience could not be resolved — set AUTH_AUDIENCE, OIDC_APP_CLIENT_ID or COGNITO_APP_CLIENT_ID",
    );
  }

  return {
    issuer,
    audience,
    ...(env.AUTH_JWKS_URL !== undefined ? { jwksUri: env.AUTH_JWKS_URL } : {}),
    issuerKind,
  };
}

export interface JwksUrlGuardOptions {
  /** When true, a loopback JWKS host is permitted (fixture harness only). */
  allowLoopback?: boolean;
  /** Injectable resolver for tests. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

function defaultResolve(hostname: string): Promise<string[]> {
  return dns.lookup(hostname, { all: true, verbatim: true }).then((a) => a.map((x) => x.address));
}

/** Loopback literals permitted only under the test gate. */
function isLoopbackLiteral(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * [SEC-4] Assert an `AUTH_JWKS_URL` is safe to fetch. Throws (fail closed) on
 * any violation. Run at boot, not per-request.
 */
export async function assertJwksUrlSafe(
  jwksUrl: string,
  opts: JwksUrlGuardOptions = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(jwksUrl);
  } catch {
    throw new Error("AUTH_JWKS_URL is not a valid absolute URL");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackAllowed = opts.allowLoopback === true;

  if (url.protocol !== "https:") {
    // The only non-https allowance is a loopback fixture endpoint under the gate.
    if (!(loopbackAllowed && url.protocol === "http:" && isLoopbackLiteral(host))) {
      throw new Error("AUTH_JWKS_URL must use https:// (http is allowed only for a loopback test fixture)");
    }
  }
  if (url.username || url.password) {
    throw new Error("AUTH_JWKS_URL must not include user:pass@ credentials");
  }

  if (isLoopbackLiteral(host)) {
    if (loopbackAllowed) return; // fixture harness
    throw new Error("AUTH_JWKS_URL must not point at a loopback address");
  }

  // Resolve and reject any private / link-local / IMDS address.
  const addresses = isIP(host) ? [host] : await resolveOrThrow(host, opts);
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new Error(`AUTH_JWKS_URL resolves to a non-public address (${addr})`);
    }
  }
}

async function resolveOrThrow(host: string, opts: JwksUrlGuardOptions): Promise<string[]> {
  const resolve = opts.resolveHostname ?? defaultResolve;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new Error(`AUTH_JWKS_URL hostname could not be resolved (${host})`);
  }
  if (addrs.length === 0) {
    throw new Error(`AUTH_JWKS_URL hostname could not be resolved (${host})`);
  }
  return addrs;
}
