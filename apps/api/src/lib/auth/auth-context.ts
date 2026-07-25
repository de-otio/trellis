/**
 * AuthContext — the resolved identity for one authenticated request.
 *
 * Built by authMiddleware from verified Cognito JWT claims. Every route
 * handler that needs auth information receives this rather than the raw
 * token payload.
 */

import type { TenantRole, UserRole, TenantMember, Tenant } from "@prisma/client";

/** The data carried from a verified JWT into each request. */
export interface AuthContext {
  /** Opaque IdP subject (`sub`). Stable identifier used for cache keys. */
  sub: string;
  /** Trellis `User.id` (cuid). */
  userId: string;
  /** Platform-wide role from `users.role`. */
  globalRole: UserRole;
  /** The tenant the user is currently acting as (`custom:activeTenantId`). */
  activeTenantId: string;
  /** Human-readable slug of the active tenant. */
  tenantSlug: string;
  /** Role within the active tenant. */
  tenantRole: TenantRole;
  /** ActivityPub-style handle. */
  handle: string;
  /**
   * Lazy loader for all of the user's tenant memberships.
   * Fetched at most once per request; stored on the context so callers
   * (e.g. tenant-switcher UI) don't duplicate the DB query.
   */
  membershipsLoader: () => Promise<(TenantMember & { tenant: Tenant })[]>;
}
