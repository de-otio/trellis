/**
 * Resolved authentication config — the issuer / audience / JWKS a request is
 * verified against (WS-3.1 §4).
 *
 * ## Env-var names (manifest D8 — FROZEN: OIDC_* canonical)
 *
 * The provider-neutral names are `OIDC_*` (manifest D8, frozen 2026-07-20). The
 * WS-3.1-interim `AUTH_*` spelling has been removed; nothing else references it.
 *
 * ## Zero-config for existing Cognito deployments
 *
 * Every new var derives a default from the existing `COGNITO_*` vars, so a
 * deployment that sets none of the new vars verifies **byte-identically** to
 * today:
 *
 *   - `OIDC_ISSUER_URL`     ← `https://cognito-idp.<region>.amazonaws.com/<poolId>`
 *   - `OIDC_APP_CLIENT_ID`  ← `COGNITO_APP_CLIENT_ID`
 *   - `OIDC_JWKS_URL`       ← unset (the library derives `${issuer}/.well-known/jwks.json`)
 *
 * where `region = COGNITO_REGION ?? AWS_REGION ?? "us-east-1"`.
 *
 * ## Fail-closed boot guards
 *
 *   - **[SEC-6]** When `OIDC_ISSUER_URL` names a **non-Cognito** issuer, the
 *     `OIDC_APP_CLIENT_ID = COGNITO_APP_CLIENT_ID` default is wrong (it would
 *     reject every token — a baffling outage). We require an explicit
 *     `OIDC_APP_CLIENT_ID`.
 *   - **[SEC-4]** `OIDC_JWKS_URL` is SSRF-guarded at boot: https-only, no
 *     `user:pass@`, and the host must not resolve to any private / link-local /
 *     IMDS / loopback address (reusing vestibulum's `isPrivateAddress`). A
 *     test-only loopback exception is gated behind a non-prod flag so a real
 *     deployment can never point key retrieval at an internal address.
 *
 * `OIDC_JWKS_URL` is an optional override not in the manifest D8 table (a WS-3.1
 * addition); follow-up: add it to the manifest env-var contract.
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

import { isPrivateAddress } from "@de-otio/vestibulum";

/** The classic Cognito issuer shape. */
const COGNITO_ISSUER_RE = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[^/]+$/;

/** The subset of env this module reads. */
export interface AuthConfigEnv {
  /** Full issuer URL to pin (manifest D8). Default: the Cognito issuer. */
  OIDC_ISSUER_URL?: string;
  /** App client id / expected `aud` (manifest D8). Default: COGNITO_APP_CLIENT_ID. */
  OIDC_APP_CLIENT_ID?: string;
  /** Explicit JWKS override (air-gapped / fixture tests). Default: unset. */
  OIDC_JWKS_URL?: string;
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
 * Resolve the effective auth config. `OIDC_*` wins when set; otherwise derived
 * from `COGNITO_*`. Throws (fail closed) if issuer or audience cannot be
 * resolved, or if [SEC-6] is violated.
 */
export function resolveAuthConfig(env: AuthConfigEnv): ResolvedAuthConfig {
  // The neutral OIDC_ISSUER_URL (manifest D8) names the issuer; a deployment
  // that sets only COGNITO_* still derives the byte-identical Cognito issuer.
  const issuer = env.OIDC_ISSUER_URL ?? derivedCognitoIssuer(env);
  if (!issuer) {
    throw new Error(
      "auth issuer could not be resolved — set OIDC_ISSUER_URL or COGNITO_USER_POOL_ID",
    );
  }
  const issuerKind: "cognito" | "generic" = COGNITO_ISSUER_RE.test(issuer)
    ? "cognito"
    : "generic";

  // [SEC-6] the COGNITO_APP_CLIENT_ID audience default is only correct for a
  // Cognito issuer. A non-Cognito issuer must name its audience explicitly via
  // OIDC_APP_CLIENT_ID.
  const explicitAudience = env.OIDC_APP_CLIENT_ID;
  if (issuerKind === "generic" && explicitAudience === undefined) {
    throw new Error(
      "an explicit audience (OIDC_APP_CLIENT_ID) is required when the issuer is non-Cognito",
    );
  }

  const audience = explicitAudience ?? env.COGNITO_APP_CLIENT_ID;
  if (!audience) {
    throw new Error(
      "auth audience could not be resolved — set OIDC_APP_CLIENT_ID or COGNITO_APP_CLIENT_ID",
    );
  }

  // [SEC-6b] Same shape as the audience rule above, same reason: a Cognito
  // default silently applied to a non-Cognito issuer. With OIDC_JWKS_URL unset
  // the verifier derives `${issuer}/.well-known/jwks.json`, which is Cognito's
  // layout; Keycloak serves `/protocol/openid-connect/certs`. The derived URL
  // 404s and the resulting missing-key error is reported as `invalid_signature`
  // — so the symptom is "every token is cryptographically invalid" and the
  // cause is a URL. Verified live on dev 2026-08-02.
  //
  // Fail at boot rather than on the first request: a deploy that cannot verify
  // any token should not report itself healthy.
  if (issuerKind === "generic" && env.OIDC_JWKS_URL === undefined) {
    throw new Error(
      "OIDC_JWKS_URL is required when the issuer is non-Cognito — the derived " +
        "default is Cognito-specific and 404s elsewhere. Take jwks_uri from " +
        `${issuer}/.well-known/openid-configuration`,
    );
  }

  return {
    issuer,
    audience,
    ...(env.OIDC_JWKS_URL !== undefined ? { jwksUri: env.OIDC_JWKS_URL } : {}),
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
 * [SEC-4] Assert an `OIDC_JWKS_URL` is safe to fetch. Throws (fail closed) on
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
    throw new Error("OIDC_JWKS_URL is not a valid absolute URL");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackAllowed = opts.allowLoopback === true;

  if (url.protocol !== "https:") {
    // The only non-https allowance is a loopback fixture endpoint under the gate.
    if (!(loopbackAllowed && url.protocol === "http:" && isLoopbackLiteral(host))) {
      throw new Error("OIDC_JWKS_URL must use https:// (http is allowed only for a loopback test fixture)");
    }
  }
  if (url.username || url.password) {
    throw new Error("OIDC_JWKS_URL must not include user:pass@ credentials");
  }

  if (isLoopbackLiteral(host)) {
    if (loopbackAllowed) return; // fixture harness
    throw new Error("OIDC_JWKS_URL must not point at a loopback address");
  }

  // Resolve and reject any private / link-local / IMDS address.
  const addresses = isIP(host) ? [host] : await resolveOrThrow(host, opts);
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new Error(`OIDC_JWKS_URL resolves to a non-public address (${addr})`);
    }
  }
}

async function resolveOrThrow(host: string, opts: JwksUrlGuardOptions): Promise<string[]> {
  const resolve = opts.resolveHostname ?? defaultResolve;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new Error(`OIDC_JWKS_URL hostname could not be resolved (${host})`);
  }
  if (addrs.length === 0) {
    throw new Error(`OIDC_JWKS_URL hostname could not be resolved (${host})`);
  }
  return addrs;
}
