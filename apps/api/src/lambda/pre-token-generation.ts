/**
 * Cognito PreTokenGeneration trigger (V2 access-token override).
 *
 * Runs on every token issuance and refresh. Responsibilities:
 *  1. Read the cached claims from DynamoDB.
 *  2. On miss: load from RDS (User + active TenantMember + Tenant slug).
 *  3. For federated users: re-resolve the tenant role from the current
 *     `custom:idpGroups` against `TenantRoleMapping`. This catches admin-side
 *     group changes within the access-token TTL.
 *  4. Write the (possibly refreshed) claims back to DDB.
 *  5. Override the access-token claims via the V2 response shape.
 *
 * Failure modes:
 *  - User row missing (drift after RDS restore): return minimal claims —
 *    the API responds 403 to tenant-scoped endpoints, never a 500 at sign-in.
 *  - DDB or RDS error: bubble up; Cognito treats the issuance as failed.
 *
 * No PII is logged. We log counts and decisions ("cache_hit", "drift",
 * "role_refreshed") and the opaque cognitoSub.
 */

import type {
  PreTokenGenerationV2TriggerEvent,
  PreTokenGenerationV2TriggerHandler,
} from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { PrismaClient, type TenantRole } from "@prisma/client";
import { getLambdaPrisma as getPrisma, withLambdaDbBreaker } from "../lib/lambda-prisma.js";
import {
  ClaimsCache,
  createClaimsCacheFromEnv,
  DEFAULT_CACHE_TTL_SECONDS,
  type CachedClaims,
} from "../lib/auth/claims-cache.js";
import { resolveTenantRole, type RoleMappingInput } from "../lib/tenant/resolve-role.js";

const logger = new Logger({ serviceName: "pre-token-generation" });
let cache: ClaimsCache | null = null;

function getCache(): ClaimsCache {
  if (!cache) cache = createClaimsCacheFromEnv();
  return cache;
}

const DRIFT_CLAIMS: CachedClaims = {
  userId: "",
  globalRole: "",
  activeTenantId: "",
  tenantSlug: "",
  tenantRole: "",
  handle: "",
};

