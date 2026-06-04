/**
 * Cognito JWT Verification
 *
 * Validates Cognito-issued JWTs via `@de-otio/vestibulum`'s
 * `createMultiPoolVerifier`. Trellis is single-pool, so the verifier is
 * configured with a one-element pool array — the idiomatic single-pool
 * shape. The underlying `aws-jwt-verify` JWKS cache lives inside the
 * vestibulum verifier (transitive dependency).
 *
 * The verifier is lazily constructed and recreated if older than 24
 * hours to refresh the pinned JWKS.
 */

import {
  createMultiPoolVerifier,
  MultiPoolVerifierError,
  type MultiPoolVerifier,
} from "@de-otio/vestibulum";

let verifier: MultiPoolVerifier | null = null;
let lastCreated = 0;
const VERIFIER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getVerifier(): MultiPoolVerifier {
  const now = Date.now();
  // S1.5 — Recreate verifier if older than 24 hours to refresh JWKS
  if (!verifier || now - lastCreated > VERIFIER_MAX_AGE_MS) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_APP_CLIENT_ID;
    if (!userPoolId || !clientId) {
      throw new Error("COGNITO_USER_POOL_ID and COGNITO_APP_CLIENT_ID must be set");
    }
    const region =
      process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    // Single-pool config: one PoolConfig is the correct, idiomatic shape
    // for a single-pool consumer. tokenUse "id" preserves the previous
    // CognitoJwtVerifier.create({ tokenUse: "id" }) contract.
    verifier = createMultiPoolVerifier([
      {
        poolKey: "default",
        userPoolId,
        clientId,
        region,
        tokenUse: "id",
      },
    ]);
    lastCreated = now;
  }
  return verifier;
}

/** Reset the verifier to force JWKS refresh on next call */
export function resetVerifier() {
  verifier = null;
  lastCreated = 0;
}

export interface CognitoJwtClaims {
  sub: string;        // Cognito user sub (UUID)
  username: string;
  email?: string;
  "custom:userId"?: string;
  /** Pre-T3 legacy claim — single global role. */
  "custom:role"?: string;
  /** T3+ global UserRole claim. */
  "custom:globalRole"?: string;
  "custom:activeTenantId"?: string;
  "custom:tenantSlug"?: string;
  "custom:tenantRole"?: string;
  "custom:handle"?: string;
  "custom:dataRegion"?: string;
}

/**
 * Narrow vestibulum's `Record<string, unknown>` claims onto the trellis
 * `CognitoJwtClaims` shape. The known fields (sub, username, email,
 * custom:*) are read explicitly; everything else is dropped.
 *
 * `sub` is always present on a verified Cognito token; `username` is
 * the Cognito `cognito:username` claim on ID tokens. We coerce missing
 * string claims to "" defensively rather than throwing — callers that
 * require a field already guard for it (e.g. auth-middleware checks
 * custom:userId / custom:activeTenantId).
 */
function narrowClaims(claims: Readonly<Record<string, unknown>>): CognitoJwtClaims {
  const asString = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;

  const result: CognitoJwtClaims = {
    sub: asString(claims.sub) ?? "",
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
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Verify a Cognito JWT and return its narrowed claims.
 *
 * Throws on any verification failure (expired, bad signature, wrong
 * client/issuer/token_use, malformed). This preserves the previous
 * throw-on-invalid contract that callers rely on (auth-middleware and
 * the session manager both treat a throw as "not authenticated").
 *
 * On a `MultiPoolVerifierError` (which can include JWKS-key-not-found
 * surfaced as invalid_signature), we reset the verifier to refresh the
 * JWKS and retry once — mirroring the previous S1.5 behaviour.
 */
export async function verifyCognitoJwt(token: string): Promise<CognitoJwtClaims> {
  try {
    const verified = await getVerifier().verify(token);
    return narrowClaims(verified.claims);
  } catch (err) {
    // S1.5 — On verification failure, reset verifier to refresh JWKS and retry once.
    if (err instanceof MultiPoolVerifierError) {
      resetVerifier();
      const verified = await getVerifier().verify(token);
      return narrowClaims(verified.claims);
    }
    throw err;
  }
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
