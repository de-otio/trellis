/**
 * JWT verification (WS-3.1).
 *
 * Verifies an OIDC-issued JWT via `@de-otio/vestibulum`'s generic
 * `createIssuerVerifier`, pinned to the issuer + audience resolved from config
 * (`auth-config.ts`). For an existing Cognito deployment the resolved issuer /
 * audience are byte-identical to the pool-pinned verifier this replaced, so
 * verification behavior is unchanged (proven by the behavior-comparison harness
 * in `test/unit/auth/behavior-comparison.test.ts`).
 *
 * The verifier is provider-neutral: it makes no Cognito assumption in the
 * crypto path. `sub` is treated as an **opaque string** end to end — no UUID or
 * format assumption is applied at any boundary.
 *
 * The file keeps the name `cognito-jwt.ts` (and a `verifyCognitoJwt` alias) to
 * avoid a wide import churn on a high-scrutiny auth path; the internals and the
 * primary export (`verifyJwt`) are provider-neutral.
 *
 * The verifier is lazily constructed and recreated if older than 24 hours to
 * proactively refresh the pinned JWKS (matching the prior S1.5 behavior). The
 * signature-failure reset+retry now lives **inside** the vestibulum verifier
 * ([SEC-2], narrowed to signature failures only).
 */

import {
  createIssuerVerifier,
  IssuerVerifierError,
  type IssuerVerifier,
} from "@de-otio/vestibulum";
import { resolveAuthConfig, type AuthConfigEnv } from "./auth-config.js";

let verifier: IssuerVerifier | null = null;
let lastCreated = 0;
const VERIFIER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function envForAuth(): AuthConfigEnv {
  return {
    // Provider-neutral names (manifest D8 — OIDC_* canonical).
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL,
    OIDC_APP_CLIENT_ID: process.env.OIDC_APP_CLIENT_ID,
    OIDC_JWKS_URL: process.env.OIDC_JWKS_URL,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    COGNITO_APP_CLIENT_ID: process.env.COGNITO_APP_CLIENT_ID,
    COGNITO_REGION: process.env.COGNITO_REGION,
    AWS_REGION: process.env.AWS_REGION,
  };
}

function getVerifier(): IssuerVerifier {
  const now = Date.now();
  if (!verifier || now - lastCreated > VERIFIER_MAX_AGE_MS) {
    const cfg = resolveAuthConfig(envForAuth());
    verifier = createIssuerVerifier({
      issuer: cfg.issuer,
      audience: cfg.audience,
      ...(cfg.jwksUri !== undefined ? { jwksUri: cfg.jwksUri } : {}),
      // Explicit — the confirmed shared CognitoJwtVerifier/JwtVerifier default.
      graceSeconds: 0,
      issuerKind: cfg.issuerKind,
      tokenUse: "id",
    });
    lastCreated = now;
  }
  return verifier;
}

/** Reset the verifier to force reconstruction (and JWKS refresh) on next call. */
export function resetVerifier(): void {
  verifier = null;
  lastCreated = 0;
}

/**
 * Provider-neutral verified claims. `sub` is opaque — no format assumption.
 * Optional fields default to `undefined` (never throw); the authorization
 * boundary in `auth-middleware.ts` remains the enforcement point for them
 * ([SEC-7]).
 */
