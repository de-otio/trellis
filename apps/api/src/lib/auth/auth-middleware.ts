/**
 * Auth Middleware
 *
 * Resolves an authenticated request's Cognito JWT into a typed AuthContext.
 * Returns null if the token is absent or invalid — callers treat null as 401.
 *
 * Requires COGNITO_USER_POOL_ID and COGNITO_APP_CLIENT_ID in env.
 */

import type { TenantRole, UserRole, TenantMember, Tenant } from "@prisma/client";
import type { Env } from "../../env.js";
import type { AuthContext } from "./auth-context.js";
import { extractBearerToken, verifyJwt } from "./cognito-jwt.js";
import { CUID_RE } from "./cuid.js";

/**
 * Extract and verify the Bearer token from the request, then assemble an
 * AuthContext from the JWT claims written by the pre-token-generation Lambda.
 *
 * Returns null when:
 * - No Authorization header is present.
 * - The token fails verification (expired, bad signature, wrong pool/client).
 * - Required claims are missing (userId, activeTenantId).
 */
export async function authMiddleware(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!token) return null;

  let claims;
  try {
    claims = await verifyJwt(token);
  } catch {
    return null;
  }

  const userId = claims.userId;
  const activeTenantId = claims.activeTenantId;

  // Both are non-negotiable — pre-token-gen Lambda always writes them.
  if (!userId || !activeTenantId) return null;

  // Reject malformed claim values: cuid v1 is c[a-z0-9]{24}. We accept up
  // to 40 chars to leave headroom for the slug-max widening done in T3.
  if (!CUID_RE.test(userId) || !CUID_RE.test(activeTenantId)) return null;

  // globalRole normalization already folds the T2-era "custom:role" into the
  // T3+ "custom:globalRole"; default to END_USER when neither was present.
  const globalRole = (claims.globalRole ?? "END_USER") as UserRole;
  // Default to GUEST (least privilege) when the tenantRole claim is missing,
  // so a malformed token never silently confers MEMBER capabilities.
  const tenantRole = (claims.tenantRole ?? "GUEST") as TenantRole;
  const tenantSlug = claims.tenantSlug ?? "";
  const handle = claims.handle ?? "";
  const sub = claims.sub;

  // Memberships are loaded lazily — most requests don't need the full list.
  let membershipsCache: (TenantMember & { tenant: Tenant })[] | null = null;

  const membershipsLoader = async (): Promise<(TenantMember & { tenant: Tenant })[]> => {
    if (membershipsCache) return membershipsCache;
    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);
    membershipsCache = await db.tenantMember.findMany({
      where: { userId, status: "ACTIVE" },
      include: { tenant: true },
    }) as (TenantMember & { tenant: Tenant })[];
    return membershipsCache;
  };

  return {
    sub,
    userId,
    globalRole,
    activeTenantId,
    tenantSlug,
    tenantRole,
    handle,
    membershipsLoader,
  };
}

/**
 * Extract and verify the active tenant id from a request's Bearer token,
 * returning the validated cuid or `null` (no/invalid token, missing/malformed
 * claim). Used by the tenant-context middleware (WS1, doc/14) to establish the
 * ambient tenant via `runWithTenantContext` — which propagates through the
 * whole downstream, unlike setting it from inside the per-handler
 * `authMiddleware` (whose `enterWith` would not survive the `await` back to the
 * caller).
 *
 * This re-verifies the JWT; it runs only when TENANT_SCOPE_MODE != "off", so
 * there is no cost on the default path. (A future optimization can verify once
 * and share the claims with `authMiddleware`.)
 */
export async function extractVerifiedTenantId(
  request: Request,
  _env: Env,
): Promise<string | null> {
  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!token) return null;

  let claims;
  try {
    claims = await verifyJwt(token);
  } catch {
    return null;
  }

  const activeTenantId = claims.activeTenantId;
  if (!activeTenantId || !CUID_RE.test(activeTenantId)) return null;
  return activeTenantId;
}

/**
 * Assert that the caller's active tenant matches the tenant referenced by
 * the path parameter.
 *
 * Returns a 403 Response when the tenants don't match (unless the caller
 * is a SUPER_ADMIN, who bypasses tenant scope by design).
 * Returns null when the check passes.
 *
 * Use this for ADMIN endpoints (POST/PATCH/DELETE on /api/tenants/:id/...
 * where the attacker already knows the ID and 403 is acceptable per
 * security-and-isolation §"Privilege boundary at the API").
 *
 * G4 MEDIUM-4: this helper deliberately returns 403 (not 404) when the
 * caller is authenticated but acting on a tenant other than their own.
 * That makes the response distinguishable from "tenant does not exist"
 * (which surfaces as 404). The federation onboarding flow depends on
 * that distinction — a caller scripting setup needs to be able to tell
 * whether their target id is unused vs out of reach. Data-side cross-
 * tenant reads should use `requireOwnTenant` (404 for both conditions)
 * instead.
 */
export function requireActiveTenant(
  auth: AuthContext,
  tenantIdFromPath: string,
): Response | null {
  if (auth.globalRole === "SUPER_ADMIN") return null;
  if (auth.activeTenantId === tenantIdFromPath) return null;
  return new Response(
    JSON.stringify({ error: "FORBIDDEN", message: "Active tenant does not match requested resource" }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

/**
 * Same as requireActiveTenant but returns 404 instead of 403, so the response
 * does not distinguish "tenant exists but you can't see it" from "tenant
 * does not exist". Use this for DATA endpoints (GET /api/tenants/:id and
 * any cross-tenant resource lookup) where existence-leak is the concern.
 */
export function requireOwnTenant(
  auth: AuthContext,
  tenantIdFromPath: string,
): Response | null {
  if (auth.globalRole === "SUPER_ADMIN") return null;
  if (auth.activeTenantId === tenantIdFromPath) return null;
  return new Response(
    JSON.stringify({ error: "NOT_FOUND", message: "Tenant not found" }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}