function parseIdpGroups(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isFederatedEvent(event: PreTokenGenerationV2TriggerEvent): boolean {
  const identitiesRaw = event.request.userAttributes["identities"];
  if (!identitiesRaw) return false;
  try {
    const parsed = JSON.parse(identitiesRaw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

interface RdsClaimsLoad {
  user: {
    id: string;
    role: string;
    handle: string | null;
    suspended: boolean;
    suspendedAt: Date | null;
  } | null;
  activeMembership: {
    tenantId: string;
    role: TenantRole;
    tenant: { slug: string; status: string };
  } | null;
}

async function loadFromRds(
  db: PrismaClient,
  cognitoSub: string,
  preferOrgTenant: boolean,
  preferredTenantId: string | null,
): Promise<RdsClaimsLoad> {
  const user = await db.user.findUnique({
    where: { cognitoSub },
    select: {
      id: true,
      role: true,
      handle: true,
      suspended: true,
      suspendedAt: true,
      personalTenantId: true,
    },
  });
  if (!user) return { user: null, activeMembership: null };

  const memberships = await db.tenantMember.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    include: { tenant: { select: { id: true, slug: true, status: true, type: true } } },
  });

  // Honor an explicit user choice (from a prior switch-tenant call) above
  // any heuristic, provided the membership is still active.
  let active = preferredTenantId
    ? memberships.find(
        (m) => m.tenant.id === preferredTenantId && m.tenant.status === "ACTIVE",
      )
    : undefined;
  if (!active) {
    active = memberships.find(
      (m) =>
        preferOrgTenant && m.tenant.type === "ORGANIZATION" && m.tenant.status === "ACTIVE",
    );
  }
  if (!active) {
    active = memberships.find(
      (m) => m.tenant.id === user.personalTenantId && m.tenant.status === "ACTIVE",
    );
  }
  if (!active) {
    active = memberships.find((m) => m.tenant.status === "ACTIVE");
  }

  return {
    user: {
      id: user.id,
      role: user.role,
      handle: user.handle,
      suspended: user.suspended,
      suspendedAt: user.suspendedAt,
    },
    activeMembership: active
      ? {
          tenantId: active.tenantId,
          role: active.role,
          tenant: { slug: active.tenant.slug, status: active.tenant.status },
        }
      : null,
  };
}

async function maybeRefreshFederatedRole(
  db: PrismaClient,
  tenantId: string,
  idpGroups: string[],
  currentRole: string,
): Promise<TenantRole | null> {
  const mappings = await db.tenantRoleMapping.findMany({
    where: { tenantId },
    select: { idpGroupName: true, tenantRole: true, priority: true },
  });
  const idp = await db.tenantIdentityProvider.findUnique({
    where: { tenantId },
    select: { defaultRole: true, status: true },
  });
  if (!idp || idp.status !== "ACTIVE") return null;

  const resolved = resolveTenantRole(
    idpGroups,
    mappings as RoleMappingInput[],
    idp.defaultRole,
  );
  if (!resolved || resolved === currentRole) return null;
  return resolved;
}

export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  // Read the claims cache + RDS fallback by the immutable Cognito `sub` — the
  // same key PostConfirmation writes and the value carried in the token's `sub`
  // claim. `event.userName` is NOT stable across triggers (it can be the
  // sign-up username here vs the sub there), which caused every lookup to miss.
  const cognitoSub = event.request.userAttributes.sub;
  const claimsCache = getCache();
  const federated = isFederatedEvent(event);
  const idpGroups = parseIdpGroups(event.request.userAttributes["custom:idpGroups"]);

  // Cache hits skip the user-suspension and tenant-status checks below
  // (RDS is only consulted on miss). The mitigation is *active invalidation*:
  //   - User suspension paths MUST call `claimsCache.invalidate(cognitoSub)`.
  //   - TODO(T3): tenant-suspension API must invalidate caches for all members.
  // Without invalidation, suspended users keep valid claims for up to one
  // cache TTL (DEFAULT_CACHE_TTL_SECONDS = 3600s). Tracked as G2 finding H3.
  let claims = await claimsCache.get(cognitoSub);
  let cacheHit = !!claims;

  if (!claims) {
    // RDS is consulted only on a genuine cache miss. Emit a filterable event so
    // a miss-rate metric can be derived (a miss storm — post-deploy, correlated
    // TTL expiry, or the first-login wave after a signup burst — is the path
    // that can exhaust DB connections; the warm cache is the primary defence).
    logger.info("pretoken.cache_miss", { cognitoSub, federated });
    const db = await getPrisma();
    // Read the user's last explicit tenant preference, even from an expired
    // cache row, so an admin-side switch-tenant call survives cache TTL.
    let preferredTenantId: string | null = null;
    try {
      preferredTenantId = await claimsCache.getActiveTenantPreference(cognitoSub);
    } catch (err) {
      logger.warn("pretoken.preference_lookup_failed", {
        cognitoSub,
        error: (err as { code?: string })?.code ?? "unknown",
      });
    }
    const loaded = await withLambdaDbBreaker(
      () => loadFromRds(db, cognitoSub, federated, preferredTenantId),
      "pretoken.load_from_rds",
    );

    if (!loaded.user) {
      logger.warn("pretoken.drift", { cognitoSub });
      claims = { ...DRIFT_CLAIMS };
      writeTokenClaims(event, claims);
      return event;
    }

    // `suspended` is the authoritative flag set by user-deprovisioning + admin
    // dashboard; `suspendedAt` is the timestamp of the action (always a past
    // value when present). Treat either signal as suspension. Defense-in-depth:
    // even if a writer forgets one column, the other still blocks issuance.
    if (loaded.user.suspended || loaded.user.suspendedAt !== null) {
      logger.warn("pretoken.suspended", { cognitoSub });
      claims = { ...DRIFT_CLAIMS };
      writeTokenClaims(event, claims);
      return event;
    }

    claims = {
      userId: loaded.user.id,
      globalRole: loaded.user.role,
      activeTenantId: loaded.activeMembership?.tenantId ?? "",
      tenantSlug: loaded.activeMembership?.tenant.slug ?? "",
      tenantRole: loaded.activeMembership?.role ?? "",
      handle: loaded.user.handle ?? "",
    };
  }

  if (federated && claims.activeTenantId && idpGroups.length > 0) {
    try {
      const db = await getPrisma();
      const refreshed = await maybeRefreshFederatedRole(
        db,
        claims.activeTenantId,
        idpGroups,
        claims.tenantRole,
      );
      if (refreshed) {
        // Only emit the new role into the JWT after the DB persist succeeds.
        // Otherwise a transient DB error would oscillate the user's effective
        // role between cached-old and JWT-new on alternating refreshes (G2 H2).
        let persisted = false;
        try {
          await db.tenantMember.update({
            where: {
              tenantId_userId: { tenantId: claims.activeTenantId, userId: claims.userId },
            },
            data: { role: refreshed },
          });
          persisted = true;
        } catch (err) {
          logger.warn("pretoken.role_refresh_persist_failed", {
            cognitoSub,
            error: (err as { code?: string })?.code ?? "unknown",
          });
        }
        if (persisted) {
          claims = { ...claims, tenantRole: refreshed };
          cacheHit = false;
          logger.info("pretoken.role_refreshed", {
            cognitoSub,
            tenantId: claims.activeTenantId,
          });
        }
      }
    } catch (err) {
      logger.warn("pretoken.role_refresh_failed", {
        cognitoSub,
        error: (err as { code?: string }).code ?? "unknown",
      });
    }
  }

  if (!cacheHit && claims.userId) {
    await claimsCache.put(cognitoSub, claims, DEFAULT_CACHE_TTL_SECONDS);
  }

  writeTokenClaims(event, claims);
  return event;
};

function writeTokenClaims(
  event: PreTokenGenerationV2TriggerEvent,
  claims: CachedClaims,
): void {
  // Inject the tenant/identity claims into BOTH the ID and access tokens.
  // The API authenticates requests with the ID token (`Authorization: Bearer
  // <idToken>`), and `authMiddleware` reads `custom:activeTenantId` from it, so
  // the claims MUST be in the ID token — writing only `accessTokenGeneration`
  // left the ID token without them and 401'd every tenant-scoped request. The
  // access-token copy is kept for API-authorization clients that use it.
  const claimsToAddOrOverride = {
    "custom:userId": claims.userId,
    "custom:globalRole": claims.globalRole,
    "custom:activeTenantId": claims.activeTenantId,
    "custom:tenantSlug": claims.tenantSlug,
    "custom:tenantRole": claims.tenantRole,
    "custom:handle": claims.handle,
  };
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: { claimsToAddOrOverride },
      accessTokenGeneration: { claimsToAddOrOverride },
    },
  };
}