export interface TrellisClaims {
  /** Opaque subject — the identity key. Never coerced ([SEC-8]). */
  sub: string;
  username: string;
  email?: string;
  /** was `custom:userId` — Trellis `User.id` (cuid). */
  userId?: string;
  /** was `custom:globalRole` / legacy `custom:role`. */
  globalRole?: string;
  /** was `custom:activeTenantId`. */
  activeTenantId?: string;
  /** was `custom:tenantSlug`. */
  tenantSlug?: string;
  /** was `custom:tenantRole`. */
  tenantRole?: string;
  /** was `custom:handle`. */
  handle?: string;
  /** was `custom:dataRegion`. */
  dataRegion?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Map a verified issuer's raw claims onto the neutral {@link TrellisClaims}.
 *
 * This is a **mapping layer, NOT an enforcement point** ([SEC-7]): it renames
 * claims; it never decides authorization. Optional fields coerce a missing
 * value to `undefined` (callers' guards remain the enforcement boundary).
 *
 * **[SEC-8] — `sub` is the one field that MUST NOT be coerced.** An empty `sub`
 * would collapse the claims-cache key `claims:{sub}` to the shared bucket
 * `claims:` — a collision every subless token would share. OIDC Core §2
 * mandates a non-empty `sub`, so a compliant issuer never trips this; a forged
 * or non-compliant token is rejected (thrown) rather than silently bucketed.
 *
 * @param issuerKind selects the provider claim-name mapping. In WS-3.1 only the
 *   Cognito mapping is populated; the Keycloak mapping lands with WS-3.3.
 */
export function normalizeClaims(
  issuerKind: "cognito" | "generic",
  raw: Readonly<Record<string, unknown>>,
): TrellisClaims {
  const sub = asString(raw.sub);
  if (sub === undefined || sub === "") {
    // Fail closed — never produce a claims:{} collision bucket.
    throw new IssuerVerifierError(
      "invalid_claim",
      "Token has no non-empty string sub claim; refusing to build an identity from it.",
    );
  }

  if (issuerKind === "cognito") {
    return {
      sub,
      username: asString(raw["cognito:username"]) ?? asString(raw.username) ?? "",
      ...pick("email", asString(raw.email)),
      ...pick("userId", asString(raw["custom:userId"])),
      ...pick("globalRole", asString(raw["custom:globalRole"]) ?? asString(raw["custom:role"])),
      ...pick("activeTenantId", asString(raw["custom:activeTenantId"])),
      ...pick("tenantSlug", asString(raw["custom:tenantSlug"])),
      ...pick("tenantRole", asString(raw["custom:tenantRole"])),
      ...pick("handle", asString(raw["custom:handle"])),
      ...pick("dataRegion", asString(raw["custom:dataRegion"])),
    };
  }

  // Generic OIDC (Keycloak/Zitadel) — WS-3.3 live wiring. G2 proved (C-10 /
  // E-3, live 2026-07-19) that Keycloak protocol mappers emit the LITERAL
  // `custom:*` claim names (the `:` passes through KC's token JSON unchanged),
  // so the generic mapping mirrors the Cognito table 1:1 for those claims;
  // only the username source differs (`preferred_username` vs
  // `cognito:username`). [SEC-7] this stays a mapping layer: no defaults are
  // injected here — an unmapped/missing role claim falls through to
  // auth-middleware's least-privilege defaults (END_USER / GUEST), never
  // higher.
  return {
    sub,
    username:
      asString(raw.preferred_username) ??
      asString(raw.username) ??
      asString(raw.email) ??
      "",
    ...pick("email", asString(raw.email)),
    ...pick("userId", asString(raw["custom:userId"])),
    ...pick("globalRole", asString(raw["custom:globalRole"]) ?? asString(raw["custom:role"])),
    ...pick("activeTenantId", asString(raw["custom:activeTenantId"])),
    ...pick("tenantSlug", asString(raw["custom:tenantSlug"])),
    ...pick("tenantRole", asString(raw["custom:tenantRole"])),
    ...pick("handle", asString(raw["custom:handle"])),
    ...pick("dataRegion", asString(raw["custom:dataRegion"])),
  };
}

function pick<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value !== undefined ? ({ [key]: value } as Record<K, string>) : {};
}

/**
 * Verify a JWT and return its neutral {@link TrellisClaims}.
 *
 * Throws on any verification failure (expired, bad signature, wrong
 * issuer/audience/token_use, disallowed alg, missing exp, missing sub,
 * malformed). Preserves the throw-on-invalid contract callers rely on
 * (auth-middleware maps a throw to `null`/401).
 */
export async function verifyJwt(token: string): Promise<TrellisClaims> {
  const cfg = resolveAuthConfig(envForAuth());
  const verified = await getVerifier().verify(token);
  return normalizeClaims(cfg.issuerKind, verified.claims);
}

/**
 * Back-compat alias for {@link verifyJwt}. The verifier is no longer
 * Cognito-specific; new code should call `verifyJwt`.
 */
export const verifyCognitoJwt = verifyJwt;

/**
 * Cognito-specific narrowed claim shape.
 *
 * @deprecated Kept ONLY for `session-cookie.ts`, whose cookie-session path
 * depends on the exact `narrowClaims` read semantics: it reads `custom:role`
 * specifically (not the folded `globalRole`) and relies on unknown claims like
 * `custom:ageTier` being **dropped** (so `ageTier` deterministically defaults).
 * Routing that path through the neutral {@link TrellisClaims} would silently
 * change those values. WS-3.3 migrates session-cookie onto `TrellisClaims`.
 */
export interface CognitoJwtClaims {
  sub: string;
  username: string;
  email?: string;
  "custom:userId"?: string;
  "custom:role"?: string;
  "custom:globalRole"?: string;
  "custom:activeTenantId"?: string;
  "custom:tenantSlug"?: string;
  "custom:tenantRole"?: string;
  "custom:handle"?: string;
  "custom:dataRegion"?: string;
}

function narrowClaims(claims: Readonly<Record<string, unknown>>): CognitoJwtClaims {
  const sub = asString(claims.sub);
  // [SEC-8] fail closed on a missing/empty sub even on the legacy path (a
  // compliant Cognito token always carries one, so this is byte-identical in
  // practice while closing the empty-sub hole).
  if (sub === undefined || sub === "") {
    throw new IssuerVerifierError(
      "invalid_claim",
      "Token has no non-empty string sub claim; refusing to build an identity from it.",
    );
  }
  const result: CognitoJwtClaims = {
    sub,
    username: asString(claims["cognito:username"]) ?? asString(claims.username) ?? "",
  };
  const optional: (keyof CognitoJwtClaims)[] = [
    "email",
    "custom:userId",
    "custom:role",
    "custom:globalRole",
    "custom:activeTenantId",
    "custom:tenantSlug",
    "custom:tenantRole",
    "custom:handle",
    "custom:dataRegion",
  ];
  for (const key of optional) {
    const value = asString(claims[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * @deprecated Verify a JWT and return the legacy Cognito-shaped claims. Used
 * only by `session-cookie.ts` (see {@link CognitoJwtClaims}). New code uses
 * {@link verifyJwt}.
 */
export async function verifyLegacyCognitoClaims(token: string): Promise<CognitoJwtClaims> {
  const verified = await getVerifier().verify(token);
  return narrowClaims(verified.claims);
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
