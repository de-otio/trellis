/**
 * Claims derivation from the primary DB — the single source of truth for
 * "which tenant is the user's active one and what claims follow from it".
 *
 * Extracted verbatim from the Cognito pre-token-generation Lambda (WS-0,
 * plan 016) so the Lambda and the Keycloak JIT path (`jit-claims.ts`) share
 * one derivation instead of forking it. Selection order for the active
 * membership:
 *
 *   1. the caller's explicit preference (a prior switch-tenant call), when
 *      still an ACTIVE membership,
 *   2. an ORGANIZATION tenant when `preferOrgTenant` (federated identities),
 *   3. the user's personal tenant,
 *   4. any remaining ACTIVE membership.
 *
 * Suspension is REPORTED, not enforced — each caller applies its own policy
 * (the Lambda emits the drift sentinel; the JIT path returns 401).
 */

import type { PrismaClient, TenantRole } from "@prisma/client";

export interface DbClaimsLoad {
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

export async function loadClaimsFromDb(
  db: PrismaClient,
  sub: string,
  preferOrgTenant: boolean,
  preferredTenantId: string | null,
): Promise<DbClaimsLoad> {
  const user = await db.user.findUnique({
    where: { subject: sub },
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
