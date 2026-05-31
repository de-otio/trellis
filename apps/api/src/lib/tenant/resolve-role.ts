/**
 * IdP-group → TenantRole resolution (T2 — JIT provisioning).
 *
 * Pure function over the user's IdP `groups` claim and the tenant's
 * `TenantRoleMapping` rows. The lambda fetches the mappings; this module
 * applies the priority + role-rank algorithm so unit tests don't need Prisma.
 *
 * Algorithm (per doc/02-technical/identity-federation/05-roles-and-permissions.md):
 *  - No `idpGroups`              → defaultRole
 *  - No mappings match           → defaultRole
 *  - Lowest `priority` wins      (priority 0 beats priority 100)
 *  - Tie on priority             → highest role rank wins
 *
 * Role rank: OWNER (4) > ADMIN (3) > MEMBER (2) > GUEST (1).
 */

import type { TenantRole } from "@prisma/client";

export interface RoleMappingInput {
  idpGroupName: string;
  tenantRole: TenantRole;
  priority: number;
}

const ROLE_RANK: Record<TenantRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  GUEST: 1,
};

/**
 * Resolve which TenantRole a federated user should be granted, given:
 *  - their IdP-emitted group identifiers
 *  - the tenant's configured role mappings
 *  - the tenant IdP's configured `defaultRole` (null = deny if no match)
 *
 * Returns null when no mapping matches and `defaultRole` is null — the
 * caller treats this as "do not provision an org TenantMember".
 *
 * **OWNER cap (G2 M3):** OWNER is the single-OWNER invariant for a tenant
 * and is only granted by tenant-creation flow + explicit transfer. A group
 * mapping or default-role configured to OWNER is downgraded to ADMIN here
 * as a defense-in-depth backstop. The role-mapping API (T5) must also
 * reject OWNER on write, but this resolver enforces the invariant on read
 * so a misconfigured row never escalates a federated user to OWNER.
 */
export function resolveTenantRole(
  idpGroups: ReadonlyArray<string>,
  mappings: ReadonlyArray<RoleMappingInput>,
  defaultRole: TenantRole | null,
): TenantRole | null {
  if (idpGroups.length === 0) return capOwner(defaultRole);

  const groupSet = new Set(idpGroups);
  const matches = mappings.filter((m) => groupSet.has(m.idpGroupName));
  if (matches.length === 0) return capOwner(defaultRole);

  const sorted = [...matches].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return ROLE_RANK[b.tenantRole] - ROLE_RANK[a.tenantRole];
  });

  return capOwner(sorted[0].tenantRole);
}

function capOwner(role: TenantRole | null): TenantRole | null {
  if (role === "OWNER") return "ADMIN";
  return role;
}
