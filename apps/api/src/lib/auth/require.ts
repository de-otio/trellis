/**
 * Authorization helpers — role and capability gating.
 *
 * Layers:
 *  1. `requireRole`            — coarse role-rank check (legacy; T3 uses it).
 *  2. `requireCapability(cap)` — full capability matrix + resource scoping.
 *
 * SUPER_ADMIN bypasses every check (platform-wide override).
 */

import type { TenantRole, UserRole } from "@prisma/client";
import type { AuthContext } from "./auth-context.js";
import { Capability, type CapabilityValue } from "./capabilities.js";
import { RoleGrants } from "./role-grants.js";

export { Capability, type CapabilityValue } from "./capabilities.js";
export { RoleGrants } from "./role-grants.js";

const ROLE_RANK: Record<TenantRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  GUEST: 1,
};

function isSuperAdmin(auth: AuthContext): boolean {
  return auth.globalRole === ("SUPER_ADMIN" as UserRole);
}

function forbidden(message: string): Response {
  return new Response(
    JSON.stringify({ error: "FORBIDDEN", message }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

/**
 * Returns a 403 Response if the caller's tenant role is below `minRole`,
 * or null if the check passes. SUPER_ADMIN bypasses.
 */
export function requireRole(
  auth: AuthContext,
  minRole: TenantRole,
): Response | null {
  if (isSuperAdmin(auth)) return null;
  if (ROLE_RANK[auth.tenantRole] >= ROLE_RANK[minRole]) return null;
  return forbidden(`Requires tenant role ${minRole} or higher`);
}

/**
 * Resource carrier for capability-scoped checks.
 *
 * `authorId` and `ownerUserId` are the two ownership signals we recognise:
 *  - `authorId` for posts/comments
 *  - `ownerUserId` for entities (via EntityOwnership)
 *
 * Either one matching `auth.userId` is sufficient for own-only verbs.
 */
export interface CapabilityResource {
  authorId?: string | null;
  ownerUserId?: string | null;
}

export interface RequireCapabilityOptions {
  /** Resource being acted on; required for own-only capabilities. */
  resource?: CapabilityResource;
}

/**
 * Resource-scoped capabilities — own-only by default, granted to all if the
 * caller also holds the matching `*.moderate` capability.
 *
 * Per design (05-roles-and-permissions.md):
 *  - `post.update` / `post.delete`: own posts; `post.moderate` is the cross-user variant.
 *  - `entity.update` / `entity.delete`: own entities (via EntityOwnership);
 *    ADMIN/OWNER hold these unconditionally because they also hold `post.moderate`
 *    (cross-user takedown). MEMBER must own the entity.
 */
const OWN_ONLY_FALLBACK: Partial<Record<CapabilityValue, CapabilityValue>> = {
  [Capability.PostUpdate]: Capability.PostModerate,
  [Capability.PostDelete]: Capability.PostModerate,
  [Capability.EntityUpdate]: Capability.PostModerate,
  [Capability.EntityDelete]: Capability.PostModerate,
  // Events primitive (R1): own events for MEMBER; EventModerate (ADMIN+) is the
  // cross-user variant — same shape as the post/entity own-only verbs above.
  [Capability.EventUpdate]: Capability.EventModerate,
  [Capability.EventDelete]: Capability.EventModerate,
};

function isOwnedBy(
  resource: CapabilityResource | undefined,
  userId: string,
): boolean {
  if (!resource) return false;
  if (resource.authorId && resource.authorId === userId) return true;
  if (resource.ownerUserId && resource.ownerUserId === userId) return true;
  return false;
}

/**
 * Returns a 403 Response if the caller lacks `cap`, null on success.
 *
 * SUPER_ADMIN bypasses every check.
 *
 * For own-only capabilities (PostUpdate, PostDelete, EntityUpdate, EntityDelete):
 *   1. The role must hold the base capability.
 *   2. AND the resource must be owned by the caller, UNLESS the role also
 *      holds the matching cross-user moderation capability (PostModerate).
 *
 * If `options.resource` is omitted for an own-only capability, the check is
 * lenient (caps-only) — callers that load the resource must pass it through.
 */
export function requireCapability(
  auth: AuthContext,
  cap: CapabilityValue,
  options: RequireCapabilityOptions = {},
): Response | null {
  if (isSuperAdmin(auth)) return null;

  const grants = RoleGrants[auth.tenantRole];
  if (!grants.has(cap)) return forbidden(`Requires capability ${cap}`);

  const moderationCap = OWN_ONLY_FALLBACK[cap];
  if (!moderationCap) return null;

  if (grants.has(moderationCap)) return null;
  if (options.resource === undefined) return null;
  if (isOwnedBy(options.resource, auth.userId)) return null;

  return forbidden(`Requires ownership or ${moderationCap}`);
}
